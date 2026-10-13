/**
 * Self-update for the single-file binary: find the newest published build
 * (.github/workflows/release.yml), download it, check it, and swap it in.
 *
 * A download is only installed when
 * - SHA256SUMS carries a valid signature from the release key compiled into
 *   this binary (src/releaseKey.ts), and
 * - the binary's sha256 matches its line in SHA256SUMS, and
 * - running it with --version prints the build it claims to be.
 *
 * Then the running binary becomes `<exe>.prev`, the new one takes its place,
 * and self-update.json records the update as pending until the new build
 * proves itself (src/updateRollback.ts). The caller restarts.
 *
 * Only the packaged binary updates itself; a checkout updates with
 * update.sh. PFMS_UPDATE_FEED and PFMS_UPDATE_PUBLIC_KEY point at another
 * feed and key — for tests.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { PFMS_REPO } from './buildInfo.js';
import { RELEASE_PUBLIC_KEY, verifyReleaseSignature } from './releaseKey.js';
import { readUpdateState, writeUpdateState } from './updateRollback.js';

const execFileAsync = promisify(execFile);

/** A published build this pFMS could update to. */
export interface AvailableBuild {
  tag: string;
  /** Short commit — compared with ours, and with what --version prints. */
  version: string;
  publishedAt: string;
  /** Release notes (markdown), for the admin page. */
  notes: string;
  /** The release on GitHub. */
  url: string;
  binaryUrl: string;
  binarySize: number;
  sumsUrl: string;
  sigUrl: string;
}

/** What GitHub's releases API returns (the fields used). */
export interface FeedRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  created_at: string;
  published_at?: string | null;
  body?: string | null;
  html_url?: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

/** The release asset for this machine, or null where there's no build. */
export function assetNameFor(platform = process.platform, arch = process.arch): string | null {
  return platform === 'linux' && (arch === 'x64' || arch === 'arm64') ? `pfms-linux-${arch}` : null;
}

export function feedUrl(): string {
  return process.env.PFMS_UPDATE_FEED ?? `https://api.github.com/repos/${PFMS_REPO}/releases?per_page=30`;
}

/**
 * The build to offer, given the feed: the newest complete `build-*` release
 * that's newer than ours. Ours is found by version in the list; a build not
 * in it (local, or pruned) is compared by date, so a developer's newer local
 * build isn't "updated" backwards.
 */
export function pickUpdate(
  releases: FeedRelease[],
  current: { version: string; builtAt?: string },
  assetName: string,
): AvailableBuild | null {
  const assetsOf = (r: FeedRelease) => {
    const url = (name: string) => r.assets.find(a => a.name === name);
    const binary = url(assetName);
    const sums = url('SHA256SUMS');
    const sig = url('SHA256SUMS.sig');
    return binary && sums && sig ? { binary, sums, sig } : null;
  };
  // Complete ones only: a release is created before its assets finish
  // uploading.
  const builds = releases
    .filter(r => r.tag_name.startsWith('build-') && !r.draft && !r.prerelease && assetsOf(r))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const newest = builds[0];
  if (!newest) return null;
  const version = versionOfTag(newest.tag_name);
  if (version === current.version) return null;
  const ours = builds.findIndex(r => versionOfTag(r.tag_name) === current.version);
  if (ours < 0 && current.builtAt && newest.created_at <= current.builtAt) return null;

  const { binary, sums, sig } = assetsOf(newest)!;
  return {
    tag: newest.tag_name,
    version,
    publishedAt: newest.published_at ?? newest.created_at,
    notes: newest.body ?? '',
    url: newest.html_url ?? '',
    binaryUrl: binary.browser_download_url,
    binarySize: binary.size,
    sumsUrl: sums.browser_download_url,
    sigUrl: sig.browser_download_url,
  };
}

/** `build-20261013-1442-abc1234` → `abc1234`. */
export function versionOfTag(tag: string): string {
  return tag.slice(tag.lastIndexOf('-') + 1);
}

export async function fetchUpdate(current: { version: string; builtAt?: string }): Promise<AvailableBuild | null> {
  const assetName = assetNameFor();
  if (!assetName) return null;
  const res = await fetch(feedUrl(), {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Release feed answered ${res.status}`);
  return pickUpdate((await res.json()) as FeedRelease[], current, assetName);
}

/**
 * The sha256 SHA256SUMS lists for `assetName`, after checking SHA256SUMS'
 * signature. Throws when the signature is bad or the asset isn't listed.
 */
export function trustedSha256(sums: string, signature: string, assetName: string, publicKey = releaseKey()): string {
  if (!verifyReleaseSignature(Buffer.from(sums), signature, publicKey)) {
    throw new Error('SHA256SUMS signature is not valid for this pFMS — refusing the download');
  }
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === assetName && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  throw new Error(`SHA256SUMS has no entry for ${assetName}`);
}

function releaseKey(): string {
  return process.env.PFMS_UPDATE_PUBLIC_KEY ?? RELEASE_PUBLIC_KEY;
}

export type InstallStage = 'verifying' | 'downloading' | 'testing' | 'installing';

/**
 * Download `build`, check it, and swap it in for `exe`. Afterwards `exe` is
 * the new build, `<exe>.prev` the old, and self-update.json has the update
 * pending. Nothing is replaced unless every check passes.
 */
export async function installBuild(
  build: AvailableBuild,
  opts: {
    exe: string;
    currentVersion: string;
    onProgress?: (stage: InstallStage, received?: number, total?: number) => void;
  },
): Promise<void> {
  const { exe } = opts;
  const assetName = assetNameFor();
  if (!assetName) throw new Error(`No pFMS build for ${process.platform}-${process.arch}`);
  const download = `${exe}.download`;
  const progress = opts.onProgress ?? (() => {});

  progress('verifying');
  const text = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.text();
  };
  const expected = trustedSha256(await text(build.sumsUrl), await text(build.sigUrl), assetName);

  progress('downloading', 0, build.binarySize);
  rmSync(download, { force: true });
  const res = await fetch(build.binaryUrl, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download answered ${res.status}`);
  const hash = createHash('sha256');
  const writer = Bun.file(download).writer();
  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      writer.write(chunk);
      received += chunk.byteLength;
      if (Date.now() - lastReport > 500) {
        lastReport = Date.now();
        progress('downloading', received, build.binarySize);
      }
    }
  } finally {
    await writer.end();
  }
  progress('downloading', received, build.binarySize);

  try {
    const actual = hash.digest('hex');
    if (actual !== expected) throw new Error(`Download doesn't match SHA256SUMS (got ${actual.slice(0, 12)}…)`);

    progress('testing');
    chmodSync(download, 0o755);
    const { stdout } = await execFileAsync(download, ['--version'], { timeout: 30_000 });
    const claims = stdout.trim().split(/\s+/)[0];
    if (claims !== build.version) throw new Error(`The download says it is ${claims}, not ${build.version}`);

    progress('installing');
    writeUpdateState({
      ...readUpdateState(),
      pending: { from: opts.currentVersion, to: build.version, attempts: 0, at: new Date().toISOString() },
    });
    rmSync(`${exe}.prev`, { force: true });
    renameSync(exe, `${exe}.prev`);
    try {
      renameSync(download, exe);
    } catch (err) {
      renameSync(`${exe}.prev`, exe); // put it back as it was
      throw err;
    }
  } catch (err) {
    if (existsSync(download)) rmSync(download, { force: true });
    const state = readUpdateState();
    if (state.pending?.to === build.version && !existsSync(`${exe}.prev`)) {
      writeUpdateState({ ...state, pending: undefined });
    }
    throw err;
  }
}
