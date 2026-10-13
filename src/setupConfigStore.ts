/**
 * Persisted setup-wizard state: what the operator has answered, and how far
 * they got.
 *
 * Two jobs:
 *
 * 1. **Durable settings from the web UI.** Everything pFMS needs used to live
 *    in `/etc/pfms/environment`, which means editing a file as root and
 *    restarting. Settings written here survive restarts without that.
 * 2. **Resumability.** Setup is not one sitting — you get three steps in,
 *    discover the switch is wrong, and come back later. Each step records its
 *    own status, so restarting drops you at the first unfinished step with
 *    your earlier answers still filled in.
 *
 * Precedence: a value set here WINS over the matching environment variable.
 * Env stays the seed for a fresh install and still owns everything the wizard
 * doesn't manage, so an existing deployment behaves identically until someone
 * actually uses the wizard. `resolveSetting()` reports which source won so the
 * UI can say where a value came from.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import type { SetupStepId, SetupStepProgress, SetupConfig, SetupSettings } from './types.js';
import { SetupStepOrder } from './types.js';

const DEFAULT_FILE = 'setup-config.json';

const emptyConfig = (): SetupConfig => ({ version: 1, steps: {}, settings: {} });

export type SetupConfigListener = (config: SetupConfig) => void;

export class SetupConfigStore {
  private readonly file: string;
  private config: SetupConfig = emptyConfig();
  private listeners: SetupConfigListener[] = [];

  constructor(file = process.env.SETUP_CONFIG_FILE ?? DEFAULT_FILE) {
    this.file = file;
    this.load();
  }

  get(): SetupConfig {
    return this.config;
  }

  /** The first step that is neither done nor deliberately skipped. */
  nextStep(): SetupStepId | null {
    for (const id of SetupStepOrder) {
      const step = this.config.steps[id];
      if (step?.status !== 'done' && step?.status !== 'skipped') return id;
    }
    return null;
  }

  isComplete(): boolean {
    return this.nextStep() === null;
  }

  /**
   * Mark every step whose checks all pass as done, unless it is already
   * done or deliberately skipped. Steps that need a person to confirm
   * something (heard the sound, saw the TV) only pass once confirmed, so
   * nothing is waved through. Returns whether anything changed.
   */
  markPassingStepsDone(steps: { id: SetupStepId; status: string }[]): boolean {
    let changed = false;
    for (const step of steps) {
      const progress = this.config.steps[step.id]?.status;
      if (step.status !== 'pass' || progress === 'done' || progress === 'skipped') continue;
      this.config.steps[step.id] = { status: 'done', at: Date.now() };
      changed = true;
    }
    if (!changed) return false;
    this.config.completedAt = this.isComplete() ? Date.now() : undefined;
    this.persist();
    return true;
  }

  markStep(id: SetupStepId, status: SetupStepProgress['status']): SetupConfig {
    this.config.steps[id] = { status, at: Date.now() };
    // Re-opening any step re-opens the wizard as a whole.
    this.config.completedAt = this.isComplete() ? Date.now() : undefined;
    this.persist();
    return this.config;
  }

  /** Merge settings; `undefined` values clear a key rather than being ignored. */
  updateSettings(patch: Partial<SetupSettings>): SetupConfig {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (this.config.settings as Record<string, unknown>)[key];
      else (this.config.settings as Record<string, unknown>)[key] = value;
    }
    this.persist();
    return this.config;
  }

  /**
   * Resolve one setting against its environment fallback, reporting the source
   * so the UI can show "set here" vs "from /etc/pfms/environment".
   */
  resolveSetting<K extends keyof SetupSettings>(
    key: K,
    envVar: string,
    parse: (raw: string) => SetupSettings[K] | undefined = raw => raw as SetupSettings[K],
  ): { value: SetupSettings[K] | undefined; source: 'setup' | 'env' | 'default' } {
    const stored = this.config.settings[key];
    if (stored !== undefined) return { value: stored, source: 'setup' };

    const raw = process.env[envVar];
    if (raw !== undefined && raw !== '') {
      const parsed = parse(raw);
      if (parsed !== undefined) return { value: parsed, source: 'env' };
    }

    return { value: undefined, source: 'default' };
  }

  addListener(fn: SetupConfigListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.config);
      } catch (err) {
        console.error('Setup config listener failed:', err);
      }
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');

      const candidate = parsed as Partial<SetupConfig>;
      this.config = {
        version: 1,
        steps: candidate.steps ?? {},
        settings: candidate.settings ?? {},
        completedAt: candidate.completedAt,
      };
      console.log(`Setup config loaded from ${this.file} (next step: ${this.nextStep() ?? 'complete'})`);
    } catch (err) {
      // A corrupt file must not stop the field from starting — the wizard just
      // starts over, and the bad file is left alone for inspection.
      console.error(`Setup config at ${this.file} is unreadable, ignoring it:`, err);
      this.config = emptyConfig();
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.config, null, 2));
    } catch (err) {
      console.error(`Could not write setup config to ${this.file}:`, err);
    }
    this.notify();
  }
}

/**
 * Delete the persisted setup config. Returns the path if something was
 * removed. Used by `--clear-config`; deliberately not reachable from the web
 * UI, since it's a "start over" action for a human at a terminal.
 */
export function clearSetupConfig(file = process.env.SETUP_CONFIG_FILE ?? DEFAULT_FILE): string | null {
  if (!existsSync(file)) return null;
  unlinkSync(file);
  return file;
}

export { DEFAULT_FILE as SETUP_CONFIG_DEFAULT_FILE };
