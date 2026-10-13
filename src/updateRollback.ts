/**
 * Putting the previous binary back when a self-update doesn't come up.
 *
 * Self-update (src/selfUpdate.ts) keeps the old binary as `<exe>.prev` and
 * records `pending: { from, to }` in self-update.json before restarting into
 * the new one. src/binaryMain.ts then, before the app loads:
 *
 * - counts the start. A build that keeps crashing — systemd restarting it
 *   each time — is reverted on its 4th start, before it gets to run again;
 * - watches /health. Up and answering for a minute → the update is
 *   confirmed. Not answering two minutes in → reverted.
 *
 * Reverting swaps `<exe>.prev` back in, remembers the bad build so automatic
 * updates skip it, and restarts. The admin page and the deploy announcement
 * say what happened.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export const SELF_UPDATE_STATE_FILE = process.env.SELF_UPDATE_STATE_FILE ?? 'self-update.json';

/** Starts allowed before a crash-looping new build is reverted. */
export const MAX_START_ATTEMPTS = 3;
/** Up this long and answering /health = the update worked. */
export const HEALTHY_AFTER_MS = 60_000;
/** Not answering /health by then = revert. */
export const HEALTH_DEADLINE_MS = 120_000;

export interface SelfUpdateState {
  /** An installed update not yet confirmed working. */
  pending?: { from: string; to: string; attempts: number; at: string };
  /** The last update that came up and stayed up. */
  lastUpdate?: { from: string; to: string; at: string };
  /** The last update that was rolled back: `to` is the build that failed. */
  reverted?: { from: string; to: string; at: string; reason: string };
  /** Builds that failed here; automatic updates won't try them again. */
  skip?: string[];
}

export function readUpdateState(file = SELF_UPDATE_STATE_FILE): SelfUpdateState {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SelfUpdateState;
  } catch {
    return {};
  }
}

export function writeUpdateState(state: SelfUpdateState, file = SELF_UPDATE_STATE_FILE): void {
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** What a start of build `version` does with the recorded state. */
export function startupDecision(
  state: SelfUpdateState,
  version: string,
  now = new Date(),
): { state: SelfUpdateState; revert: boolean; watch: boolean } {
  const pending = state.pending;
  if (!pending) return { state, revert: false, watch: false };
  if (pending.to !== version) {
    // Not the build we installed (someone put another binary in place, or
    // this is the old one after a revert) — nothing left to watch.
    return { state: { ...state, pending: undefined }, revert: false, watch: false };
  }
  const attempts = pending.attempts + 1;
  if (attempts > MAX_START_ATTEMPTS) {
    return {
      state: revertedState(state, `it stopped ${MAX_START_ATTEMPTS} times while starting`, now),
      revert: true,
      watch: false,
    };
  }
  return { state: { ...state, pending: { ...pending, attempts } }, revert: false, watch: true };
}

/** The state after rolling back the pending update. */
export function revertedState(state: SelfUpdateState, reason: string, now = new Date()): SelfUpdateState {
  const pending = state.pending;
  if (!pending) return state;
  return {
    ...state,
    pending: undefined,
    reverted: { from: pending.from, to: pending.to, at: now.toISOString(), reason },
    skip: [...new Set([...(state.skip ?? []), pending.to])],
  };
}

/** The state after the pending update proved itself. */
export function confirmedState(state: SelfUpdateState, now = new Date()): SelfUpdateState {
  const pending = state.pending;
  if (!pending) return state;
  return {
    ...state,
    pending: undefined,
    lastUpdate: { from: pending.from, to: pending.to, at: now.toISOString() },
    reverted: undefined,
  };
}

/** Swap `<exe>.prev` back in. The failed binary is kept as `<exe>.failed`
 *  for a look later. False when there's no previous binary to go back to. */
export function restorePreviousBinary(exe: string): boolean {
  const prev = `${exe}.prev`;
  if (!existsSync(prev)) return false;
  rmSync(`${exe}.failed`, { force: true });
  renameSync(exe, `${exe}.failed`);
  renameSync(prev, exe);
  return true;
}

/**
 * After the start is counted: confirm the update once /health has answered
 * with this build's version for a minute, or revert if it hasn't by the
 * deadline. `revert` does the swap and restart.
 */
export function watchNewBuild(opts: {
  version: string;
  port: number;
  stateFile?: string;
  revert: (reason: string) => void;
}): void {
  const started = Date.now();
  const timer = setInterval(async () => {
    const elapsed = Date.now() - started;
    if (elapsed < HEALTHY_AFTER_MS) return;
    let healthy = false;
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/health`, { signal: AbortSignal.timeout(3000) });
      healthy = res.ok && ((await res.json()) as { version?: string }).version === opts.version;
    } catch {
      // not answering yet
    }
    const state = readUpdateState(opts.stateFile);
    if (state.pending?.to !== opts.version) {
      clearInterval(timer); // resolved elsewhere
    } else if (healthy) {
      clearInterval(timer);
      writeUpdateState(confirmedState(state), opts.stateFile);
      console.log(`Self-update to ${opts.version} confirmed: up and answering for a minute`);
    } else if (elapsed >= HEALTH_DEADLINE_MS) {
      clearInterval(timer);
      opts.revert(`it wasn't answering ${HEALTH_DEADLINE_MS / 60_000} minutes after starting`);
    }
  }, 5_000);
  timer.unref?.();
}
