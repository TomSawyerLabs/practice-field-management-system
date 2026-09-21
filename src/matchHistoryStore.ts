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
import { StationNameList, isChallengeConfig, challengePenalties, type ChallengeTally } from './types.js';
import { mintShareToken } from './matchEngine.js';

/** Only alliances that actually had a robot on the field are recorded — a
 *  solo run shouldn't leave an empty second entry on the leaderboard. */
function challengeTallyFor(
  teams: MatchHistoryTeam[],
  challenge: Record<Alliance, ChallengeTally>,
): Partial<Record<Alliance, ChallengeTally>> {
  const tally: Partial<Record<Alliance, ChallengeTally>> = {};
  for (const alliance of ['red', 'blue'] as Alliance[]) {
    if (teams.some(t => t.alliance === alliance)) tally[alliance] = { ...challenge[alliance] };
  }
  return tally;
}

const DEFAULT_FILE = 'match-history.json';
/** A weekend field event can put a hundred challenge runs through here on its
 *  own, and the leaderboard is a view over this list — roll off too early and
 *  the morning's results vanish at lunchtime. */
const MAX_ENTRIES = 250;

export class MatchHistoryStore {
  private matches: MatchHistoryEntry[] = [];
  private filePath: string;
  private listeners: ((state: MatchHistoryState) => void)[] = [];
  private matchStartTime = 0;
  /** The entry for the match now in its post-match count, still receiving late balls. */
  private openEntry: MatchHistoryEntry | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_FILE;
    this.load();
  }

  /** Attach to match engine and scoring engine to capture match results. */
  attach(matchEngine: MatchEngine, scoringEngine: ScoringEngine): void {
    let lastPhase = 'idle';

    /** Refresh an entry's scores from the engine: totals, period breakdown,
     *  and the score-over-time series built from when each ball scored. */
    const fillScores = (entry: MatchHistoryEntry) => {
      const scoreState = scoringEngine.getState();
      entry.redScore = Object.values(scoreState.red.elements).reduce((sum, e) => sum + e.points, 0);
      entry.blueScore = Object.values(scoreState.blue.elements).reduce((sum, e) => sum + e.points, 0);
      entry.periodBreakdown = scoreState.periodBreakdown;
      const series = scoringEngine.getMatchScoreTimeline(entry.startedAt);
      // Close the series at match end with the final totals so the chart ends at the score.
      const endT = Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1000));
      const last = series[series.length - 1];
      if (last && last.t < endT) series.push({ t: endT, red: entry.redScore, blue: entry.blueScore });
      entry.scoreTimeline = series;
    };

    // Balls still in flight at the final buzzer land during the post-match
    // count, and a lagging detector reports them later still. Keep the open
    // entry's scores current until the match clears.
    scoringEngine.addStateListener(() => {
      if (!this.openEntry) return;
      fillScores(this.openEntry);
      this.persist();
      this.notifyListeners();
    });

    matchEngine.addStateListener(state => {
      const phase = state.phase;

      // A challenge tally stays editable through the post-match wrap-up, so
      // follow it until the field clears. This sits ABOVE the phase-unchanged
      // early return below — a staff correction doesn't move the phase.
      if (phase === 'postMatch' && this.openEntry?.challenge && state.challenge) {
        const tally = challengeTallyFor(this.openEntry.teams, state.challenge);
        if (JSON.stringify(tally) !== JSON.stringify(this.openEntry.challenge.tally)) {
          this.openEntry.challenge.tally = tally;
          this.persist();
          this.notifyListeners();
        }
      }

      if (phase === lastPhase) return;
      const prevPhase = lastPhase;
      lastPhase = phase;

      // Record match start time
      if (phase === 'auto' || (phase === 'teleop' && prevPhase === 'countdown')) {
        this.matchStartTime = Date.now();
      }

      // The scoring engine drops the match's events once the field clears,
      // so the entry is final from here.
      if (phase !== 'postMatch' && this.openEntry) {
        this.openEntry = null;
      }

      // Capture match result on transition to postMatch
      if (phase === 'postMatch' && prevPhase !== 'postMatch') {
        const now = Date.now();

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

        const entry: MatchHistoryEntry = {
          matchNumber: this.matches.length + 1,
          matchId: state.matchId,
          shareToken: state.shareToken ?? mintShareToken(),
          startedAt: this.matchStartTime || now,
          endedAt: now,
          // Wall clock, so this INCLUDES time the match spent paused. Every
          // display of it (match history, summary page, public API) shows it
          // unqualified — don't treat it as the sum of the periods.
          durationSeconds: Math.round((now - (this.matchStartTime || now)) / 1000),
          endReason: state.endReason ?? 'normal',
          autoWinner: state.autoWinnerAlliance ?? null,
          teams,
          redScore: 0,
          blueScore: 0,
        };
        if (isChallengeConfig(state.config) && state.challenge) {
          // The costs are recorded, not looked up later: changing them
          // mid-event must not silently re-score the morning's runs.
          const costs = challengePenalties({
            penaltyLaps: state.config.challengePenaltyLaps,
            penaltySeconds: state.config.challengePenaltySeconds,
          });
          entry.challenge = {
            timing: state.config.challengeTiming ?? 'window',
            ...costs,
            tally: challengeTallyFor(teams, state.challenge),
          };
        }
        fillScores(entry);

        this.matches.push(entry);
        if (this.matches.length > MAX_ENTRIES) {
          this.matches = this.matches.slice(-MAX_ENTRIES);
        }
        this.openEntry = entry;

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

  /** Drop the recording list of matches whose directory no longer exists
   *  (retention sweep or an admin delete), so pages stop offering them. */
  pruneMissingRecordings(exists: (matchId: string) => boolean): void {
    let changed = false;
    for (const m of this.matches) {
      if (m.matchId && m.recordings?.length && !exists(m.matchId)) {
        delete m.recordings;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
      this.notifyListeners();
    }
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
