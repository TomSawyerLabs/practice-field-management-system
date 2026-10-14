/**
 * Software updates as the admin page and the auto-update policy see them:
 * what's installed, the newest published build, and installing it
 * (src/selfUpdate.ts does the downloading and checking).
 *
 * - Checks the release feed hourly unless the policy is `off` (then only
 *   when an admin presses Check), and once shortly after startup.
 * - Installs when an admin presses Update, or on its own per the policy
 *   (`SetupSettings.autoUpdate`): `window` inside the daily window, `idle`
 *   any time — both only once the field has been idle (no match set up,
 *   running or just over) for `idleMinutes`. Never a build that already
 *   failed here (src/updateRollback.ts).
 * - Never installs while the field is in use, whoever asks.
 *
 * Only the packaged binary installs anything; a checkout reports what's
 * available and points at update.sh.
 */
import { buildInfo, isPackagedBinary } from './buildInfo.js';
import { assetNameFor, fetchUpdate, installBuild, type AvailableBuild } from './selfUpdate.js';
import { readUpdateState } from './updateRollback.js';
import type { AutoUpdatePolicy, SelfUpdateStatus } from './types.js';

const CHECK_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_AFTER_MS = 60_000;
const TICK_MS = 60_000;
export const DEFAULT_WINDOW = { start: '03:00', end: '05:00' };
export const DEFAULT_IDLE_MINUTES = 30;

/** Minutes since midnight for `HH:MM`. */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Whether local time `now` is inside [start, end), which may cross midnight. */
export function inWindow(now: Date, start: string, end: string): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const s = minutesOf(start);
  const e = minutesOf(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

/** Whether the policy says to install `available` now. */
export function autoInstallDue(
  policy: AutoUpdatePolicy | undefined,
  now: Date,
  fieldIdleForMs: number | null,
  available: { version: string } | null,
  skip: string[],
): boolean {
  if (!policy || !available || skip.includes(available.version)) return false;
  if (policy.mode !== 'window' && policy.mode !== 'idle') return false;
  const idleNeeded = (policy.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  if (fieldIdleForMs === null || fieldIdleForMs < idleNeeded) return false;
  if (policy.mode === 'window') {
    return inWindow(now, policy.windowStart ?? DEFAULT_WINDOW.start, policy.windowEnd ?? DEFAULT_WINDOW.end);
  }
  return true;
}

export class UpdateManager {
  private latest: AvailableBuild | null = null;
  private checkedAt?: string;
  private checkError?: string;
  private activity: SelfUpdateStatus['activity'] = { stage: 'idle' };
  private lastError?: SelfUpdateStatus['lastError'];
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastCheckStarted = 0;
  /** The check under way, which callers share and an install waits for. */
  private checking: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      policy: () => AutoUpdatePolicy | undefined;
      /** How long the field has been idle, or null while it's in use. */
      fieldIdleForMs: () => number | null;
      broadcast: (status: SelfUpdateStatus) => void;
      /** Restart into the newly installed binary at `exe`. */
      restart: (exe: string) => void;
      supervised: boolean;
      exe?: string;
    },
  ) {}

  private get install(): SelfUpdateStatus['install'] {
    if (!isPackagedBinary()) return 'checkout';
    return assetNameFor() ? 'binary' : 'unsupported';
  }

  start(): void {
    const first = setTimeout(() => void this.check().catch(() => {}), FIRST_CHECK_AFTER_MS);
    this.timers.push(
      first as unknown as ReturnType<typeof setInterval>,
      setInterval(() => void this.tick(), TICK_MS),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Hourly checks unless the policy is off; installs when one is due. */
  private async tick(): Promise<void> {
    const policy = this.opts.policy();
    const mode = policy?.mode ?? 'off';
    if (mode !== 'off' && Date.now() - this.lastCheckStarted >= CHECK_EVERY_MS) {
      await this.check().catch(() => {});
    }
    const skip = readUpdateState().skip ?? [];
    if (
      this.install === 'binary' &&
      autoInstallDue(policy, new Date(), this.opts.fieldIdleForMs(), this.latest, skip)
    ) {
      console.log(`Auto-update (${mode}): installing ${this.latest!.version}`);
      await this.apply('automatic').catch(() => {});
    }
  }

  status(): SelfUpdateStatus {
    const build = buildInfo();
    const state = readUpdateState();
    const latest = this.latest;
    return {
      type: 'selfUpdate',
      install: this.install,
      current: { version: build?.version ?? 'unknown', builtAt: build?.builtAt },
      supervised: this.opts.supervised,
      latest: latest
        ? {
            tag: latest.tag,
            version: latest.version,
            publishedAt: latest.publishedAt,
            notes: latest.notes,
            url: latest.url,
          }
        : null,
      latestSkipped: !!latest && (state.skip ?? []).includes(latest.version),
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      activity: this.activity,
      lastError: this.lastError,
      lastUpdate: state.lastUpdate,
      reverted: state.reverted,
      autoNote: this.autoNote(),
    };
  }

  private autoNote(): string | undefined {
    const policy = this.opts.policy();
    if (!this.latest || this.install !== 'binary' || !policy) return undefined;
    const idle = policy.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    if (policy.mode === 'window') {
      const start = policy.windowStart ?? DEFAULT_WINDOW.start;
      const end = policy.windowEnd ?? DEFAULT_WINDOW.end;
      return `Installs between ${start} and ${end} once the field has been idle for ${idle} min`;
    }
    if (policy.mode === 'idle') return `Installs once the field has been idle for ${idle} min`;
    return undefined;
  }

  private publish(): void {
    this.opts.broadcast(this.status());
  }

  /** Look for a newer build. A check already under way is joined. */
  check(): Promise<void> {
    if (this.checking) return this.checking;
    if (this.activity.stage !== 'idle') return Promise.resolve();
    const build = buildInfo();
    if (!build) return Promise.resolve();
    this.lastCheckStarted = Date.now();
    this.activity = { stage: 'checking' };
    this.publish();
    this.checking = (async () => {
      try {
        this.latest = await fetchUpdate({ version: build.version, builtAt: build.builtAt });
        this.checkError = undefined;
      } catch (err) {
        this.checkError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.checking = null;
        this.checkedAt = new Date().toISOString();
        this.activity = { stage: 'idle' };
        this.publish();
      }
    })();
    return this.checking;
  }

  /** Why an install can't start now, or null. */
  refusal(): string | null {
    if (this.install === 'checkout') return 'This pFMS runs from a git checkout — update it with ./update.sh';
    if (this.install === 'unsupported') return `No pFMS builds are published for ${process.platform}-${process.arch}`;
    // A check under way is fine: the install waits for it (an hourly check
    // can be running when an admin presses Update).
    if (this.activity.stage !== 'idle' && this.activity.stage !== 'checking') return 'An update is already in progress';
    if (!this.latest && !this.checking) return 'No newer build to install';
    if (this.opts.fieldIdleForMs() === null) return 'The field is in use — install once no match is set up or running';
    return null;
  }

  /** Install the newest build and restart into it. */
  async apply(who: string): Promise<void> {
    if (this.checking) await this.checking.catch(() => {});
    const refused = this.refusal();
    if (refused) throw new Error(refused);
    const build = this.latest!;
    const exe = this.opts.exe ?? process.execPath;
    console.log(`Installing pFMS ${build.version} (${build.tag}), requested by ${who}`);
    try {
      await installBuild(build, {
        exe,
        currentVersion: buildInfo()?.version ?? 'unknown',
        onProgress: (stage, received, total) => {
          this.activity = stage === 'downloading' ? { stage, received: received ?? 0, total: total ?? 0 } : { stage };
          this.publish();
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Update to ${build.version} failed: ${message}`);
      this.lastError = { at: new Date().toISOString(), message };
      this.activity = { stage: 'idle' };
      this.publish();
      throw err;
    }
    // Last-moment guard: a match may have been set up during the download.
    if (this.opts.fieldIdleForMs() === null) {
      console.log(`Update to ${build.version} installed; restarting once the field is free`);
    }
    this.activity = { stage: 'restarting' };
    this.publish();
    console.log(`Restarting into pFMS ${build.version}`);
    this.waitThenRestart(exe);
  }

  /** Restart as soon as the field isn't in use (normally immediately). */
  private waitThenRestart(exe: string): void {
    if (this.opts.fieldIdleForMs() !== null) {
      setTimeout(() => this.opts.restart(exe), 1000); // let the status reach the pages
      return;
    }
    const t = setInterval(() => {
      if (this.opts.fieldIdleForMs() === null) return;
      clearInterval(t);
      this.opts.restart(exe);
    }, 5_000);
  }
}
