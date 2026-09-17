import {
  Alliance,
  MatchPhase,
  MatchState,
  ScoreEvent,
  ScoreState,
  ScoreBatch,
  ScoringMode,
  ScoringElementConfig,
  ScoringSourceStatus,
  ProcessedScoreEvent,
  AllianceScore,
  ElementScore,
  ScoreSample,
  ScoreTiming,
} from './types.js';
import { getMatchSubPeriod } from './shiftState.js';
import { MatchTimeline, type MatchMoment } from './matchTimeline.js';

const DEFAULT_WINDOW_SECONDS = 30;
const DEFAULT_PHASE_GRACE_SECONDS = 5;
const DEFAULT_BATCH_TIMEOUT_SECONDS = 100;
/** A device `timestamp` this far ahead of the server clock is treated as skew and ignored. */
const MAX_FUTURE_TIMESTAMP_MS = 2000;
/** A device `timestamp` older than this is treated as a bogus clock and ignored. */
const MAX_TIMESTAMP_AGE_MS = 60 * 60 * 1000;

const PRE_MATCH_PHASES: ReadonlySet<MatchPhase> = new Set(['idle', 'created', 'countdown']);

function oppositeAlliance(alliance: Alliance): Alliance {
  return alliance === 'red' ? 'blue' : 'red';
}

function emptyAllianceScore(): AllianceScore {
  return { total: 0, elements: {} };
}

/**
 * Work out when a score actually happened from what the device told us.
 * `ageMs` wins (no clock agreement needed); a plausible `timestamp` is next;
 * otherwise the receive time.
 */
export function resolveOccurredAt(event: ScoreEvent, receivedAt: number): { occurredAt: number; timing: ScoreTiming } {
  if (typeof event.ageMs === 'number' && Number.isFinite(event.ageMs)) {
    return { occurredAt: receivedAt - Math.max(0, event.ageMs), timing: 'age' };
  }
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) {
    const lag = receivedAt - event.timestamp;
    if (lag >= -MAX_FUTURE_TIMESTAMP_MS && lag <= MAX_TIMESTAMP_AGE_MS) {
      return { occurredAt: Math.min(event.timestamp, receivedAt), timing: 'timestamp' };
    }
  }
  return { occurredAt: receivedAt, timing: 'receive' };
}

let nextEventId = 1;

interface ActiveBatch {
  events: ProcessedScoreEvent[];
  startedAt: number;
  active: boolean; // false = timed out (desaturated on frontend)
}

/** Does this event add to the match score for its alliance? */
function countsForMatch(e: ProcessedScoreEvent): boolean {
  return !e.deduplicated && !e.phaseRestricted && !e.goalInactive && !e.outsideMatch;
}

/** Does this event add to a free-play tally? */
function countsForFreePlay(e: ProcessedScoreEvent): boolean {
  return !e.deduplicated && !e.phaseRestricted;
}

export class ScoringEngine {
  private events: ProcessedScoreEvent[] = [];
  private sources = new Map<string, ScoringSourceStatus>();
  private elements = new Map<string, ScoringElementConfig>();
  private mode: ScoringMode = 'freePlay';
  private windowSeconds = DEFAULT_WINDOW_SECONDS;
  private phaseGraceSeconds = DEFAULT_PHASE_GRACE_SECONDS;
  private batchTimeoutSeconds = DEFAULT_BATCH_TIMEOUT_SECONDS;
  private currentMatchPhase: MatchPhase = 'idle';
  /** Key: `${element}:${alliance}`, value: occurredAt of last counted event */
  private lastDedupTimestamp = new Map<string, number>();
  private windowTimer: NodeJS.Timeout | null = null;
  private windowTimerTarget: number | undefined;

  // ── Batch tracking (free play) ──────────────────────────────────
  private activeBatches: Record<Alliance, ActiveBatch> = {
    red: { events: [], startedAt: 0, active: false },
    blue: { events: [], startedAt: 0, active: false },
  };
  private recentBatches: Record<Alliance, ScoreBatch[]> = { red: [], blue: [] };
  private batchTimers: Record<Alliance, NodeJS.Timeout | null> = { red: null, blue: null };

  // ── Per-alliance match mode ─────────────────────────────────────
  /** Which alliances are in match mode. Empty = all follow the top-level mode. */
  private matchAlliances = new Set<Alliance>();

  // ── Match timeline (REBUILT shift scoring at the time the ball scored) ──
  /** Record of the match engine's state over wall-clock time */
  private timeline = new MatchTimeline();

  private autoRegisterLimit = 1;
  private suppressBroadcast = false;
  private listeners: ((state: ScoreState) => void)[] = [];

  /** Set the maximum number of elements that can be auto-registered from incoming events. */
  setAutoRegisterLimit(limit: number): void {
    this.autoRegisterLimit = Math.max(0, Math.round(limit));
  }

  getAutoRegisterLimit(): number {
    return this.autoRegisterLimit;
  }

  /**
   * Submit a score event. Returns the processed event (check `deduplicated`,
   * `phaseRestricted`, `goalInactive`, `outsideMatch` to see whether it
   * counted), or 'unknown_element' if the element isn't configured and
   * can't be auto-registered.
   */
  submitEvent(event: ScoreEvent, receivedAt: number = Date.now()): ProcessedScoreEvent | 'unknown_element' {
    let elementConfig = this.elements.get(event.element);
    if (!elementConfig) {
      // Auto-register if under the limit
      const autoCount = [...this.elements.values()].filter(e => e.autoRegistered).length;
      if (autoCount >= this.autoRegisterLimit) {
        return 'unknown_element';
      }
      elementConfig = {
        id: event.element,
        name: event.element,
        pointValue: 1,
        autoRegistered: true,
      };
      this.elements.set(event.element, elementConfig);
    }

    const count = event.count ?? 1;
    const { occurredAt, timing } = resolveOccurredAt(event, receivedAt);

    // Update source tracking
    const sourceStatus = this.sources.get(event.source) ?? {
      lastSeen: 0,
      eventCount: 0,
    };
    sourceStatus.lastSeen = receivedAt;
    sourceStatus.eventCount++;
    sourceStatus.lastElement = event.element;
    sourceStatus.lastAlliance = event.alliance;
    sourceStatus.lastLagMs = Math.max(0, receivedAt - occurredAt);
    sourceStatus.lastTiming = timing;
    this.sources.set(event.source, sourceStatus);

    // Check deduplication — against when the balls scored, not when we heard
    const dedupKey = `${event.element}:${event.alliance}`;
    const dedupWindow = elementConfig.deduplicationWindowMs ?? 0;
    let deduplicated = false;
    if (dedupWindow > 0 && count > 0) {
      const lastTime = this.lastDedupTimestamp.get(dedupKey);
      if (lastTime !== undefined && Math.abs(occurredAt - lastTime) < dedupWindow) {
        deduplicated = true;
      }
    }

    const awardedTo = elementConfig.awardToOpponent ? oppositeAlliance(event.alliance) : event.alliance;

    const processed: ProcessedScoreEvent = {
      id: `evt-${nextEventId++}`,
      source: event.source,
      alliance: event.alliance,
      element: event.element,
      count,
      pointValue: elementConfig.pointValue,
      awardedTo,
      timestamp: receivedAt,
      occurredAt,
      lagMs: Math.max(0, receivedAt - occurredAt),
      timing,
      deviceTimestamp: event.timestamp,
      deduplicated,
    };
    this.attribute(processed, elementConfig);

    this.events.push(processed);

    // Update dedup timestamp (only for counted, non-negative events)
    if (!deduplicated && count > 0) {
      this.lastDedupTimestamp.set(dedupKey, occurredAt);
    }

    // Handle free play tracking for non-match alliances (or when fully in freePlay)
    if (!this.matchAlliances.has(awardedTo) && countsForFreePlay(processed)) {
      this.addToBatch(awardedTo, processed, receivedAt);
      this.ensureWindowTimer();
    }

    this.broadcast();
    return processed;
  }

  /**
   * Decide which phase / sub-period the event belongs to and whether the goal
   * counted it, judged at the instant the ball scored. Re-run when the
   * timeline learns something new about that instant (a back-dated phase
   * boundary), so `deduplicated` is left alone apart from phase restriction.
   */
  private attribute(e: ProcessedScoreEvent, elementConfig: ScoringElementConfig | undefined): void {
    const inMatchAlliance = this.matchAlliances.has(e.awardedTo);
    const evalAt = this.attributionInstant(e);
    const moment = this.timeline.at(evalAt);

    let matchPhase: MatchPhase | undefined;
    let matchSubPeriod: string | undefined;
    let goalInactive = false;
    let outsideMatch = false;

    if (this.mode === 'match' || inMatchAlliance) {
      matchPhase = moment?.phase ?? this.currentMatchPhase;
    }

    if (inMatchAlliance) {
      const verdict = this.timeline.classifyGoal(e.awardedTo, evalAt);
      if (verdict === 'inactive') goalInactive = true;
      else if (verdict === 'outsideMatch') outsideMatch = true;
      else if (verdict === null && this.timeline.size > 0) {
        // The record starts at this match's countdown; anything earlier
        // scored before the match existed.
        outsideMatch = true;
      }

      if (moment?.config) {
        matchSubPeriod =
          getMatchSubPeriod(moment.gamePhase, moment.remaining, moment.config.teleopDuration) ?? undefined;
      }
    }

    // Phase restrictions on the element (match mode only)
    let phaseRestricted = false;
    if (this.mode === 'match' && elementConfig?.activePhases && elementConfig.activePhases.length > 0 && matchPhase) {
      phaseRestricted = !elementConfig.activePhases.includes(matchPhase);
    }

    e.matchPhase = matchPhase;
    e.matchSubPeriod = matchSubPeriod;
    e.goalInactive = goalInactive || undefined;
    e.outsideMatch = outsideMatch || undefined;
    e.phaseRestricted = phaseRestricted || undefined;
  }

  /**
   * The instant an event is judged at. Normally when the ball scored. For
   * events with no timing information, keep the old phase-grace behaviour:
   * a report arriving within `phaseGraceSeconds` of a phase change is
   * assumed to have scored just before it (the report was probably lagging).
   */
  private attributionInstant(e: ProcessedScoreEvent): number {
    if (e.timing !== 'receive' || this.phaseGraceSeconds <= 0) return e.occurredAt;
    const now = this.timeline.at(e.timestamp);
    if (!now || e.timestamp - now.phaseStartedAt >= this.phaseGraceSeconds * 1000) return e.occurredAt;
    const justBefore = now.phaseStartedAt - 1;
    const prev = this.timeline.at(justBefore);
    if (!prev || PRE_MATCH_PHASES.has(prev.phase)) return e.occurredAt;
    return justBefore;
  }

  /** Re-judge events that scored at or after `since` (the timeline changed there). */
  private reattributeSince(since: number): void {
    let changed = false;
    for (const e of this.events) {
      if (e.occurredAt < since) continue;
      const before = `${e.matchPhase}|${e.matchSubPeriod}|${e.goalInactive}|${e.outsideMatch}|${e.phaseRestricted}`;
      this.attribute(e, this.elements.get(e.element));
      const after = `${e.matchPhase}|${e.matchSubPeriod}|${e.goalInactive}|${e.outsideMatch}|${e.phaseRestricted}`;
      if (before !== after) changed = true;
    }
    if (changed) this.broadcast();
  }

  /** Process multiple events with a single broadcast at the end (if any changed state). */
  batch(fn: () => void): void {
    const eventsBefore = this.events.length;
    const elementsBefore = this.elements.size;
    this.suppressBroadcast = true;
    try {
      fn();
    } finally {
      this.suppressBroadcast = false;
      if (this.events.length !== eventsBefore || this.elements.size !== elementsBefore) {
        this.broadcast();
      }
    }
  }

  /** Configure a scoring element. */
  configureElement(config: ScoringElementConfig): void {
    this.elements.set(config.id, config);
    this.broadcast();
  }

  /** Remove a scoring element. */
  removeElement(id: string): void {
    this.elements.delete(id);
    this.broadcast();
  }

  /** Replace all element configurations at once. */
  setElements(configs: ScoringElementConfig[]): void {
    this.elements.clear();
    for (const config of configs) {
      this.elements.set(config.id, config);
    }
    this.broadcast();
  }

  /** Get all configured elements. */
  getElements(): ScoringElementConfig[] {
    return [...this.elements.values()];
  }

  /** Switch scoring mode. */
  setMode(mode: ScoringMode): void {
    this.mode = mode;
    if (mode === 'freePlay') {
      this.lastDedupTimestamp.clear();
      this.matchAlliances.clear();
      this.resetBatches();
    }
    this.broadcast();
  }

  /** Set the sliding window size for free play mode. */
  setWindowSeconds(seconds: number): void {
    this.windowSeconds = Math.max(1, Math.min(300, seconds));
    this.broadcast();
  }

  /** Set the grace period (seconds) for attributing untimed events to the previous match phase. */
  setPhaseGraceSeconds(seconds: number): void {
    this.phaseGraceSeconds = Math.max(0, Math.min(30, seconds));
    this.broadcast();
  }

  /** Set the batch inactivity timeout for free play mode. */
  setBatchTimeoutSeconds(seconds: number): void {
    this.batchTimeoutSeconds = Math.max(1, Math.min(600, seconds));
    this.broadcast();
  }

  /** Reset all scores and events. Sources and element config are preserved. */
  reset(): void {
    this.events = [];
    this.lastDedupTimestamp.clear();
    this.matchAlliances.clear();
    this.resetBatches();
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
      this.windowTimerTarget = undefined;
    }
    this.broadcast();
  }

  /** Full reset: scores, sources, and element config. */
  fullReset(): void {
    this.events = [];
    this.sources.clear();
    this.elements.clear();
    this.lastDedupTimestamp.clear();
    this.matchAlliances.clear();
    this.resetBatches();
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
      this.windowTimerTarget = undefined;
    }
    this.broadcast();
  }

  /** Called by the match engine listener when match state changes. */
  onMatchStateChange(state: MatchState, now: number = Date.now()): void {
    const prevPhase = this.currentMatchPhase;
    this.currentMatchPhase = state.phase;

    // Record this broadcast in the timeline. If it revealed a phase boundary
    // earlier than we had assumed (timer-driven transitions are back-dated
    // to when the clock ran out), events already judged in that window need
    // another look.
    this.timeline.record(state, now);
    const boundaryAt = this.timeline.latestAt;
    const boundaryMoved = prevPhase !== state.phase && boundaryAt !== undefined && boundaryAt < now;

    // Auto-switch to match mode when a match starts. 'created' must stay in
    // this guard: matches go idle → created → countdown, so a check against
    // the previous phase being 'idle' never fires and scoring stays in free
    // play for the whole match.
    if ((prevPhase === 'idle' || prevPhase === 'created') && state.phase === 'countdown') {
      this.mode = 'match';

      // Determine which alliances have joined robots
      this.matchAlliances.clear();
      if (state.stationStates) {
        for (const s of Object.values(state.stationStates)) {
          if (s?.joined && s.alliance) this.matchAlliances.add(s.alliance);
        }
      }

      // Clear events and batches only for match alliances
      this.events = this.events.filter(e => !this.matchAlliances.has(e.awardedTo));
      this.lastDedupTimestamp.clear();
      for (const alliance of this.matchAlliances) {
        this.resetBatchForAlliance(alliance);
      }

      this.broadcast();
      return;
    }

    // When the engine returns to idle, switch back to free play. Any
    // transition into idle counts — matches can end without passing through
    // postMatch (cancelled, abandoned mid-pause), and requiring
    // prevPhase === 'postMatch' left the scoreboard stuck in match mode
    // after such an end (2026-07-17). Transition-only, so an operator can
    // still manually set match mode while the engine is idle.
    if (state.phase === 'idle' && prevPhase !== 'idle' && this.mode === 'match') {
      // Clear events for match alliances
      this.events = this.events.filter(e => !this.matchAlliances.has(e.awardedTo));
      for (const alliance of this.matchAlliances) {
        this.resetBatchForAlliance(alliance);
      }
      this.matchAlliances.clear();
      this.mode = 'freePlay';
      this.broadcast();
      return;
    }

    if (boundaryMoved) {
      this.reattributeSince(boundaryAt);
    }

    // Broadcast on any phase change so clients see updated phase info
    if (prevPhase !== state.phase) {
      this.broadcast();
    }
  }

  /** Register a listener for state changes. Returns an unsubscribe function. */
  addStateListener(fn: (state: ScoreState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Get the current score state. */
  getState(): ScoreState {
    const state: ScoreState = {
      type: 'scoreState',
      mode: this.mode,
      windowSeconds: this.windowSeconds,
      autoRegisterLimit: this.autoRegisterLimit,
      phaseGraceSeconds: this.phaseGraceSeconds,
      batchTimeoutSeconds: this.batchTimeoutSeconds,
      red: emptyAllianceScore(),
      blue: emptyAllianceScore(),
      sources: Object.fromEntries(this.sources),
      elements: Object.fromEntries(this.elements),
    };

    // Compute scores per alliance based on their individual mode
    for (const alliance of ['red', 'blue'] as Alliance[]) {
      if (this.matchAlliances.has(alliance)) {
        // Match mode: cumulative scores (excluding goalInactive)
        state[alliance] = this.calculateMatchScore(alliance);
      } else {
        // Free play mode: active batch scores
        state[alliance] = this.calculateBatchScore(alliance);
      }
    }

    // Batch activity for freeplay alliances
    if (!this.matchAlliances.has('red')) {
      state.redBatchActive = this.activeBatches.red.active;
    }
    if (!this.matchAlliances.has('blue')) {
      state.blueBatchActive = this.activeBatches.blue.active;
    }

    // Recent batches for freeplay alliances
    state.recentBatches = {
      red: this.matchAlliances.has('red') ? [] : this.recentBatches.red,
      blue: this.matchAlliances.has('blue') ? [] : this.recentBatches.blue,
    };

    // Sliding window for freeplay alliances
    if (!this.matchAlliances.has('red') || !this.matchAlliances.has('blue')) {
      state.slidingWindow = {
        red: this.matchAlliances.has('red') ? emptyAllianceScore() : this.calculateSlidingWindowScore('red'),
        blue: this.matchAlliances.has('blue') ? emptyAllianceScore() : this.calculateSlidingWindowScore('blue'),
      };
    }

    // Match-specific data when any alliance is in match mode
    if (this.matchAlliances.size > 0) {
      state.matchPhase = this.currentMatchPhase;
      state.matchAlliances = [...this.matchAlliances];
      state.phaseBreakdown = this.calculatePhaseBreakdown();
      state.periodBreakdown = this.calculatePeriodBreakdown();
      state.inactiveScores = {
        red: this.matchAlliances.has('red') ? this.calculateInactiveScore('red') : emptyAllianceScore(),
        blue: this.matchAlliances.has('blue') ? this.calculateInactiveScore('blue') : emptyAllianceScore(),
      };
    }

    return state;
  }

  /**
   * The match score over time, built from when each ball actually scored
   * (not when it was reported): one point per second in which the total
   * changed, plus an opening zero. `startAt` is the wall-clock match start.
   */
  getMatchScoreTimeline(startAt: number): ScoreSample[] {
    const counted = this.events
      .filter(e => this.matchAlliances.has(e.awardedTo) && countsForMatch(e))
      .sort((a, b) => a.occurredAt - b.occurredAt);
    const samples: ScoreSample[] = [{ t: 0, red: 0, blue: 0 }];
    let red = 0;
    let blue = 0;
    for (const e of counted) {
      if (e.awardedTo === 'red') red += e.count * e.pointValue;
      else blue += e.count * e.pointValue;
      const t = Math.max(0, Math.round((e.occurredAt - startAt) / 1000));
      const last = samples[samples.length - 1];
      if (last.t === t) {
        last.red = red;
        last.blue = blue;
      } else {
        samples.push({ t, red, blue });
      }
    }
    return samples;
  }

  /** The match state at an instant, as the engine understands it (for diagnostics/tests). */
  momentAt(t: number): MatchMoment | null {
    return this.timeline.at(t);
  }

  // ── Batch management (free play) ────────────────────────────────

  /** Add an event to the active batch for the given alliance, starting a new batch if needed. */
  private addToBatch(alliance: Alliance, event: ProcessedScoreEvent, now: number): void {
    const batch = this.activeBatches[alliance];

    // If the batch is inactive (timed out), archive it and start fresh
    if (!batch.active && batch.events.length > 0) {
      this.archiveBatch(alliance, now);
    }

    // Start a new batch if empty
    if (batch.events.length === 0) {
      batch.startedAt = event.occurredAt;
    }

    batch.events.push(event);
    batch.active = true;

    // Reset the inactivity timer for this alliance
    this.resetBatchTimer(alliance);
  }

  /** Move the active batch to recentBatches. */
  private archiveBatch(alliance: Alliance, now: number): void {
    const batch = this.activeBatches[alliance];
    if (batch.events.length === 0) return;

    const score = this.calculateBatchScore(alliance);
    if (score.total > 0) {
      this.recentBatches[alliance].unshift({
        total: score.total,
        elements: score.elements,
        startedAt: batch.startedAt,
        endedAt: now,
      });
      // Keep only last 5
      if (this.recentBatches[alliance].length > 5) {
        this.recentBatches[alliance].pop();
      }
    }

    // Clear the active batch
    batch.events = [];
    batch.startedAt = 0;
    batch.active = false;
  }

  /** Reset/start the inactivity timer for an alliance's batch. */
  private resetBatchTimer(alliance: Alliance): void {
    if (this.batchTimers[alliance]) {
      clearTimeout(this.batchTimers[alliance]!);
    }
    this.batchTimers[alliance] = setTimeout(() => {
      this.batchTimers[alliance] = null;
      this.archiveBatch(alliance, Date.now());
      this.broadcast();
    }, this.batchTimeoutSeconds * 1000);
  }

  /** Clear all batch state. */
  private resetBatches(): void {
    for (const alliance of ['red', 'blue'] as Alliance[]) {
      this.resetBatchForAlliance(alliance);
    }
    this.recentBatches = { red: [], blue: [] };
  }

  /** Clear batch state for a single alliance. */
  private resetBatchForAlliance(alliance: Alliance): void {
    if (this.batchTimers[alliance]) {
      clearTimeout(this.batchTimers[alliance]!);
      this.batchTimers[alliance] = null;
    }
    this.activeBatches[alliance] = { events: [], startedAt: 0, active: false };
    this.recentBatches[alliance] = [];
  }

  /** Sum a set of events into per-element totals for one alliance. */
  private sumEvents(events: Iterable<ProcessedScoreEvent>, alliance: Alliance): AllianceScore {
    const elements: Record<string, ElementScore> = {};
    let total = 0;
    for (const event of events) {
      if (event.awardedTo !== alliance) continue;
      const el = elements[event.element] ?? { count: 0, points: 0, lastEventTime: 0 };
      el.count += event.count;
      el.points += event.count * event.pointValue;
      el.lastEventTime = Math.max(el.lastEventTime, event.occurredAt);
      elements[event.element] = el;
      total += event.count * event.pointValue;
    }
    return { total, elements };
  }

  /** Calculate score for the active batch of an alliance. */
  private calculateBatchScore(alliance: Alliance): AllianceScore {
    return this.sumEvents(this.activeBatches[alliance].events.filter(countsForFreePlay), alliance);
  }

  /** Calculate sliding window score for secondary display. */
  private calculateSlidingWindowScore(alliance: Alliance): AllianceScore {
    const cutoff = Date.now() - this.windowSeconds * 1000;
    return this.sumEvents(
      this.events.filter(e => countsForFreePlay(e) && e.occurredAt > cutoff),
      alliance,
    );
  }

  /** Calculate cumulative match score for an alliance (counted events only). */
  private calculateMatchScore(alliance: Alliance): AllianceScore {
    return this.sumEvents(this.events.filter(countsForMatch), alliance);
  }

  /** Calculate scores from events where the alliance's goal was off (for display). */
  private calculateInactiveScore(alliance: Alliance): AllianceScore {
    return this.sumEvents(
      this.events.filter(e => countsForFreePlay(e) && e.goalInactive),
      alliance,
    );
  }

  private calculatePhaseBreakdown(): Record<string, { red: AllianceScore; blue: AllianceScore }> {
    const phases = new Set<string>();
    for (const event of this.events) {
      if (event.matchPhase) phases.add(event.matchPhase);
    }

    const breakdown: Record<string, { red: AllianceScore; blue: AllianceScore }> = {};
    for (const phase of phases) {
      const inPhase = this.events.filter(e => countsForMatch(e) && e.matchPhase === phase);
      breakdown[phase] = {
        red: this.sumEvents(inPhase, 'red'),
        blue: this.sumEvents(inPhase, 'blue'),
      };
    }

    return breakdown;
  }

  /** Calculate per-sub-period point totals for each alliance (counted scores only). */
  private calculatePeriodBreakdown(): Record<string, { red: number; blue: number }> {
    const periods = ['auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'];
    const breakdown: Record<string, { red: number; blue: number }> = {};
    for (const p of periods) {
      breakdown[p] = { red: 0, blue: 0 };
    }

    for (const event of this.events) {
      if (!countsForMatch(event)) continue;
      if (!event.matchSubPeriod) continue;

      const period = breakdown[event.matchSubPeriod];
      if (!period) continue;
      period[event.awardedTo] += event.count * event.pointValue;
    }

    return breakdown;
  }

  /** Ensure a timer fires when the next event expires from the sliding window. */
  private ensureWindowTimer(): void {
    if (this.mode !== 'freePlay' && this.matchAlliances.size === 0) return;

    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;

    const oldest = this.events.find(e => countsForFreePlay(e) && now - e.occurredAt < windowMs);
    if (!oldest) {
      this.pruneExpiredEvents();
      if (this.windowTimer) {
        clearTimeout(this.windowTimer);
        this.windowTimer = null;
      }
      return;
    }

    const expiresAt = oldest.occurredAt + windowMs;
    const delay = expiresAt - now + 50;

    if (this.windowTimer && this.windowTimerTarget !== undefined && this.windowTimerTarget <= expiresAt) {
      return;
    }

    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimerTarget = expiresAt;
    this.windowTimer = setTimeout(
      () => {
        this.windowTimer = null;
        this.windowTimerTarget = undefined;
        this.pruneExpiredEvents();
        this.broadcast();
        this.ensureWindowTimer();
      },
      Math.max(0, delay),
    );
  }

  /** Remove events that have fallen outside the sliding window. */
  private pruneExpiredEvents(): void {
    if (this.mode !== 'freePlay' && this.matchAlliances.size === 0) return;
    const cutoff = Date.now() - this.windowSeconds * 1000;
    // Only prune freeplay alliance events — match events are kept for the match duration
    this.events = this.events.filter(e => this.matchAlliances.has(e.awardedTo) || e.occurredAt > cutoff);
  }

  /** Broadcasts are coalesced on a trailing edge: bursts of scoring events
   *  (multiple sensors, rapid balls) collapse into at most one state
   *  broadcast per window, cutting WebSocket traffic and client re-renders
   *  during heavy scoring. State is captured when the timer fires, so the
   *  final broadcast always reflects the latest events. */
  private static readonly BROADCAST_COALESCE_MS = 100;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  private broadcast(): void {
    if (this.suppressBroadcast) return;
    if (this.broadcastTimer) return; // already scheduled — it will pick up this change
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const state = this.getState();
      for (const listener of this.listeners) {
        try {
          listener(state);
        } catch (err) {
          console.error('Error in scoring state listener:', err);
        }
      }
    }, ScoringEngine.BROADCAST_COALESCE_MS);
  }
}
