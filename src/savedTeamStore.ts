import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SavedTeamConfig, SavedTeamsState } from './types.js';
import { teamOfSsid } from './utils.js';

const DEFAULT_FILE = 'saved-teams.json';
const DEFAULT_HISTORY_FILE = 'team-passphrases.json';

/** Compute the passphrase verification hash: SHA-256(ssid + wpaKey) */
export function computeWpaKeyHash(ssid: string, wpaKey: string): string {
  return createHash('sha256')
    .update(ssid + wpaKey)
    .digest('hex');
}

/**
 * Server-side store for saved team WiFi configurations.
 * Keyed by SSID (teamNumber-suffix), persisted to a JSON file.
 * WPA keys are stored in plain text (acceptable for practice field use).
 * A hash is also stored for the optional client-side "check passphrase" feature.
 */
export class SavedTeamStore {
  private teams = new Map<string, SavedTeamConfig>();
  /** Every passphrase each team has ever used here, newest first, kept for
   *  good: removing or re-keying a robot doesn't forget one, and teams reuse
   *  them year to year. Tried on a robot its own passphrase doesn't open.
   *  Never leaves the server. */
  private history = new Map<number, string[]>();
  private filePath: string;
  private historyPath: string;
  private listeners: ((state: SavedTeamsState) => void)[] = [];

  constructor(filePath?: string, historyPath?: string) {
    this.filePath = filePath ?? process.env.SAVED_TEAMS_FILE ?? DEFAULT_FILE;
    this.historyPath = historyPath ?? process.env.TEAM_PASSPHRASES_FILE ?? DEFAULT_HISTORY_FILE;
    this.load();
    this.loadHistory();
  }

  /** Save or update a team config. Called automatically when radioManager.configure() succeeds.
   *  The passphrase joins the team's history. `autoConnect` is kept unless
   *  given (a new robot: on). */
  saveTeam(ssid: string, wpaKey: string, internetAccess?: boolean, opts: { autoConnect?: boolean } = {}): void {
    if (!ssid || !wpaKey) return;

    const existing = this.teams.get(ssid);
    const now = Date.now();
    const autoConnect = opts.autoConnect ?? existing?.autoConnect;

    this.teams.set(ssid, {
      ssid,
      wpaKey,
      wpaKeyHash: computeWpaKeyHash(ssid, wpaKey),
      internetAccess,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      ...(autoConnect === false && { autoConnect: false }),
    });

    this.persist();
    if (this.remember(ssid, wpaKey)) this.persistHistory();
    this.notifyListeners();
  }

  /** Put a passphrase at the front of its team's history. True if that
   *  changed anything. */
  private remember(ssid: string, wpaKey: string): boolean {
    const team = teamOfSsid(ssid);
    if (team === null || !wpaKey) return false;
    const keys = this.history.get(team) ?? [];
    if (keys[0] === wpaKey) return false;
    this.history.set(team, [wpaKey, ...keys.filter(k => k !== wpaKey)]);
    return true;
  }

  /** Turn a saved robot's auto-connect on or off. False if it isn't saved. */
  setAutoConnect(ssid: string, autoConnect: boolean): boolean {
    const config = this.teams.get(ssid);
    if (!config) return false;
    if ((config.autoConnect !== false) === autoConnect) return true;
    const { autoConnect: _, ...rest } = config;
    this.teams.set(ssid, autoConnect ? rest : { ...rest, autoConnect: false });
    this.persist();
    this.notifyListeners();
    return true;
  }

  /** Every passphrase pFMS has for a team, distinct: its robots' current
   *  ones (most recently used first), then every one it has used before,
   *  newest first. */
  keysForTeam(team: number): string[] {
    const mine = this.robotsOfTeam(team).map(c => c.wpaKey);
    return [...new Set([...mine, ...(this.history.get(team) ?? [])])];
  }

  /** The saved robots of a team. */
  robotsOfTeam(team: number): SavedTeamConfig[] {
    return this.getTeams().filter(c => teamOfSsid(c.ssid) === team);
  }

  /** Remove a saved team config by SSID. */
  removeTeam(ssid: string): boolean {
    const removed = this.teams.delete(ssid);
    if (removed) {
      this.persist();
      this.notifyListeners();
    }
    return removed;
  }

  /** Get all saved team configs. */
  getTeams(): SavedTeamConfig[] {
    return [...this.teams.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** Get the client-facing broadcast state (passphrases stripped). */
  getState(): SavedTeamsState {
    return {
      type: 'savedTeamsState',
      teams: this.getTeams().map(({ wpaKey: _, ...rest }) => rest),
    };
  }

  /** Look up a saved config by SSID. */
  getTeam(ssid: string): SavedTeamConfig | undefined {
    return this.teams.get(ssid);
  }

  /** The most recently used saved robot for a team number, across all its
   *  SSIDs ("{team}" or "{team}-{suffix}"). */
  bestForTeam(team: number): SavedTeamConfig | undefined {
    const prefix = String(team);
    let best: SavedTeamConfig | undefined;
    for (const config of this.teams.values()) {
      if (config.ssid === prefix || config.ssid.startsWith(prefix + '-')) {
        if (!best || config.lastUsedAt > best.lastUsedAt) {
          best = config;
        }
      }
    }
    return best;
  }

  /** Look up the most recently used WPA key for a team number across all saved SSIDs. */
  getWpaKeyForTeam(team: number): string | undefined {
    return this.bestForTeam(team)?.wpaKey;
  }

  /** Register a listener for state changes. */
  addListener(fn: (state: SavedTeamsState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error in SavedTeamStore listener:', err);
      }
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry?.ssid === 'string' && typeof entry?.wpaKey === 'string') {
            // Recompute hash in case it's stale or missing
            this.teams.set(entry.ssid, {
              ssid: entry.ssid,
              wpaKey: entry.wpaKey,
              wpaKeyHash: computeWpaKeyHash(entry.ssid, entry.wpaKey),
              internetAccess: entry.internetAccess,
              createdAt: entry.createdAt ?? Date.now(),
              lastUsedAt: entry.lastUsedAt ?? Date.now(),
              ...(entry.autoConnect === false && { autoConnect: false }),
            });
          }
        }
        console.log(`Loaded ${this.teams.size} saved team config(s) from ${this.filePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load saved teams from ${this.filePath}:`, (err as Error).message);
    }
  }

  /** Read the history, then add any saved robot's passphrase it lacks (the
   *  first run seeds it from the saved robots). */
  private loadHistory(): void {
    try {
      if (existsSync(this.historyPath)) {
        const raw: unknown = JSON.parse(readFileSync(this.historyPath, 'utf-8'));
        for (const [key, value] of Object.entries(typeof raw === 'object' && raw ? raw : {})) {
          const team = Number(key);
          if (!Number.isInteger(team) || team <= 0 || !Array.isArray(value)) continue;
          const keys = value.filter((k): k is string => typeof k === 'string' && k.length > 0);
          this.history.set(team, [...new Set(keys)]);
        }
      }
    } catch (err) {
      console.warn(`Failed to load team passphrases from ${this.historyPath}:`, (err as Error).message);
    }
    let added = false;
    for (const config of [...this.teams.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
      const team = teamOfSsid(config.ssid);
      if (team === null || this.history.get(team)?.includes(config.wpaKey)) continue;
      this.history.set(team, [config.wpaKey, ...(this.history.get(team) ?? [])]);
      added = true;
    }
    if (added) this.persistHistory();
  }

  private persistHistory(): void {
    try {
      const out: Record<string, string[]> = {};
      for (const [team, keys] of [...this.history].sort((a, b) => a[0] - b[0])) out[String(team)] = keys;
      writeFileSync(this.historyPath, JSON.stringify(out, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save team passphrases to ${this.historyPath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      // Exclude wpaKeyHash — it's a derived value recomputed on load
      const teams = this.getTeams().map(({ wpaKeyHash: _, ...rest }) => rest);
      const data = JSON.stringify(teams, null, 2);
      writeFileSync(this.filePath, data, 'utf-8');
    } catch (err) {
      console.error(`Failed to save teams to ${this.filePath}:`, (err as Error).message);
    }
  }
}
