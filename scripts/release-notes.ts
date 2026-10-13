/**
 * Markdown release notes for a binary build: the commit subjects since the
 * previous build, grouped the way the Slack deploy announcement groups them
 * (src/deployAnnouncer.ts — subjects are written for mentors and teams).
 * Internal changes are folded away. Used by .github/workflows/release.yml.
 *
 *   bun scripts/release-notes.ts <previous-commit|""> <commit>
 */
import { categorize, readCommits, type ChangeCategory } from '../src/deployAnnouncer.js';

const [previous, current] = process.argv.slice(2);
if (!current) {
  console.error('usage: bun scripts/release-notes.ts <previous-commit|""> <commit>');
  process.exit(1);
}

const HEADINGS: Record<ChangeCategory, string> = {
  feature: "What's new",
  fix: 'Fixes',
  docs: 'Docs',
  internal: 'Internal',
};

const out: string[] = [];
if (!previous) {
  out.push('First build published as a single-file binary.');
} else {
  const commits = await readCommits(previous, current);
  const groups = new Map<ChangeCategory, string[]>();
  for (const c of commits) groups.set(categorize(c), [...(groups.get(categorize(c)) ?? []), c.subject]);
  for (const category of ['feature', 'fix', 'docs'] as const) {
    const subjects = groups.get(category);
    if (subjects?.length) out.push(`### ${HEADINGS[category]}`, '', ...subjects.map(s => `- ${s}`), '');
  }
  const internal = groups.get('internal');
  if (internal?.length) {
    out.push(
      `<details><summary>${internal.length} internal change${internal.length === 1 ? '' : 's'}</summary>`,
      '',
      ...internal.map(s => `- ${s}`),
      '',
      '</details>',
      '',
    );
  }
  if (commits.length === 0) out.push('No changes since the previous build.');
  out.push(`Changes: ${previous.slice(0, 7)}…${current.slice(0, 7)}`);
}
console.log(out.join('\n').trim());
