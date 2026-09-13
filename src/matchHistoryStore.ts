import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { MatchEngine } from './matchEngine.js';
import type { ScoringEngine } from './scoringEngine.js';
import type {
  Alliance,
  MatchHistoryEntry,
  MatchHistoryState,
  MatchHistoryTeam,
  MatchRecording,
  MatchReviewResult,
  StationName,
} from './types.js';
import { StationNameList } from './types.js';
import { mintShareToken } from './matchEngine.js';

const DEFAULT_FILE = 'match-history.json';
const MAX_ENTRIES = 100;

export class MatchHistoryStore {
  private matches: MatchHistoryEntry[] = [];
  private filePath: string;
  private listeners: ((state: MatchHistoryState) => void)[] = [];
  private matchStartTime = 0;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_FILE;
    this.load();
  }

  /** Attach to match engine and scoring engine to capture match results. */
  attach(matchEngine: MatchEngine, scoringEngine: ScoringEngine): void {
    let lastPhase = 'idle';

    matchEngine.addStateListener(state => {
      const phase = state.phase;
      if (phase === lastPhase) return;
      const prevPhase = lastPhase;
      lastPhase = phase;

      // Record match start time
      if (phase === 'auto' || (phase === 'teleop' && prevPhase === 'countdown')) {
        this.matchStartTime = Date.now();
      }

      // Capture match result on transition to postMatch
      if (phase === 'postMatch' && prevPhase !== 'postMatch') {
        const now = Date.now();
        const scoreState = scoringEngine.getState();

        // Collect participating teams
        const teams: MatchHistoryTeam[] = [];
        for (const station of StationNameList) {
          const ss = state.stationStates[station];
          if (!ss?.joined || !ss.teamNumber || !ss.alliance) continue;
          teams.push({
            station: station as StationName,
            teamNumber: ss.teamNumber,
            alliance: ss.alliance,
            matchSlot: ss.matchSlot,
          });
        }

        if (teams.length === 0) return; // Nothing worth recording

        // Sum total scores per alliance
        const redScore = Object.values(scoreState.red.elements).reduce((sum, e) => sum + e.points, 0);
        const blueScore = Object.values(scoreState.blue.elements).reduce((sum, e) => sum + e.points, 0);

        const entry: MatchHistoryEntry = {
          matchNumber: this.matches.length + 1,
          matchId: state.matchId,
          shareToken: state.shareToken ?? mintShareToken(),
          startedAt: this.matchStartTime || now,
          endedAt: now,
          durationSeconds: Math.round((now - (this.matchStartTime || now)) / 1000),
          endReason: state.endReason ?? 'normal',
          autoWinner: state.autoWinnerAlliance ?? null,
          teams,
          redScore,
          blueScore,
        };

        this.matches.push(entry);
        if (this.matches.length > MAX_ENTRIES) {
          this.matches = this.matches.slice(-MAX_ENTRIES);
        }

        this.persist();
        this.notifyListeners();
      }
    });
  }

  getState(): MatchHistoryState {
    return {
      type: 'matchHistoryState',
      matches: this.matches,
    };
  }

  /** Attach a human-reviewed final score to a match. Live scores are kept untouched.
   *  Returns false when no match with this id exists. A later review for the same
   *  alliance replaces the earlier one. */
  applyReview(matchId: string, alliance: Alliance, review: MatchReviewResult): boolean {
    const entry = this.matches.find(m => m.matchId === matchId);
    if (!entry) return false;
    entry.review = { ...entry.review, [alliance]: review };
    this.persist();
    this.notifyListeners();
    return true;
  }

  /** Record the external video-review page URL for a match (recording available).
   *  Returns false when no match with this id exists. */
  setReviewUrl(matchId: string, url: string): boolean {
    const entry = this.matches.find(m => m.matchId === matchId);
    if (!entry) return false;
    entry.reviewUrl = url;
    this.persist();
    this.notifyListeners();
    return true;
  }

  /** Attach pFMS's own video recordings to a match. Returns false when no
   *  match with this id exists (e.g. no team had joined, so nothing was kept). */
  setRecordings(matchId: string, recordings: MatchRecording[]): boolean {
    const entry = this.matches.find(m => m.matchId === matchId);
    if (!entry) return false;
    entry.recordings = recordings;
    this.persist();
    this.notifyListeners();
    return true;
  }

  /** The history entry for a match id, if any. */
  find(matchId: string): MatchHistoryEntry | undefined {
    return this.matches.find(m => m.matchId === matchId);
  }

  /** The history entry a share token unlocks, if any. */
  findByToken(token: string): MatchHistoryEntry | undefined {
    return this.matches.find(m => m.shareToken === token);
  }

  clear(): void {
    this.matches = [];
    this.persist();
    this.notifyListeners();
  }

  addListener(fn: (state: MatchHistoryState) => void): () => void {
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
        console.error('Error in MatchHistoryStore listener:', err);
      }
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.matches = parsed;
        console.log(`Loaded ${this.matches.length} match history entries from ${this.filePath}`);
        // Entries recorded before share tokens existed get one now, so their
        // summary/video can be linked too.
        let backfilled = 0;
        for (const m of this.matches) {
          if (!m.shareToken) {
            m.shareToken = mintShareToken();
            backfilled++;
          }
        }
        if (backfilled > 0) this.persist();
      }
    } catch (err) {
      console.warn(`Failed to load match history from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.matches, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save match history to ${this.filePath}:`, (err as Error).message);
    }
  }
}
