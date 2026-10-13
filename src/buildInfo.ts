/**
 * Which pFMS this is. The packaged binary carries a build-info.json written
 * by scripts/build-binary.ts (read by src/binaryMain.ts); a git checkout asks
 * git. The short version must match the frontend's `__BUILD_VERSION__` (vite
 * uses the same `git rev-parse --short HEAD`), or every screen reloads.
 */
import { execFileSync } from 'node:child_process';

export interface BuildInfo {
  /** Full commit hash. */
  commit: string;
  /** Short commit hash — what /health and the screens compare. */
  version: string;
  /** When the binary was built (ISO), packaged builds only. */
  builtAt?: string;
  /** bun target the binary was built for, e.g. `bun-linux-x64`. */
  target?: string;
}

/** Where releases and source live — the updater's feed and the deploy
 *  announcer's fallback changelog. */
export const PFMS_REPO = 'TomSawyerLabs/practice-field-management-system';

let packaged: BuildInfo | undefined;
let fromGit: BuildInfo | null | undefined;

/** Called once by the packaged binary's entry point, before the app loads. */
export function setPackagedBuild(info: BuildInfo): void {
  packaged = info;
}

/** True when running as the single-file binary rather than a checkout. */
export function isPackagedBinary(): boolean {
  return packaged !== undefined;
}

/** What `--version` prints. The first word is the short commit — self-update
 *  smoke-runs a downloaded binary and checks it (src/selfUpdate.ts). */
export function versionLine(): string {
  const build = buildInfo();
  if (!build) return 'unknown (not a packaged build or a git checkout)';
  if (packaged) return `${build.version} ${build.commit} ${build.target} built ${build.builtAt}`;
  return `${build.version} ${build.commit} git checkout`;
}

/** This build, or null when neither the binary nor git can say. */
export function buildInfo(): BuildInfo | null {
  if (packaged) return packaged;
  if (fromGit === undefined) {
    try {
      const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();
      fromGit = { commit: git('rev-parse', 'HEAD'), version: git('rev-parse', '--short', 'HEAD') };
    } catch {
      fromGit = null; // not a checkout, or no git
    }
  }
  return fromGit;
}
