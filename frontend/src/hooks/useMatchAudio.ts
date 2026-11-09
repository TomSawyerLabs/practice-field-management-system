import { useEffect, useRef } from 'react';
import type { MatchPhase, MatchEndReason, MatchState } from '../../../src/types';
import { gameOf, periodCue } from '../../../src/game/rules';
import { useMatchState, onPlayGetReady } from './useBackend';

type SoundName =
  | 'start'
  | 'end'
  | 'resume'
  | 'resume321'
  | 'warning'
  | 'abort'
  | 'pause'
  | 'countdown1'
  | 'countdown2'
  | 'countdown3'
  | 'countdown4'
  | 'getready';

const COUNTDOWN_NAMES = ['countdown1', 'countdown2', 'countdown3', 'countdown4'] as const;

/** Deterministic per-match countdown voice pick. Must match the server logic
 *  in src/matchAudio.ts so the field speaker and every open page play the
 *  same voice for a given match. */
function countdownVariant(matchId: string | undefined): SoundName {
  let h = 0;
  for (let i = 0; i < (matchId?.length ?? 0); i++) h = (h + matchId!.charCodeAt(i)) % COUNTDOWN_NAMES.length;
  return COUNTDOWN_NAMES[h];
}

/**
 * Preload sound files as HTMLAudioElement instances so playback is instant.
 * Returns null for sounds that fail to load (e.g. missing files).
 */
const sounds: Record<SoundName, HTMLAudioElement> = (() => {
  const names: SoundName[] = [
    'start',
    'end',
    'resume',
    'resume321',
    'warning',
    'abort',
    'pause',
    'getready',
    ...COUNTDOWN_NAMES,
  ];
  const map = {} as Record<SoundName, HTMLAudioElement>;
  for (const name of names) {
    const el = new Audio(`/sounds/${name}.wav`);
    el.preload = 'auto';
    map[name] = el;
  }
  return map;
})();

/** Stop any in-flight sound (used when a display is muted mid-clip). */
export function stopAllSounds(): void {
  for (const el of Object.values(sounds)) {
    el.pause();
    el.currentTime = 0;
  }
}

function play(name: SoundName): void {
  const el = sounds[name];
  if (!el) return;
  // Reset to start so rapid re-triggers work
  el.currentTime = 0;
  el.play().catch(() => {
    // Autoplay blocked — silently ignore.
    // On the match page the user will have clicked before sounds fire,
    // so this mainly guards the scoreboard on passive displays.
  });
}

/**
 * Determine which sound to play for a phase transition.
 * Mirrors the server-side logic in src/matchAudio.ts.
 */
function getSoundForTransition(
  phase: MatchPhase,
  prevPhase: MatchPhase,
  endReason?: MatchEndReason,
  matchId?: string,
  resumeEnded = false,
): SoundName | null {
  switch (phase) {
    case 'created':
      // countdown → created is an abandoned start (hold released, un-ready, or
      // abort): robots never enabled, so play the fault buzzer.
      return prevPhase === 'countdown' ? 'abort' : null;

    case 'countdown':
      // Single pre-timed "3… 2… 1… <horn>" clip: numbers at 0/1/2s, charge
      // horn baked in at the 3s mark. Voice varies per match.
      return countdownVariant(matchId);

    case 'auto':
      // countdown → auto is silent — the horn already played from countdown.wav
      if (prevPhase === 'countdown') return null;
      // A completed resume countdown is silent too: resume321.wav has the
      // "live" tone baked in at the 3s mark, which is when robots enable.
      if (prevPhase === 'paused') return resumeEnded ? null : 'resume';
      return 'start';

    case 'autoPause':
      return 'end';

    case 'teleop':
      // countdown → teleop (skipAuto) is silent — horn baked into countdown.wav
      if (prevPhase === 'countdown') return null;
      if (prevPhase === 'paused' && resumeEnded) return null;
      return 'resume';

    case 'endgame':
      if (prevPhase === 'paused') return resumeEnded ? null : 'resume';
      return 'warning';

    case 'paused':
      return 'pause';

    case 'postMatch':
      if (endReason === 'stopped' || endReason === 'estop' || endReason === 'abandoned') {
        return 'abort';
      }
      return 'end';

    default:
      return null;
  }
}

/**
 * React hook that plays match phase-transition sounds in the browser.
 *
 * Call this from any page that should produce game sounds (match control,
 * scoreboard, etc.). Uses preloaded HTMLAudioElement instances for instant
 * playback.
 *
 * Note: browsers require a prior user gesture to unlock audio. On the match
 * control page the operator will have clicked before any sound fires. On
 * passive displays (scoreboard TVs) the first sound may be silently blocked.
 */
export function useMatchAudio(
  phase: MatchPhase | undefined,
  endReason?: MatchEndReason,
  matchId?: string,
  enabled = true,
  resumeAt?: number,
): void {
  const prevPhaseRef = useRef<MatchPhase>('idle');
  const prevResumeAtRef = useRef<number | undefined>(undefined);
  // Read the latest `enabled` from within stable subscriptions/effects.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Server-broadcast "get ready" attention sound. Subscribed only while this
  // hook is mounted, so a muted display (bridge unmounted) stays silent.
  useEffect(() => onPlayGetReady(() => enabledRef.current && play('getready')), []);

  // Cut any in-flight sound the moment audio is disabled (muted mid-clip).
  useEffect(() => {
    if (!enabled) stopAllSounds();
  }, [enabled]);

  // Phase transitions and the resume countdown are handled in one effect:
  // completing a resume changes `phase` and clears `resumeAt` in the same
  // state update, and the transition sound depends on knowing that happened.
  useEffect(() => {
    if (phase === undefined) return;

    const resumeStarted = resumeAt !== undefined && prevResumeAtRef.current === undefined;
    const resumeEnded = resumeAt === undefined && prevResumeAtRef.current !== undefined;
    prevResumeAtRef.current = resumeAt;

    if (resumeStarted && enabledRef.current) play('resume321');
    if (resumeEnded && phase === 'paused') {
      // Resume cancelled — cut the countdown, drop back to the hold tone
      const el = sounds.resume321;
      el.pause();
      el.currentTime = 0;
      if (enabledRef.current) play('pause');
    }

    if (phase === prevPhaseRef.current) return;

    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    // Countdown aborted — cut the "3… 2… 1…" announcer off
    if (prev === 'countdown' && phase !== 'auto' && phase !== 'teleop') {
      for (const name of COUNTDOWN_NAMES) {
        const el = sounds[name];
        el.pause();
        el.currentTime = 0;
      }
    }

    const sound = getSoundForTransition(phase, prev, endReason, matchId, resumeEnded);
    if (sound && enabledRef.current) play(sound);
  }, [phase, endReason, matchId, resumeAt]);
}

/**
 * Plays the sound a game cues as teleop moves from one period to the next
 * (mirrors `src/matchAudio.ts`). REBUILT cues none.
 */
export function usePeriodCues(matchState: MatchState | null | undefined, enabled = true): void {
  const prevRef = useRef<string | null | undefined>(undefined);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const subPeriod = matchState?.subPeriod;
  const phase = matchState?.phase;
  const config = matchState?.config;
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = subPeriod;
    if (!config) return;
    const cue = periodCue(gameOf(config), phase, prev, subPeriod);
    if (cue && enabledRef.current) play(cue);
    // Only the sub-period moving matters; config/phase are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPeriod]);
}

/**
 * Renderless component that plays match audio. Drop into any React tree
 * that has access to the WebSocket event bus (useMatchState).
 */
export function MatchAudioBridge(): null {
  const matchState = useMatchState();
  useMatchAudio(matchState?.phase, matchState?.endReason, matchState?.matchId, true, matchState?.resumeAt);
  usePeriodCues(matchState);
  return null;
}
