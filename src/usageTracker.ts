import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type RadioManager from './radioManager.js';
import type { StationName, UsageSession, UsageState } from './types.js';
import { StationNameList } from './types.js';

const DEFAULT_FILE = 'usage-data.json';
/** Close a session after 2 hours without a link. */
const DISCONNECT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Minimum session duration to persist (skip sub-second glitches). */
const MIN_SESSION_SECONDS = 10;
/** Persist state periodically (avoid excessive I/O). */
const PERSIST_INTERVAL_MS = 60_000;

export class UsageTracker {
  private sessions: UsageSession[] = [];
  /** Active (open-ended) session per station. Points into `sessions` array. */
  private activeByStation = new Map<StationName, UsageSession>();
  /** Disconnect timers: 2h after last link, close the session. */
  private disconnectTimers = new Map<StationName, NodeJS.Timeout>();
  /** Previous link state per station (for transition detection). */
  private wasLinked = new Map<StationName, boolean>();
  /** Previous team per station (for detecting SSID unconfigure). */
  private prevTeam = new Map<StationName, number | null>();

  private filePath: string;
  private listeners: ((state: UsageState) => void)[] = [];
  private dirty = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_FILE;
    this.load();
    // Close any sessions that were still open from a previous run
    this.closeOrphanedSessions();
    // Periodic persist (saves dirty flag check)
    setInterval(() => {
      if (this.dirty) {
        this.persist();
        this.dirty = false;
      }
    }, PERSIST_INTERVAL_MS);
  }

  /** `isParked` names a linked robot nobody is using. It counts as off the
   *  field, so one left powered on overnight doesn't run up hours. */
  attach(radioManager: RadioManager, isParked: (team: number, station: StationName) => boolean = () => false): void {
    // Initialize prev team state
    for (const station of StationNameList) {
      this.prevTeam.set(station as StationName, radioManager.getTeamForStation(station as StationName));
    }

    // Listen for radio status updates (fires on each poll cycle that has changes, ~15s throttle)
    radioManager.addStatusListener(entry => {
      if (!entry.radioUpdate) return;
      const now = entry.timestamp;

      for (const station of StationNameList) {
        const sn = station as StationName;
        const detail = entry.radioUpdate.stationStatuses[sn];
        if (!detail) continue;

        const team = radioManager.getTeamForStation(sn);
        const linked = detail.isLinked && !(team && isParked(team, sn));
        const wasLinked = this.wasLinked.get(sn) ?? false;
        this.wasLinked.set(sn, linked);

        if (!team) continue; // Station not configured for a team

        if (linked && !wasLinked) {
          // Link just came up
          this.onLinkUp(sn, team, now);
        } else if (linked && wasLinked) {
          // Still linked — update lastSeen
          this.onStillLinked(sn, team, now);
        } else if (!linked && wasLinked) {
          // Link just dropped
          this.onLinkDown(sn, now);
        }
      }
    });

    // Listen for config changes (station SSID assigned or removed)
    radioManager.addConfigChangeListener(() => {
      for (const station of StationNameList) {
        const sn = station as StationName;
        const team = radioManager.getTeamForStation(sn);
        const prev = this.prevTeam.get(sn) ?? null;
        this.prevTeam.set(sn, team);

        if (prev !== null && team === null) {
          // Station was unconfigured — close session immediately
          this.closeSession(sn);
        } else if (prev !== null && team !== null && prev !== team) {
          // Team changed — close old, new link events will start a new session
          this.closeSession(sn);
        }
      }
    });
  }

  // ── Event handlers ────────────────────────────────────────────────

  private onLinkUp(station: StationName, team: number, now: number): void {
    const active = this.activeByStation.get(station);

    if (active && active.team === team) {
      // Same team reconnected — extend existing session
      active.lastSeenAt = now;
      this.cancelDisconnectTimer(station);
      this.dirty = true;
      return;
    }

    // Different team or no active session
    if (active) {
      this.closeSession(station);
    }

    const session: UsageSession = {
      team,
      station,
      startedAt: now,
      lastSeenAt: now,
      endedAt: null,
    };
    this.sessions.push(session);
    this.activeByStation.set(station, session);
    this.cancelDisconnectTimer(station);
    this.dirty = true;
    this.notifyListeners();
  }

  private onStillLinked(station: StationName, team: number, now: number): void {
    const active = this.activeByStation.get(station);
    if (!active) {
      // Shouldn't happen, but handle gracefully
      this.onLinkUp(station, team, now);
      return;
    }
    if (active.team !== team) {
      // Team changed under us (shouldn't happen with config change listener, but be safe)
      this.closeSession(station);
      this.onLinkUp(station, team, now);
      return;
    }
    active.lastSeenAt = now;
    this.cancelDisconnectTimer(station);
    this.dirty = true;
  }

  private onLinkDown(station: StationName, now: number): void {
    const active = this.activeByStation.get(station);
    if (!active) return;
    active.lastSeenAt = now;
    this.dirty = true;

    // Start 2-hour disconnect timer
    if (!this.disconnectTimers.has(station)) {
      this.disconnectTimers.set(
        station,
        setTimeout(() => {
          this.disconnectTimers.delete(station);
          this.closeSession(station);
        }, DISCONNECT_TIMEOUT_MS),
      );
    }
  }

  private closeSession(station: StationName): void {
    const active = this.activeByStation.get(station);
    if (!active) return;

    active.endedAt = active.lastSeenAt;
    this.activeByStation.delete(station);
    this.cancelDisconnectTimer(station);

    // Drop very short sessions (glitches)
    if (active.endedAt - active.startedAt < MIN_SESSION_SECONDS * 1000) {
      const idx = this.sessions.indexOf(active);
      if (idx >= 0) this.sessions.splice(idx, 1);
    }

    this.dirty = true;
    this.persist();
    this.notifyListeners();
  }

  private cancelDisconnectTimer(station: StationName): void {
    const timer = this.disconnectTimers.get(station);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(station);
    }
  }

  /** On startup, close any sessions that were left open from a previous server run. */
  private closeOrphanedSessions(): void {
    let changed = false;
    for (const session of this.sessions) {
      if (session.endedAt === null) {
        session.endedAt = session.lastSeenAt;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  // ── State ─────────────────────────────────────────────────────────

  getState(): UsageState {
    return {
      type: 'usageState',
      sessions: this.sessions,
    };
  }

  addListener(fn: (state: UsageState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('Error in UsageTracker listener:', err);
      }
    }
  }

  // ── Persistence ───────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.sessions = parsed;
        console.log(`Loaded ${this.sessions.length} usage sessions from ${this.filePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load usage data from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save usage data to ${this.filePath}:`, (err as Error).message);
    }
  }
}
