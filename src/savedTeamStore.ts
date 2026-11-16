import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SavedTeamConfig, SavedTeamsState } from './types.js';
import { teamOfSsid } from './utils.js';

const DEFAULT_FILE = 'saved-teams.json';

/** How many replaced passphrases a robot keeps. */
const MAX_FORMER_KEYS = 5;

/** Former passphrases: distinct, not the current one, newest first, a few. */
function tidyFormerKeys(keys: string[], current: string): string[] {
  return [...new Set(keys)].filter(k => k && k !== current).slice(0, MAX_FORMER_KEYS);
}

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
  private filePath: string;
  private listeners: ((state: SavedTeamsState) => void)[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.SAVED_TEAMS_FILE ?? DEFAULT_FILE;
    this.load();
  }

  /** Save or update a team config. Called automatically when radioManager.configure() succeeds.
   *  A replaced passphrase is kept in `formerKeys`, to try if the new one
   *  turns out wrong. `autoConnect` is kept unless given (a new robot: on). */
  saveTeam(ssid: string, wpaKey: string, internetAccess?: boolean, opts: { autoConnect?: boolean } = {}): void {
    if (!ssid || !wpaKey) return;

    const existing = this.teams.get(ssid);
    const now = Date.now();
    const formerKeys =
      existing && existing.wpaKey !== wpaKey
        ? [existing.wpaKey, ...(existing.formerKeys ?? [])]
        : (existing?.formerKeys ?? []);
    const autoConnect = opts.autoConnect ?? existing?.autoConnect;

    this.teams.set(ssid, {
      ssid,
      wpaKey,
      wpaKeyHash: computeWpaKeyHash(ssid, wpaKey),
      internetAccess,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      ...(autoConnect === false && { autoConnect: false }),
      ...(formerKeys.length > 0 && { formerKeys: tidyFormerKeys(formerKeys, wpaKey) }),
    });

    this.persist();
    this.notifyListeners();
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
   *  ones (most recently used first), then the ones they had before. */
  keysForTeam(team: number): string[] {
    const mine = this.getTeams().filter(c => teamOfSsid(c.ssid) === team);
    const keys = [...mine.map(c => c.wpaKey), ...mine.flatMap(c => c.formerKeys ?? [])];
    return [...new Set(keys)];
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
      teams: this.getTeams().map(({ wpaKey: _, formerKeys: _former, ...rest }) => rest),
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
              ...(Array.isArray(entry.formerKeys) && {
                formerKeys: tidyFormerKeys(
                  entry.formerKeys.filter((k: unknown) => typeof k === 'string'),
                  entry.wpaKey,
                ),
              }),
            });
          }
        }
        console.log(`Loaded ${this.teams.size} saved team config(s) from ${this.filePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load saved teams from ${this.filePath}:`, (err as Error).message);
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
