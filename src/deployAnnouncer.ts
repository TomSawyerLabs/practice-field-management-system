import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const execFile = promisify(execFileCb);

const StateFile = process.env.DEPLOY_ANNOUNCE_FILE ?? 'deploy-announced.json';
const MAX_LISTED_CHANGES = 15;
const POST_RETRY_INTERVAL_MS = 10_000;
const POST_MAX_RETRIES = 18; // keep trying ~3 minutes while Slack connects after startup

/**
 * What kind of change a commit is, for grouping the announcement.
 *
 * - `feature` — something a pFMS user will notice: new or changed behavior.
 * - `fix` — something that was broken and now isn't.
 * - `docs` — documentation only.
 * - `internal` — plans, tests, formatting, tooling. Only announced when a
 *   deploy has nothing else in it.
 */
export type ChangeCategory = 'feature' | 'fix' | 'docs' | 'internal';

export interface DeployCommit {
  subject: string;
  /** Value of a `Changelog:` trailer in the commit body, if any. */
  trailer?: string;
  files: string[];
}

const CATEGORIES: readonly ChangeCategory[] = ['feature', 'fix', 'docs', 'internal'];

const HEADINGS: Record<ChangeCategory, string> = {
  feature: "*What's new*",
  fix: '*Fixes*',
  docs: '*Docs*',
  internal: '*Behind the scenes*',
};

const OVERFLOW_LABELS: Record<ChangeCategory, (n: number) => string> = {
  feature: () => 'new',
  fix: n => (n === 1 ? 'fix' : 'fixes'),
  docs: n => (n === 1 ? 'doc update' : 'doc updates'),
  internal: () => 'behind the scenes',
};

const isPlan = (f: string) => f.startsWith('plans/');
const isDoc = (f: string) => f.startsWith('docs/') || /\.md$/i.test(f);
const isInternalFile = (f: string) =>
  isPlan(f) ||
  /\.test\.tsx?$/.test(f) ||
  f === 'CLAUDE.md' ||
  f.startsWith('.github/') ||
  f.startsWith('.claude/') ||
  /^(lefthook\.yml|\.prettierrc.*|\.prettierignore|\.gitattributes|\.gitignore)$/.test(f);

// Commit subjects here are user-facing prose ("…no longer dive to 0",
// "…actually records again"), so a fix usually says so.
const FIX_WORDS = /\b(fix(es|ed)?|no longer|actually|broken|bug|crash(es|ed)?|regression)\b/i;

/**
 * Decide a commit's category. An explicit `Changelog:` trailer always wins;
 * otherwise it's inferred from the files touched and the subject wording.
 */
export function categorize(commit: DeployCommit): ChangeCategory {
  const tagged = commit.trailer?.trim().toLowerCase();
  if (tagged && (CATEGORIES as readonly string[]).includes(tagged)) return tagged as ChangeCategory;

  if (/^plans?:/i.test(commit.subject)) return 'internal';
  const files = commit.files;
  if (files.length > 0) {
    if (files.every(isInternalFile)) return 'internal';
    // Docs plus plan notes, but no code.
    if (files.every(f => isDoc(f) || isInternalFile(f))) return 'docs';
  }
  return FIX_WORDS.test(commit.subject) ? 'fix' : 'feature';
}

/**
 * Build the Slack message: user-visible changes first, then fixes, then docs.
 * Internal changes are left out unless they are all this deploy contains.
 */
export function formatAnnouncement(commits: DeployCommit[], last: string, current: string): string {
  const short = (hash: string) => hash.slice(0, 7);
  const range = `\`${short(last)}\` → \`${short(current)}\``;
  if (commits.length === 0) {
    return `:rocket: *pFMS updated* to \`${short(current)}\` (was \`${short(last)}\`).`;
  }

  const groups = new Map<ChangeCategory, string[]>(CATEGORIES.map(c => [c, []]));
  for (const commit of commits) groups.get(categorize(commit))!.push(commit.subject);

  const userFacing = CATEGORIES.filter(c => c !== 'internal');
  const shown = userFacing.some(c => groups.get(c)!.length > 0) ? userFacing : (['internal'] as const);

  const lines: string[] = [];
  const hidden: string[] = [];
  let listed = 0;
  let total = 0;
  for (const category of shown) {
    const subjects = groups.get(category)!;
    total += subjects.length;
    if (subjects.length === 0) continue;
    const room = Math.max(0, MAX_LISTED_CHANGES - listed);
    if (room > 0) {
      lines.push('', HEADINGS[category]);
      for (const s of subjects.slice(0, room)) lines.push(`• ${s}`);
      listed += Math.min(room, subjects.length);
    }
    const cut = subjects.length - room;
    if (cut > 0) hidden.push(`${cut} ${OVERFLOW_LABELS[category](cut)}`);
  }
  // Say what kind of changes were cut, so a long list of new features can't
  // silently hide that fixes shipped too.
  if (total > listed) lines.push('', `…and ${total - listed} more (${hidden.join(', ')})`);

  const plural = total === 1 ? 'change' : 'changes';
  return [`:rocket: *pFMS updated* — ${total} ${plural} (${range})`, ...lines].join('\n');
}

// Field and record separators that won't appear in subjects or paths.
const FS = '\x1f';
const RS = '\x1e';

async function readCommits(last: string, current: string): Promise<DeployCommit[]> {
  const { stdout } = await execFile(
    'git',
    [
      'log',
      '--name-only',
      `--format=${RS}%s${FS}%(trailers:key=Changelog,valueonly,separator=%x2C)${FS}`,
      `${last}..${current}`,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout
    .split(RS)
    .filter(Boolean)
    .map(record => {
      const [subject, trailer, fileBlock = ''] = record.split(FS);
      return {
        subject: subject.trim(),
        trailer: trailer.trim().split(',')[0] || undefined,
        files: fileBlock
          .split('\n')
          .map(f => f.trim())
          .filter(Boolean),
      };
    })
    .reverse(); // oldest first — reads like a story
}

function readLastAnnounced(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(StateFile, 'utf-8')) as { lastAnnounced?: unknown };
    return typeof parsed.lastAnnounced === 'string' ? parsed.lastAnnounced : null;
  } catch {
    return null;
  }
}

/**
 * On startup, post a change summary to the support Slack channel when the
 * running version differs from the last announced one. The changelog is the
 * commit subjects between the two versions, grouped by category (see
 * categorize) — commit subjects in this repo are written for the
 * support-channel audience (see CLAUDE.md).
 *
 * The announced version is only persisted after a successful post, so if
 * Slack is down the announcement retries on the next restart. Plain service
 * restarts without a version change post nothing.
 */
export async function announceDeploy(post: (text: string) => Promise<boolean>): Promise<void> {
  let current: string;
  try {
    current = (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim();
  } catch {
    return; // not running from a git checkout — nothing to announce
  }
  if (!current) return;

  const last = readLastAnnounced();
  if (last === current) return;
  if (!last) {
    // First run with announcements enabled — record the baseline quietly.
    writeFileSync(StateFile, JSON.stringify({ lastAnnounced: current }, null, 2));
    return;
  }

  let commits: DeployCommit[] = [];
  try {
    commits = await readCommits(last, current);
  } catch {
    // Previous commit unknown locally (e.g. history rewrite) — announce without a list.
  }

  const text = formatAnnouncement(commits, last, current);
  const short = (hash: string) => hash.slice(0, 7);

  for (let attempt = 0; attempt < POST_MAX_RETRIES; attempt++) {
    if (await post(text)) {
      writeFileSync(StateFile, JSON.stringify({ lastAnnounced: current }, null, 2));
      console.log(`Deploy announcement posted (${commits.length} change(s), ${short(last)} → ${short(current)})`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, POST_RETRY_INTERVAL_MS));
  }
  console.warn('Deploy announcement not posted (Slack unavailable) — will retry on next restart');
}
