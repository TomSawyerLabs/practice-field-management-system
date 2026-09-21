import { useCallback, useEffect, useState, useMemo, useRef, useSyncExternalStore, memo } from 'react';
import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import { QRCodeSVG } from 'qrcode.react';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import { TeamAvatar } from './TeamAvatar';
import SmoothieComponent from 'react-smoothie';

import {
  useScoreState,
  useMatchState,
  useTelemetryCallback,
  useWsConnected,
  sendCastReceiverRegister,
  usePublicUrl,
  matchSummaryUrl,
} from '../hooks/useBackend';
import type { Alliance, ScoreBatch, StationName, TelemetryUpdate } from '../../../src/types';
import { StationNameList } from '../../../src/types';
import { getAllianceShiftState, getAllianceScoringShifts, getMatchSubPeriod } from '../utils/shiftState';
import type { MatchSubPeriod } from '../utils/shiftState';
import { isChallengeConfig, formatName, CHALLENGE_COLOR } from '../utils/matchFormat';
import { MatchTimeline } from './MatchTimeline';
import { MatchTimer, getActiveColor } from './MatchTimer';
import { handleTelemetryUpdate, stationTimeSeries, batteryMinState } from './StationChart';
import { MatchAudioBridge, stopAllSounds } from '../hooks/useMatchAudio';

// Cast initialization happens in scores.html before this module loads.
declare global {
  interface Window {
    __castReady?: boolean;
    __castSendSwap?: (swap: boolean) => void;
    __castSendMute?: (mute: boolean) => void;
    __isCastReceiver?: boolean;
  }
}

// ── Background colour per match period ─────────────────────────────

const BG_GREEN = 'rgba(76, 175, 80, 0.12)';
const BG_GREY = 'rgba(158, 158, 158, 0.10)';
const BG_RED = 'rgba(239, 83, 80, 0.12)';
const BG_BLUE = 'rgba(66, 165, 245, 0.12)';
const BG_GOLD = 'rgba(255, 167, 38, 0.12)';
const BG_PURPLE = 'rgba(171, 71, 188, 0.12)';
const BG_BLACK = '#000';

/** Compute the match-period background color (or BG_BLACK for non-match phases). */
function getMatchBgColor(matchState: ReturnType<typeof useMatchState>): string {
  if (!matchState) return BG_BLACK;

  const { phase } = matchState;

  switch (phase) {
    case 'idle':
    case 'created':
      return BG_BLACK;
    case 'countdown':
      return BG_GREY;
    case 'auto':
      return BG_GREEN;
    case 'autoPause':
      return BG_GREY;
    case 'teleop': {
      // A challenge run has no shifts to colour by — it's green start to buzzer.
      if (isChallengeConfig(matchState.config)) return BG_GREEN;
      const inactive = getAllianceShiftState(
        phase,
        matchState.remainingTime,
        matchState.config.teleopDuration,
        matchState.config.endgameDuration,
        matchState.autoWinnerAlliance,
      );
      if (!inactive) return BG_GREEN; // transition — both active
      if (inactive === 'red') return BG_BLUE; // blue scoring
      return BG_RED; // red scoring
    }
    case 'endgame':
      return BG_GOLD;
    case 'postMatch':
      return BG_PURPLE;
    case 'paused':
      return BG_GREY;
    default:
      return BG_BLACK;
  }
}

/**
 * Build the CSS background value for the scoreboard.
 * - Both sides in match (or full freeplay): solid color.
 * - Half-freeplay: hard-stop gradient so only the match half is colored.
 */
function getScoreboardBg(
  matchState: ReturnType<typeof useMatchState>,
  leftInMatch: boolean,
  rightInMatch: boolean,
): string {
  const matchColor = getMatchBgColor(matchState);

  if (leftInMatch && rightInMatch) return matchColor;
  if (!leftInMatch && !rightInMatch) return BG_BLACK;

  // Half-freeplay: one side match color, other side black
  const leftColor = leftInMatch ? matchColor : BG_BLACK;
  const rightColor = rightInMatch ? matchColor : BG_BLACK;
  return `linear-gradient(to right, ${leftColor} 50%, ${rightColor} 50%)`;
}

function getInitialSwap(): boolean {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('swap');
  if (param !== null) return param === '1' || param === 'true';
  return localStorage.getItem('scoreboard-swap') === '1';
}

function getInitialMuted(): boolean {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('muted');
  if (param !== null) return param === '1' || param === 'true';
  return localStorage.getItem('scoreboard-muted') === '1';
}

// ── Video mode (browser-local) ──────────────────────────────────────
// The video view is configured per browser: mode and stream source live in
// localStorage, with URL params (?video=1&videoSrc=...) as overrides.

function getInitialVideoMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('video');
  if (param !== null) return param === '1' || param === 'true';
  return localStorage.getItem('scoreboard-video-mode') === '1';
}

function getInitialVideoSource(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('videoSrc') ?? localStorage.getItem('scoreboard-video-source') ?? '';
}

/** 'landscape' puts scores/status in a bar across the top (wide streams);
 *  'square' fills the height with video and puts scores/batteries in the
 *  black side bars (squarer streams). */
type VideoLayout = 'landscape' | 'square';

function getInitialVideoLayout(): VideoLayout {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('videoLayout') ?? localStorage.getItem('scoreboard-video-layout');
  return param === 'square' ? 'square' : 'landscape';
}

// ── Lite mode (browser-local) ───────────────────────────────────────
// For displays with little memory or GPU (an Android TV running the Cast
// receiver): no glow/gradient backgrounds, no colour transitions, no battery
// charts. Toggled with ?lite=1 or the "lite" control chip; persisted per
// browser. Read once — it changes what gets mounted, so a toggle reloads.

function getInitialLite(): boolean {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('lite');
  if (param !== null) return param === '1' || param === 'true';
  return localStorage.getItem('scoreboard-lite') === '1';
}

const LITE = getInitialLite();

function toggleLite() {
  localStorage.setItem('scoreboard-lite', LITE ? '0' : '1');
  const url = new URL(window.location.href);
  url.searchParams.delete('lite');
  window.location.replace(url.toString());
}

/** Phases where the countdown timer is actively counting down. */
const COUNTING_PHASES = new Set(['countdown', 'auto', 'autoPause', 'teleop', 'endgame']);

export function ScoreboardPage() {
  const score = useScoreState();
  const matchState = useMatchState();
  const [, setTick] = useState(0);
  const [swapped, setSwapped] = useState(getInitialSwap);
  const [muted, setMuted] = useState(getInitialMuted);
  const [videoMode, setVideoMode] = useState(getInitialVideoMode);
  const [videoSource, setVideoSource] = useState(getInitialVideoSource);
  const [videoLayout, setVideoLayout] = useState(getInitialVideoLayout);
  const [editingVideoSource, setEditingVideoSource] = useState(false);

  // Measured aspect ratio of the playing stream (width/height). The square
  // layout sizes the video box to exactly height×aspect so the side panels
  // absorb all leftover width instead of leaving black bars around the video.
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  useEffect(() => setVideoAspect(null), [videoSource]);
  const reportVideoAspect = useCallback((ratio: number) => {
    if (!isFinite(ratio) || ratio <= 0) return;
    setVideoAspect(prev => (prev !== null && Math.abs(prev - ratio) < 0.01 ? prev : ratio));
  }, []);

  // Top-right controls are revealed by pointer activity and fade when idle,
  // so they're findable with a mouse but don't clutter a wall-mounted display
  const [controlsActive, setControlsActive] = useState(false);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onActivity = () => {
      setControlsActive(true);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      controlsTimer.current = setTimeout(() => setControlsActive(false), 3000);
    };
    window.addEventListener('mousemove', onActivity);
    window.addEventListener('touchstart', onActivity);
    return () => {
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('touchstart', onActivity);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
    };
  }, []);

  // Track when we last received a match state for client-side time interpolation
  const matchReceivedAt = useRef(0);
  const lastMatchRef = useRef(matchState);
  if (matchState !== lastMatchRef.current) {
    lastMatchRef.current = matchState;
    matchReceivedAt.current = Date.now();
  }

  const toggleSwap = () => {
    setSwapped(s => {
      const next = !s;
      localStorage.setItem('scoreboard-swap', next ? '1' : '0');
      window.__castSendSwap?.(next);
      return next;
    });
  };

  const toggleMute = () => {
    setMuted(m => {
      const next = !m;
      // Display mute only. The server plays the field speaker itself
      // (src/matchAudio.ts) and is deliberately unaffected — muting every
      // display does not silence the field.
      localStorage.setItem('scoreboard-muted', next ? '1' : '0');
      if (next) stopAllSounds();
      window.__castSendMute?.(next);
      return next;
    });
  };

  const toggleVideoMode = () => {
    setVideoMode(v => {
      const next = !v;
      localStorage.setItem('scoreboard-video-mode', next ? '1' : '0');
      return next;
    });
  };

  const saveVideoSource = (src: string) => {
    setVideoSource(src);
    if (src) localStorage.setItem('scoreboard-video-source', src);
    else localStorage.removeItem('scoreboard-video-source');
    setEditingVideoSource(false);
  };

  const saveVideoLayout = (layout: VideoLayout) => {
    setVideoLayout(layout);
    localStorage.setItem('scoreboard-video-layout', layout);
  };

  const toggleVideoLayout = () => saveVideoLayout(videoLayout === 'square' ? 'landscape' : 'square');

  const left: Alliance = swapped ? 'blue' : 'red';
  const right: Alliance = swapped ? 'red' : 'blue';

  // Feed telemetry into the chart TimeSeries and the module-level battery
  // store WITHOUT touching page state — the battery components subscribe to
  // the store themselves, so per-packet telemetry never re-renders the page.
  useTelemetryCallback(
    useCallback((entry: TelemetryUpdate) => {
      handleTelemetryUpdate(entry);
      if (entry.batteryVoltage !== undefined) batteryStore.note(entry.station, entry.batteryVoltage);
    }, []),
  );

  // Register as a cast receiver whenever the socket (re)connects — the server
  // tracks receivers per-connection, so a reconnected socket must re-register
  const wsUp = useWsConnected();
  const swappedRef = useRef(swapped);
  swappedRef.current = swapped;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  useEffect(() => {
    if (!window.__isCastReceiver || !wsUp) return;
    // Small delay so the register lands after the state replay settles
    const timer = setTimeout(() => {
      const name = localStorage.getItem('scoreboard-device-name') || document.title || 'Cast Display';
      sendCastReceiverRegister(name, swappedRef.current, mutedRef.current);
    }, 1000);
    return () => clearTimeout(timer);
  }, [wsUp]);

  // Re-render every second for time-ago displays and alliance shift timing
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Prevent screen from sleeping (TV screensaver)
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const acquire = () =>
      navigator.wakeLock
        ?.request('screen')
        .then(wl => {
          wakeLock = wl;
        })
        .catch(() => {});
    acquire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      wakeLock?.release();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /** Is this alliance's scoring currently counting? Mirrors backend isGoalActive
   *  including the 3-second grace period after a goal turns off. */
  const isScoringActive = useCallback(
    (alliance: Alliance): boolean => {
      if (!matchState) return true;
      if (matchState.phase !== 'teleop') return true;
      // No shifts in a challenge run — both goals stay live the whole window.
      if (isChallengeConfig(matchState.config)) return true;

      const inactive = getAllianceShiftState(
        matchState.phase,
        matchState.remainingTime,
        matchState.config.teleopDuration,
        matchState.config.endgameDuration,
        matchState.autoWinnerAlliance,
      );
      if (inactive !== alliance) return true;

      // Currently inactive — check 3-second grace
      const graceRemaining = matchState.remainingTime + 3;
      const inactiveAtGrace = getAllianceShiftState(
        'teleop',
        graceRemaining,
        matchState.config.teleopDuration,
        matchState.config.endgameDuration,
        matchState.autoWinnerAlliance,
      );
      return inactiveAtGrace !== alliance;
    },
    [matchState],
  );

  const autoWinner = matchState?.autoWinnerAlliance ?? null;
  // An alliance is "in match" if the scoring engine says so
  const matchAlliances = score?.matchAlliances ?? [];
  const isMatchMode = score?.mode === 'match';
  const leftInMatch = matchAlliances.includes(left);
  const rightInMatch = matchAlliances.includes(right);

  // Client-interpolated remaining time — subtracts elapsed client time since last server update.
  // Keeps the timer smooth between 250ms server ticks. Uses setTick to re-evaluate each second.
  const displayRemaining = (() => {
    if (!matchState) return 0;
    const { phase, remainingTime } = matchState;
    if (phase === 'paused' || !COUNTING_PHASES.has(phase)) return remainingTime;
    const elapsed = (Date.now() - matchReceivedAt.current) / 1000;
    return Math.max(0, remainingTime - elapsed);
  })();

  // Timer colour and pulse for match mode
  const activeColor = matchState ? getActiveColor(matchState) : '#9e9e9e';
  const isActivePeriod =
    matchState &&
    (matchState.phase === 'auto' ||
      matchState.phase === 'teleop' ||
      matchState.phase === 'endgame' ||
      matchState.phase === 'countdown');
  const shouldPulse = !!(isActivePeriod && matchState && displayRemaining > 0 && displayRemaining <= 3);

  // Match timeline progress (0-1) — shown whenever any alliance is in a match
  const anyMatchActive = matchAlliances.length > 0;
  const matchProgress = useMemo(() => {
    if (!matchState || !anyMatchActive) return null;
    const { phase } = matchState;
    if (phase === 'idle' || phase === 'created') return null;
    const cfg = matchState.config;
    const countdownDuration = 3;
    const barTotal = cfg.autoDuration + cfg.pauseDuration + cfg.teleopDuration;
    if (barTotal <= 0) return null;
    const elapsed = Math.max(0, matchState.totalMatchTime - countdownDuration);
    if (cfg.skipAuto) {
      const skipOffset = cfg.autoDuration + cfg.pauseDuration;
      return Math.min(1, (skipOffset + elapsed) / barTotal);
    }
    return Math.min(1, elapsed / barTotal);
  }, [matchState, anyMatchActive]);

  // Current sub-period for period breakdown highlight / future detection
  // (must be before the early return so hook count is stable)
  const currentSubPeriod: MatchSubPeriod | null = useMemo(() => {
    if (!matchState || !isMatchMode) return null;
    if (isChallengeConfig(matchState.config)) return null;
    return getMatchSubPeriod(matchState.phase, displayRemaining, matchState.config.teleopDuration);
  }, [matchState, isMatchMode, displayRemaining]);

  // Background — split when only one side is in a match
  const scoreboardBg = getScoreboardBg(matchState, leftInMatch, rightInMatch);

  if (!score) {
    return (
      <>
        {!muted && <MatchAudioBridge />}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: window.__isCastReceiver ? '100vh' : '100dvh',
            bgcolor: '#000',
          }}
        >
          <Typography variant="h4" color="text.secondary">
            Connecting...
          </Typography>
        </Box>
      </>
    );
  }

  const isFreePlay = score.mode === 'freePlay';

  // Desaturation: match alliances desaturate when scoring stops counting
  // (after the 3-second grace period); freeplay alliances desaturate on batch timeout
  const leftBatchActive = left === 'red' ? score.redBatchActive : score.blueBatchActive;
  const rightBatchActive = right === 'red' ? score.redBatchActive : score.blueBatchActive;
  const leftActive = leftInMatch ? isScoringActive(left) : isFreePlay ? leftBatchActive : true;
  const rightActive = rightInMatch ? isScoringActive(right) : isFreePlay ? rightBatchActive : true;

  const leftBatches = score.recentBatches?.[left] ?? [];
  const rightBatches = score.recentBatches?.[right] ?? [];

  // Inactive scores for match alliances
  const leftInactive = score.inactiveScores?.[left]?.total ?? 0;
  const rightInactive = score.inactiveScores?.[right]?.total ?? 0;

  // Title text
  const titleText = isMatchMode
    ? (score.matchPhase ?? 'Match')
        .toString()
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toUpperCase()
    : 'FREE PLAY';

  // Freeplay-side labels for half-freeplay mode
  const leftLabel = isMatchMode && !leftInMatch ? 'FREE PLAY' : null;
  const rightLabel = isMatchMode && !rightInMatch ? 'FREE PLAY' : null;

  // Stable primitive keys for the memoized battery components — matchState and
  // score object identities change several times a second; these strings only
  // change when the underlying assignments actually change, so the memoized
  // battery tree skips those re-renders entirely.
  const stationKey = stationInfoKey(matchState);
  const matchAlliancesKey = matchAlliances.join(',');

  // Match progress bar for the video layouts — overlaid on the video's top edge
  // (rather than a flow strip) so a starting match never reflows the page.
  const videoTimelineOverlay = (
    <VideoTimelineOverlay
      matchState={matchState}
      matchProgress={matchProgress}
      autoWinner={autoWinner}
      remainingTime={displayRemaining}
    />
  );

  return (
    <Box
      sx={{
        position: 'relative',
        isolation: 'isolate',
        display: 'flex',
        flexDirection: 'column',
        height: window.__isCastReceiver ? '100vh' : '100dvh',
        background: scoreboardBg,
        color: '#fff',
        userSelect: 'none',
        transition: LITE ? 'none' : 'background 1s ease',
      }}
    >
      {/* Match sounds — unmounted entirely while this display is muted */}
      {!muted && <MatchAudioBridge />}

      {/* Freeplay score-reactive glow backgrounds (skipped in lite mode) */}
      {isFreePlay && !LITE && (
        <FreeplayGlow
          leftScore={score[left].total}
          rightScore={score[right].total}
          leftAlliance={left}
          rightAlliance={right}
        />
      )}

      {/* Controls — top right, revealed by mouse/touch activity (hidden on Chromecast receiver) */}
      {!window.__isCastReceiver && (
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            right: 16,
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            zIndex: 2,
            opacity: controlsActive ? 1 : 0.2,
            transition: 'opacity 0.5s ease',
          }}
        >
          <ControlChip
            icon="🎥"
            label={videoMode ? 'video on' : 'video'}
            active={videoMode}
            onClick={toggleVideoMode}
          />
          {videoMode && (
            <ControlChip
              icon={videoLayout === 'square' ? '▯' : '▭'}
              label={videoLayout === 'square' ? 'square' : 'wide'}
              onClick={toggleVideoLayout}
            />
          )}
          <ControlChip icon="⇄" label="swap" onClick={toggleSwap} />
          <ControlChip icon="🪶" label={LITE ? 'lite on' : 'lite'} active={LITE} onClick={toggleLite} />
          <ControlChip
            icon={muted ? '🔇' : '🔊'}
            label={muted ? 'muted' : 'sound'}
            active={muted}
            onClick={toggleMute}
          />
          {window.__castReady && (
            <google-cast-launcher style={{ width: 24, height: 24, cursor: 'pointer', opacity: 0.5 }} />
          )}
        </Box>
      )}

      {/* Match timeline progress bar — full width across top (normal mode only;
          the video layouts overlay it on the video to avoid reflow) */}
      {!videoMode && matchProgress !== null && matchState && (
        <Box sx={{ px: 0 }}>
          <MatchTimeline
            config={matchState.config}
            progress={matchProgress}
            autoWinnerAlliance={autoWinner}
            phase={matchState.phase}
            remainingTime={displayRemaining}
          />
        </Box>
      )}

      {videoMode ? (
        videoLayout === 'square' ? (
          /* Square layout — video fills the height; scores and batteries live
             in the black side bars, timer overlays the top of the video */
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1, px: 1, py: 1 }}>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1.5,
                pt: 1,
                minWidth: 190,
                overflowY: 'auto',
                // Absorb the width the aspect-sized video box doesn't use
                flex: videoAspect ? '1 1 0' : '0 0 auto',
              }}
            >
              <AllianceScoreBox
                compact
                alliance={left}
                total={score[left].total}
                active={leftActive}
                inactiveTotal={leftInMatch ? leftInactive : undefined}
                freePlayLabel={leftLabel}
                isAutoWinner={isMatchMode && autoWinner === left}
                isFreePlay={isFreePlay}
                side="left"
              />
              <BatteryGroup
                side="left"
                stationKey={stationKey}
                leftAlliance={left}
                matchAlliancesKey={matchAlliancesKey}
                vertical
              />
            </Box>
            <Box
              sx={{
                minWidth: 0,
                // Once the stream's aspect ratio is known, size the video box
                // to exactly fill the height — the flexing side panels then
                // soak up all remaining width (no black bars around the video)
                ...(videoAspect ? { flex: '0 1 auto', height: '100%', aspectRatio: String(videoAspect) } : { flex: 1 }),
              }}
            >
              <VideoArea
                source={videoSource}
                editing={editingVideoSource}
                onEditStart={() => setEditingVideoSource(true)}
                onSave={saveVideoSource}
                onCancelEdit={() => setEditingVideoSource(false)}
                layout={videoLayout}
                onLayoutChange={saveVideoLayout}
                onAspectRatio={reportVideoAspect}
                timelineOverlay={videoTimelineOverlay}
              >
                {/* Title + timer overlaid on the video, below the timeline bar */}
                <Box
                  sx={{
                    position: 'absolute',
                    top: 52,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    pointerEvents: 'none',
                    zIndex: 1,
                    textShadow: '0 0 8px rgba(0,0,0,0.9), 0 0 16px rgba(0,0,0,0.8)',
                  }}
                >
                  <Typography
                    sx={{
                      color: isMatchMode && matchState ? activeColor : 'rgba(255,255,255,0.6)',
                      textTransform: 'uppercase',
                      letterSpacing: 3,
                      fontWeight: 800,
                      fontSize: 'clamp(0.7rem, 1.2vw, 0.95rem)',
                      whiteSpace: 'nowrap',
                      transition: 'color 1s ease',
                    }}
                  >
                    {titleText}
                  </Typography>
                  {isMatchMode && matchState && matchProgress !== null && (
                    <CenterMatchDisplay
                      matchState={matchState}
                      remainingTime={displayRemaining}
                      color={activeColor}
                      pulse={shouldPulse}
                      fontSize="clamp(1.6rem, 3.5vw, 2.8rem)"
                    />
                  )}
                </Box>
              </VideoArea>
            </Box>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1.5,
                pt: 1,
                minWidth: 190,
                overflowY: 'auto',
                // Absorb the width the aspect-sized video box doesn't use
                flex: videoAspect ? '1 1 0' : '0 0 auto',
              }}
            >
              <AllianceScoreBox
                compact
                alliance={right}
                total={score[right].total}
                active={rightActive}
                inactiveTotal={rightInMatch ? rightInactive : undefined}
                freePlayLabel={rightLabel}
                isAutoWinner={isMatchMode && autoWinner === right}
                isFreePlay={isFreePlay}
                side="right"
              />
              <BatteryGroup
                side="right"
                stationKey={stationKey}
                leftAlliance={left}
                matchAlliancesKey={matchAlliancesKey}
                vertical
              />
            </Box>
          </Box>
        ) : (
          <>
            {/* Landscape layout — compact header on top: batteries flank the scores, timer in the middle */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1 }}>
              <BatteryGroup
                side="left"
                stationKey={stationKey}
                leftAlliance={left}
                matchAlliancesKey={matchAlliancesKey}
                align="right"
              />
              <AllianceScoreBox
                compact
                reserveDecor
                alliance={left}
                total={score[left].total}
                active={leftActive}
                inactiveTotal={leftInMatch ? leftInactive : undefined}
                freePlayLabel={leftLabel}
                isAutoWinner={isMatchMode && autoWinner === left}
                isFreePlay={isFreePlay}
                side="left"
              />
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 90 }}>
                <Typography
                  sx={{
                    color: isMatchMode && matchState ? activeColor : 'rgba(255,255,255,0.5)',
                    textTransform: 'uppercase',
                    letterSpacing: 3,
                    fontWeight: 800,
                    fontSize: 'clamp(0.7rem, 1.3vw, 1rem)',
                    whiteSpace: 'nowrap',
                    transition: 'color 1s ease',
                  }}
                >
                  {titleText}
                </Typography>
                {/* Always mounted (faded when idle) so the header height — and
                    thus the video below — doesn't shift when a match starts. */}
                <Box
                  sx={{
                    opacity: isMatchMode && matchState && matchProgress !== null ? 1 : 0,
                    transition: 'opacity 0.8s ease',
                  }}
                >
                  <CenterMatchDisplay
                    matchState={matchState}
                    remainingTime={displayRemaining}
                    color={activeColor}
                    pulse={shouldPulse}
                    fontSize="clamp(1.8rem, 4vw, 3.2rem)"
                  />
                </Box>
              </Box>
              <AllianceScoreBox
                compact
                reserveDecor
                alliance={right}
                total={score[right].total}
                active={rightActive}
                inactiveTotal={rightInMatch ? rightInactive : undefined}
                freePlayLabel={rightLabel}
                isAutoWinner={isMatchMode && autoWinner === right}
                isFreePlay={isFreePlay}
                side="right"
              />
              <BatteryGroup
                side="right"
                stationKey={stationKey}
                leftAlliance={left}
                matchAlliancesKey={matchAlliancesKey}
                align="left"
              />
            </Box>

            {/* Video area — fills everything below the score header */}
            <Box sx={{ flex: 1, minHeight: 0, mx: 1, mb: 1 }}>
              <VideoArea
                source={videoSource}
                editing={editingVideoSource}
                onEditStart={() => setEditingVideoSource(true)}
                onSave={saveVideoSource}
                onCancelEdit={() => setEditingVideoSource(false)}
                layout={videoLayout}
                onLayoutChange={saveVideoLayout}
                onAspectRatio={reportVideoAspect}
                timelineOverlay={videoTimelineOverlay}
              />
            </Box>
          </>
        )
      ) : (
        <>
          {/* Title bar at top */}
          <Box sx={{ pt: 2, pb: 1, textAlign: 'center' }}>
            <Typography
              sx={{
                color: isMatchMode && matchState ? activeColor : 'rgba(255,255,255,0.5)',
                textTransform: 'uppercase',
                letterSpacing: 6,
                fontWeight: 800,
                fontSize: 'clamp(1.2rem, 3vw, 2rem)',
                textAlign: 'center',
                transition: 'color 1s ease',
              }}
            >
              {titleText}
            </Typography>
            {isFreePlay && (
              <Typography
                sx={{
                  color: 'rgba(255,255,255,0.35)',
                  fontSize: 'clamp(0.7rem, 1.5vw, 1rem)',
                  mt: 0.25,
                }}
              >
                Scores reset after {score.batchTimeoutSeconds}s of inactivity
              </Typography>
            )}
          </Box>

          {/* Main score display — forced 50/50 split with period breakdowns on outside */}
          <Box
            sx={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
              alignItems: 'center',
              // Tighter than before so the flanking period-breakdown columns keep
              // enough width to render their labels without clipping at the edges.
              px: 'max(10px, 1.5vw)',
              minHeight: 0,
            }}
          >
            {/* Left alliance — flanking info + score box */}
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center',
                pr: 1.5,
                gap: 1.5,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              {isFreePlay && leftBatches.length > 0 && (
                <BatchList batches={leftBatches} color={left === 'red' ? '#ef5350' : '#42a5f5'} align="right" />
              )}
              {isMatchMode && leftInMatch && score.periodBreakdown && (
                <PeriodBreakdown
                  alliance={left}
                  breakdown={score.periodBreakdown}
                  autoWinner={autoWinner}
                  currentSubPeriod={currentSubPeriod}
                  align="right"
                />
              )}
              <AllianceScoreBox
                alliance={left}
                total={score[left].total}
                active={leftActive}
                inactiveTotal={leftInMatch ? leftInactive : undefined}
                freePlayLabel={leftLabel}
                isAutoWinner={isMatchMode && autoWinner === left}
                isFreePlay={isFreePlay}
                side="left"
              />
            </Box>

            {/* Center panel */}
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, minWidth: 120 }}>
              {/* Match countdown timer */}
              {isMatchMode && matchState && matchProgress !== null && (
                <CenterMatchDisplay
                  matchState={matchState}
                  remainingTime={displayRemaining}
                  color={activeColor}
                  pulse={shouldPulse}
                  fontSize="clamp(2.5rem, 6vw, 5rem)"
                />
              )}
            </Box>

            {/* Right alliance — score box + period breakdown */}
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'flex-start',
                alignItems: 'center',
                pl: 1.5,
                gap: 1.5,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <AllianceScoreBox
                alliance={right}
                total={score[right].total}
                active={rightActive}
                inactiveTotal={rightInMatch ? rightInactive : undefined}
                freePlayLabel={rightLabel}
                isAutoWinner={isMatchMode && autoWinner === right}
                isFreePlay={isFreePlay}
                side="right"
              />
              {isMatchMode && rightInMatch && score.periodBreakdown && (
                <PeriodBreakdown
                  alliance={right}
                  breakdown={score.periodBreakdown}
                  autoWinner={autoWinner}
                  currentSubPeriod={currentSubPeriod}
                  align="left"
                />
              )}
              {isFreePlay && rightBatches.length > 0 && (
                <BatchList batches={rightBatches} color={right === 'red' ? '#ef5350' : '#42a5f5'} align="left" />
              )}
            </Box>
          </Box>

          {/* Battery voltage for connected robots */}
          <BatteryPanel stationKey={stationKey} leftAlliance={left} matchAlliancesKey={matchAlliancesKey} />
        </>
      )}
    </Box>
  );
}

/** The center of the scoreboard: the running match timer, or — once the match
 *  is over — the QR code to this match's summary and video, in the same spot
 *  (no point showing a timer sitting at 0). */
function CenterMatchDisplay({
  matchState,
  remainingTime,
  color,
  pulse,
  fontSize,
}: {
  matchState: ReturnType<typeof useMatchState>;
  remainingTime: number;
  color: string;
  pulse: boolean;
  fontSize: string;
}) {
  if (matchState?.phase === 'postMatch' && matchState.shareToken) {
    return <PostMatchQR token={matchState.shareToken} />;
  }
  const timer = <MatchTimer remainingTime={remainingTime} color={color} pulse={pulse} fontSize={fontSize} />;
  if (!isChallengeConfig(matchState?.config)) return timer;
  // The crowd is looking at a clock that isn't a match clock — say so, or the
  // TV reads as a 0–0 match that ended early.
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25 }}>
      <Box
        sx={{
          color: CHALLENGE_COLOR,
          fontWeight: 800,
          letterSpacing: '0.12em',
          fontSize: 'clamp(0.7rem, 1.4vw, 1.1rem)',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {formatName(matchState?.config)}
      </Box>
      {timer}
    </Box>
  );
}

/** After the match: a QR code to this match's summary + video, so a drive team
 *  can scan it off the TV with any phone (works from the internet too). Shown
 *  centered where the timer was. */
function PostMatchQR({ token }: { token: string }) {
  const publicUrl = usePublicUrl();
  const url = matchSummaryUrl(publicUrl, token);
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.75,
        bgcolor: '#fff',
        color: '#000',
        p: 1.5,
        borderRadius: 2,
        boxShadow: 6,
      }}
    >
      <QRCodeSVG value={url} size={150} marginSize={0} />
      <Box sx={{ fontWeight: 700, fontSize: '0.85rem', textAlign: 'center', maxWidth: 200 }}>
        Scan for match summary &amp; video
      </Box>
    </Box>
  );
}

// ── Freeplay Glow ─────────────────────────────────────────────────────

const GLOW_RGB = { red: '239, 83, 80', blue: '66, 165, 245' } as const;

function FreeplayGlowImpl({
  leftScore,
  rightScore,
  leftAlliance,
  rightAlliance,
}: {
  leftScore: number;
  rightScore: number;
  leftAlliance: Alliance;
  rightAlliance: Alliance;
}) {
  return (
    <Box sx={{ position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none', overflow: 'hidden' }}>
      <GlowSpot score={leftScore} alliance={leftAlliance} side="left" />
      <GlowSpot score={rightScore} alliance={rightAlliance} side="right" />
    </Box>
  );
}

function GlowSpot({ score, alliance, side }: { score: number; alliance: Alliance; side: 'left' | 'right' }) {
  if (score <= 0) return null;

  const rgb = GLOW_RGB[alliance];
  // Normalized intensity 0→1 over the 0→400 range
  const t = Math.min(1, score / 400);

  // Core glow parameters — scale with score intensity
  const radius = 15 + t * 55; // 15% → 70%
  const opacity = 0.04 + t * 0.36; // 0.04 → 0.40
  const pulseDuration = 12 - t * 5; // 12 s → 7 s (gentle breathing)
  const pulseScale = 1 + t * 0.08; // 1.0× → 1.08× (subtle)

  // Wander parameters — gentle drift, not jumpy
  const w = 1 + t * 2.5; // 1% → 3.5% wander range
  const wanderDuration = 40 - t * 10; // 40 s → 30 s

  const cx = side === 'left' ? '25%' : '75%';

  // Primary gradient: multi-stop for natural radiance
  const layers = [
    `radial-gradient(circle at ${cx} 50%, rgba(${rgb}, ${opacity}) 0%, rgba(${rgb}, ${opacity * 0.4}) ${radius * 0.5}%, rgba(${rgb}, ${opacity * 0.1}) ${radius * 0.8}%, transparent ${radius}%)`,
  ];

  // Secondary haze layer at higher scores (>100 pts)
  if (t > 0.25) {
    const hazeOpacity = (t - 0.25) * 0.12;
    layers.unshift(
      `radial-gradient(circle at ${cx} 50%, rgba(${rgb}, ${hazeOpacity}) 0%, transparent ${radius * 1.5}%)`,
    );
  }

  // Outer element wanders, inner element pulses.
  // Pad beyond the container so the wander translate never exposes a gap at the edges.
  const pad = Math.ceil(w * 1.2); // enough to cover max wander displacement
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: `-${pad}%`,
        '@keyframes glowWander': {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '25%': { transform: `translate(${w * 0.6}%, ${-w * 0.4}%)` },
          '50%': { transform: `translate(${-w * 0.5}%, ${w * 0.3}%)` },
          '75%': { transform: `translate(${-w * 0.3}%, ${-w * 0.6}%)` },
        },
        animation: `glowWander ${wanderDuration}s ease-in-out infinite`,
      }}
    >
      <Box
        sx={{
          width: '100%',
          height: '100%',
          background: layers.join(', '),
          transformOrigin: `${cx} 50%`,
          '@keyframes glowPulse': {
            '0%, 100%': { transform: 'scale(1)' },
            '50%': { transform: `scale(${pulseScale})` },
          },
          animation: `glowPulse ${pulseDuration}s ease-in-out infinite`,
        }}
      />
    </Box>
  );
}

// ── Battery Panel ────────────────────────────────────────────────────

/** Per-station battery state tracked from telemetry. */
interface BatteryInfo {
  current: number;
  lastSeen: number;
}

interface BatteryRobot {
  station: StationName;
  teamNumber: number | null;
  alliance: Alliance | null;
  ssid: string | null;
  battery: BatteryInfo;
}

// Module-level battery store. With six robots, telemetry arrives many times a
// second, and routing it through page state re-rendered the entire scoreboard
// per packet. Battery components subscribe here via useSyncExternalStore and
// re-render at most once per UI interval; the rest of the page never sees the
// traffic.
const BATTERY_UI_INTERVAL_MS = 900;
const BATTERY_STALE_MS = 15_000;
const batteryStore = {
  data: {} as Partial<Record<StationName, BatteryInfo>>,
  version: 0,
  listeners: new Set<() => void>(),
  bumpTimer: null as ReturnType<typeof setTimeout> | null,
  note(station: StationName, voltage: number) {
    batteryStore.data[station] = { current: voltage, lastSeen: Date.now() };
    if (batteryStore.bumpTimer) return;
    batteryStore.bumpTimer = setTimeout(() => {
      batteryStore.bumpTimer = null;
      batteryStore.bump();
    }, BATTERY_UI_INTERVAL_MS);
  },
  bump() {
    batteryStore.version++;
    for (const listener of batteryStore.listeners) listener();
  },
  subscribe(listener: () => void) {
    batteryStore.listeners.add(listener);
    return () => batteryStore.listeners.delete(listener);
  },
  getVersion() {
    return batteryStore.version;
  },
};

// Staleness sweep — retire cards for robots that stopped reporting even when
// no new telemetry arrives to trigger a bump
setInterval(() => {
  const now = Date.now();
  for (const station of StationNameList) {
    const info = batteryStore.data[station];
    if (info && now - info.lastSeen > BATTERY_STALE_MS) {
      delete batteryStore.data[station];
      if (!batteryStore.bumpTimer) batteryStore.bump();
    }
  }
}, 5_000);

/** Per-station identity info the battery list needs from match state, encoded
 *  as a stable string so the 4 Hz matchState ticks don't churn memo/prop
 *  identities in the battery components. */
function stationInfoKey(matchState: ReturnType<typeof useMatchState>): string {
  return StationNameList.map(s => {
    const st = matchState?.stationStates?.[s];
    return `${s}:${st?.teamNumber ?? ''}:${st?.alliance ?? ''}`;
  }).join('|');
}

/** Sorted battery robot list + duplicate-team counts, driven by the battery
 *  store (updates at most ~1 Hz). */
function useBatteryRobots(stationKey: string, leftAlliance: Alliance) {
  const version = useSyncExternalStore(batteryStore.subscribe, batteryStore.getVersion);

  return useMemo(() => {
    const infoByStation = new Map<string, { teamNumber: number | null; alliance: Alliance | null }>();
    for (const part of stationKey.split('|')) {
      const [station, team, alliance] = part.split(':');
      infoByStation.set(station, {
        teamNumber: team ? Number(team) : null,
        alliance: (alliance || null) as Alliance | null,
      });
    }

    const now = Date.now();
    const robots: BatteryRobot[] = [];
    for (const station of StationNameList) {
      const batt = batteryStore.data[station];
      if (!batt || now - batt.lastSeen > BATTERY_STALE_MS) continue;
      const info = infoByStation.get(station);
      robots.push({
        station,
        teamNumber: info?.teamNumber ?? null,
        alliance: info?.alliance ?? null,
        ssid: null,
        battery: batt,
      });
    }

    // Sort: left alliance, then unassigned in the middle, then right alliance
    const rightAlliance = leftAlliance === 'red' ? 'blue' : 'red';
    robots.sort((a, b) => {
      const order = (ally: Alliance | null) => (ally === leftAlliance ? 0 : ally === rightAlliance ? 2 : 1);
      return order(a.alliance) - order(b.alliance);
    });

    // Detect duplicate team numbers to show station name as disambiguator
    const teamCounts = new Map<number, number>();
    for (const r of robots) {
      if (r.teamNumber) teamCounts.set(r.teamNumber, (teamCounts.get(r.teamNumber) ?? 0) + 1);
    }

    return { robots, teamCounts };
  }, [version, stationKey, leftAlliance]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Static chart options hoisted so each render doesn't rebuild them
const BATTERY_CHART_GRID = {
  borderVisible: false,
  fillStyle: 'transparent',
  strokeStyle: 'rgba(255,255,255,0.05)',
  verticalSections: 1,
  millisPerLine: 0,
};
const BATTERY_CHART_LABELS = { disabled: true };
const BATTERY_CHART_TITLE = { text: '' };
const emptyChartLabel = () => '';

/** Single robot battery card — voltage chart with team/voltage overlay. */
function BatteryCard({
  robot,
  inMatch,
  isDuplicate,
  compact,
  fill,
}: {
  robot: BatteryRobot;
  /** Robots participating in a match get alliance colors; non-participants get white */
  inMatch: boolean;
  isDuplicate: boolean;
  /** Smaller card for the video-mode header row */
  compact?: boolean;
  /** Flex to share the row's width (with a max) instead of a fixed width, so the
   *  bottom panel keeps every robot on one row rather than wrapping. */
  fill?: boolean;
}) {
  const color = inMatch ? (robot.alliance === 'red' ? '#ef5350' : '#42a5f5') : 'rgba(255,255,255,0.5)';
  const bgColor = inMatch
    ? robot.alliance === 'red'
      ? 'rgba(239,83,80,0.10)'
      : 'rgba(66,165,245,0.10)'
    : 'rgba(255,255,255,0.05)';
  const ts = stationTimeSeries[robot.station];
  const minFloor = batteryMinState[robot.station]?.floor;
  const chartHeight = compact ? 40 : 52;

  const series = useMemo(
    () => [
      {
        data: ts.batteryVoltage,
        strokeStyle: color,
        lineWidth: 1.5,
      },
      {
        data: ts.batteryMinVoltage,
        strokeStyle: 'rgba(244, 67, 54, 0.6)',
        fillStyle: 'rgba(244, 67, 54, 0.08)',
        lineWidth: 1,
      },
    ],
    [ts, color],
  );

  return (
    <Box
      sx={{
        border: `1px solid ${color}`,
        borderRadius: 1,
        backgroundColor: bgColor,
        // Fill mode: equal flex columns capped at a max, so N robots always share
        // one row (never wrap, which would break the red→blue left-right order).
        // Inline-size container so the header can drop the least-critical figure
        // when a card gets narrow. Otherwise a fixed width (video-mode groups).
        ...(fill
          ? { flex: '1 1 0', minWidth: 0, maxWidth: compact ? 170 : 190, containerType: 'inline-size' }
          : { width: compact ? 170 : 180 }),
        overflow: 'hidden',
      }}
    >
      {/* Team above, voltages below the chart — two full-width rows so a long
          team number can never collide with the voltage figures on a narrow card */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.5,
          px: 0.75,
          pt: 0.25,
          minWidth: 0,
        }}
      >
        <TeamAvatar teamNumber={robot.teamNumber} size={16} />
        <Typography
          noWrap
          sx={{
            fontSize: compact ? '0.8rem' : '0.9rem',
            fontWeight: 700,
            color: 'rgba(255,255,255,0.7)',
            minWidth: 0,
            '@container (max-width: 150px)': { fontSize: '0.8rem' },
          }}
        >
          {robot.teamNumber ?? robot.station}
          {isDuplicate && (
            <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: 400, fontSize: '0.7rem' }}>
              {' '}
              ({robot.station.replace('slot', '#')})
            </span>
          )}
        </Typography>
      </Box>
      {LITE ? (
        <Box sx={{ height: chartHeight, display: 'flex', alignItems: 'flex-end', px: 0.75 }}>
          <Box
            sx={{
              height: '60%',
              width: `${Math.max(0, Math.min(100, (((robot.battery?.current ?? 0) - 5) / 9) * 100))}%`,
              bgcolor: color,
              opacity: 0.6,
              borderRadius: 0.5,
            }}
          />
        </Box>
      ) : (
        <Box sx={{ '& canvas': { display: 'block', height: `${chartHeight}px !important` } }}>
          <SmoothieComponent
            responsive
            height={chartHeight}
            streamDelay={-1000}
            millisPerPixel={200}
            minValue={5}
            maxValue={14}
            limitFPS={15}
            grid={BATTERY_CHART_GRID}
            labels={BATTERY_CHART_LABELS}
            title={BATTERY_CHART_TITLE}
            yMinFormatter={emptyChartLabel}
            yMaxFormatter={emptyChartLabel}
            yIntermediateFormatter={emptyChartLabel}
            series={series}
          />
        </Box>
      )}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'center',
          gap: 1,
          px: 0.75,
          pb: 0.25,
        }}
      >
        <Typography
          sx={{
            fontFamily: 'monospace',
            fontSize: compact ? '1rem' : '1.1rem',
            fontWeight: 700,
            color,
            whiteSpace: 'nowrap',
            '@container (max-width: 150px)': { fontSize: '0.95rem' },
          }}
        >
          {robot.battery.current.toFixed(1)}V
        </Typography>
        {!isNaN(minFloor) && (
          <Typography
            sx={{
              fontFamily: 'monospace',
              fontSize: compact ? '0.7rem' : '0.8rem',
              color: 'rgba(244, 67, 54, 0.8)',
              whiteSpace: 'nowrap',
              // Least-critical figure — drop it before the card gets so tight it
              // would clip the current voltage.
              '@container (max-width: 110px)': { display: 'none' },
            }}
          >
            ↓{minFloor.toFixed(1)}V
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/** Split the sorted robot list into left/right flanks: alliance robots go to
 *  their side, unassigned ones balance onto whichever has fewer. Deterministic,
 *  so both flanking groups compute the same split independently. */
function splitBatteryRobots(robots: BatteryRobot[], leftAlliance: Alliance): [BatteryRobot[], BatteryRobot[]] {
  const rightAlliance = leftAlliance === 'red' ? 'blue' : 'red';
  const leftRobots: BatteryRobot[] = [];
  const rightRobots: BatteryRobot[] = [];
  for (const r of robots) {
    if (r.alliance === leftAlliance) leftRobots.push(r);
    else if (r.alliance === rightAlliance) rightRobots.push(r);
    else (leftRobots.length <= rightRobots.length ? leftRobots : rightRobots).push(r);
  }
  return [leftRobots, rightRobots];
}

/** Flanking battery group for video mode. Subscribes to the battery store
 *  itself (memoized — the page's fast-ticking renders don't reach it).
 *  Horizontal rows render as flex spacers even when empty so the score boxes
 *  stay centered; `vertical` stacks the cards for the square layout's side
 *  bars. */
const BatteryGroup = memo(function BatteryGroup({
  side,
  stationKey,
  leftAlliance,
  matchAlliancesKey,
  align,
  vertical,
}: {
  side: 'left' | 'right';
  stationKey: string;
  leftAlliance: Alliance;
  matchAlliancesKey: string;
  align?: 'left' | 'right';
  vertical?: boolean;
}) {
  const { robots, teamCounts } = useBatteryRobots(stationKey, leftAlliance);
  const [leftRobots, rightRobots] = splitBatteryRobots(robots, leftAlliance);
  const mine = side === 'left' ? leftRobots : rightRobots;
  const matchAlliances = matchAlliancesKey ? (matchAlliancesKey.split(',') as Alliance[]) : [];

  return (
    <Box
      sx={
        vertical
          ? { display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }
          : {
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
              justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
              alignItems: 'center',
            }
      }
    >
      {mine.map(robot => (
        <BatteryCard
          key={robot.station}
          robot={robot}
          compact
          inMatch={robot.alliance != null && matchAlliances.includes(robot.alliance)}
          isDuplicate={robot.teamNumber ? (teamCounts.get(robot.teamNumber) ?? 0) > 1 : false}
        />
      ))}
    </Box>
  );
});

/** Bottom battery row for the normal scoreboard. Subscribes to the battery
 *  store itself (memoized — see BatteryGroup). */
const BatteryPanel = memo(function BatteryPanel({
  stationKey,
  leftAlliance,
  matchAlliancesKey,
}: {
  stationKey: string;
  leftAlliance: Alliance;
  matchAlliancesKey: string;
}) {
  const { robots, teamCounts } = useBatteryRobots(stationKey, leftAlliance);
  const matchAlliances = matchAlliancesKey ? (matchAlliancesKey.split(',') as Alliance[]) : [];
  if (robots.length === 0) return null;

  // Single row, never wrapping: the cards are sorted red → unassigned → blue to
  // read left-to-right in line with the score boxes, and a wrapped second row
  // would break that grouping. The `fill` cards flex to share the width (capped),
  // shrinking to fit however many robots are on the field.
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        flexWrap: 'nowrap',
        gap: 1,
        px: 2,
        pb: 2,
      }}
    >
      {robots.map(robot => (
        <BatteryCard
          key={robot.station}
          robot={robot}
          fill
          inMatch={robot.alliance != null && matchAlliances.includes(robot.alliance)}
          isDuplicate={robot.teamNumber ? (teamCounts.get(robot.teamNumber) ?? 0) > 1 : false}
        />
      ))}
    </Box>
  );
});

// ── Video Mode ────────────────────────────────────────────────────────

/** Small labeled control button for the scoreboard's top-right corner. */
function ControlChip({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Typography
      onClick={onClick}
      sx={{
        cursor: 'pointer',
        fontSize: '0.75rem',
        lineHeight: 1,
        px: 1,
        py: 0.5,
        borderRadius: 1,
        border: `1px solid ${active ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.25)'}`,
        color: active ? '#fff' : 'rgba(255,255,255,0.75)',
        backgroundColor: active ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.4)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        '&:hover': { backgroundColor: 'rgba(255,255,255,0.25)', color: '#fff' },
      }}
    >
      {icon} {label}
    </Typography>
  );
}

/** Match timeline overlaid on the top edge of the video. Always mounted (so it
 *  can fade rather than reflow the layout when a match starts or ends) and it
 *  remembers the last shown frame so it fades OUT gracefully after a match
 *  clears instead of vanishing. */
function VideoTimelineOverlay({
  matchState,
  matchProgress,
  autoWinner,
  remainingTime,
}: {
  matchState: ReturnType<typeof useMatchState>;
  matchProgress: number | null;
  autoWinner: Alliance | null;
  remainingTime: number;
}) {
  const visible = matchProgress !== null && matchState !== null;
  const lastRef = useRef<React.ComponentProps<typeof MatchTimeline> | null>(null);
  if (visible) {
    lastRef.current = {
      config: matchState.config,
      progress: matchProgress,
      autoWinnerAlliance: autoWinner,
      phase: matchState.phase,
      remainingTime,
    };
  }
  const props = lastRef.current;
  if (!props) return null; // no match this session yet — nothing to fade

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        px: 0.5,
        pt: 0.5,
        zIndex: 1,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.8s ease',
      }}
    >
      <MatchTimeline {...props} />
    </Box>
  );
}

/** The video container: stream (or source config) filling its parent, with
 *  the "⚙ source" edit affordance. Extra overlays render via children. */
function VideoArea({
  source,
  editing,
  onEditStart,
  onSave,
  onCancelEdit,
  layout,
  onLayoutChange,
  onAspectRatio,
  timelineOverlay,
  children,
}: {
  source: string;
  editing: boolean;
  onEditStart: () => void;
  onSave: (source: string) => void;
  onCancelEdit: () => void;
  layout: VideoLayout;
  onLayoutChange: (layout: VideoLayout) => void;
  /** Reports the playing stream's width/height ratio once known */
  onAspectRatio?: (ratio: number) => void;
  /** Match timeline, overlaid on the video's top edge (both layouts) */
  timelineOverlay?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        position: 'relative',
        bgcolor: '#000',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      {source && !editing ? (
        <>
          <VideoStream source={source} onAspectRatio={onAspectRatio} />
          {timelineOverlay}
          {!window.__isCastReceiver && (
            <Typography
              onClick={onEditStart}
              sx={{
                position: 'absolute',
                bottom: 6,
                right: 10,
                cursor: 'pointer',
                opacity: 0.25,
                fontSize: '0.8rem',
                zIndex: 1,
                '&:hover': { opacity: 0.7 },
              }}
            >
              ⚙ source
            </Typography>
          )}
        </>
      ) : (
        <VideoSourceConfig
          initial={source}
          onSave={onSave}
          onCancel={source ? onCancelEdit : undefined}
          layout={layout}
          onLayoutChange={onLayoutChange}
        />
      )}
      {children}
    </Box>
  );
}

/**
 * Guess the right element for a stream source.
 * - `camera` sentinel → local webcam via getUserMedia
 * - `whep:<stream>` or a .../whep URL → WebRTC via WHEP (sub-second latency)
 * - image/MJPEG URLs → <img> (browsers render multipart MJPEG natively)
 * - direct media files → <video>
 * - everything else → <iframe> (MediaMTX/go2rtc player pages, YouTube embeds, …)
 */
function classifyVideoSource(source: string): 'camera' | 'whep' | 'image' | 'video' | 'iframe' {
  if (source === 'camera') return 'camera';
  const path = source.split(/[?#]/)[0].toLowerCase();
  if (source.startsWith('whep:') || /\/whep\/?$/.test(path)) return 'whep';
  if (/\.(jpe?g|png|gif|webp|mjpe?g)$/.test(path) || /mjpe?g/i.test(source)) return 'image';
  if (/\.(mp4|webm|ogv|ogg|mov|m3u8)$/.test(path)) return 'video';
  return 'iframe';
}

/** Resolve a WHEP source to its signaling endpoint. The `whep:<stream>` form
 *  signals same-origin through the backend's /api/video-proxy (which forwards
 *  to VIDEO_PROXY_TARGET), avoiding mixed-content blocks on the HTTPS page. */
function whepEndpoint(source: string): string {
  if (source.startsWith('whep:')) {
    return `/api/video-proxy/${source.slice('whep:'.length).replace(/^\/+/, '').replace(/\/+$/, '')}/whep`;
  }
  return source;
}

/** WebRTC player: POSTs an SDP offer to a WHEP endpoint and plays the
 *  answered stream. Media flows directly (UDP); only signaling uses HTTP.
 *  Reconnects automatically if the session drops. */
function WhepVideo({ endpoint, onAspectRatio }: { endpoint: string; onAspectRatio?: (ratio: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reportAspect = (e: { currentTarget: HTMLVideoElement }) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) onAspectRatio?.(v.videoWidth / v.videoHeight);
  };

  useEffect(() => {
    setError(null);
    const pc = new RTCPeerConnection();
    let sessionUrl: string | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = (msg: string) => {
      if (cancelled) return;
      setError(msg);
      if (!retryTimer) retryTimer = setTimeout(() => setAttempt(a => a + 1), 3000);
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const stream = new MediaStream();
    pc.ontrack = e => {
      stream.addTrack(e.track);
      if (videoRef.current) videoRef.current.srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (cancelled) return;
      if (pc.connectionState === 'connected') setError(null);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        scheduleRetry('Stream disconnected — reconnecting…');
      }
    };

    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Wait (bounded) for ICE gathering so we can send one complete offer
      // instead of trickling candidates in follow-up PATCHes
      await new Promise<void>(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timer = setTimeout(resolve, 2000);
        const check = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', check);
      });
      if (cancelled) return;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription!.sdp,
      });
      if (!resp.ok) throw new Error(`stream server returned ${resp.status}`);
      sessionUrl = resp.headers.get('Location');
      const answer = await resp.text();
      if (cancelled) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    })().catch((e: Error) => scheduleRetry(`Stream error: ${e.message} — retrying…`));

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      pc.close();
      if (sessionUrl) {
        // keepalive lets the teardown land even while the page is closing
        fetch(new URL(sessionUrl, new URL(endpoint, window.location.href)).toString(), {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [endpoint, attempt]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={VIDEO_FILL_STYLE}
        onLoadedMetadata={reportAspect}
        onResize={reportAspect}
      />
      {error && (
        <Typography
          sx={{
            position: 'absolute',
            bottom: 8,
            left: 12,
            color: 'rgba(255,255,255,0.5)',
            fontSize: '0.8rem',
            zIndex: 1,
          }}
        >
          {error}
        </Typography>
      )}
    </>
  );
}

const VIDEO_FILL_STYLE = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  display: 'block',
  border: 0,
} as const;

function VideoStream({ source, onAspectRatio }: { source: string; onAspectRatio?: (ratio: number) => void }) {
  const kind = classifyVideoSource(source);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const reportVideoAspect = (e: { currentTarget: HTMLVideoElement }) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) onAspectRatio?.(v.videoWidth / v.videoHeight);
  };

  // Local webcam: acquire on mount, release tracks on unmount
  useEffect(() => {
    if (kind !== 'camera') return;
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access requires HTTPS (or localhost)');
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(s => {
        if (cancelled) {
          s.getTracks().forEach(t => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e: Error) => setCameraError(e.message));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [kind]);

  if (kind === 'camera') {
    if (cameraError) {
      return (
        <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography sx={{ color: 'rgba(255,255,255,0.4)' }}>Camera unavailable: {cameraError}</Typography>
        </Box>
      );
    }
    return (
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={VIDEO_FILL_STYLE}
        onLoadedMetadata={reportVideoAspect}
        onResize={reportVideoAspect}
      />
    );
  }
  if (kind === 'whep') return <WhepVideo endpoint={whepEndpoint(source)} onAspectRatio={onAspectRatio} />;
  if (kind === 'image') {
    return (
      <img
        src={source}
        alt="Video stream"
        style={VIDEO_FILL_STYLE}
        onLoad={e => {
          const img = e.currentTarget;
          if (img.naturalWidth && img.naturalHeight) onAspectRatio?.(img.naturalWidth / img.naturalHeight);
        }}
      />
    );
  }
  if (kind === 'video') {
    return (
      <video
        src={source}
        autoPlay
        muted
        playsInline
        loop
        style={VIDEO_FILL_STYLE}
        onLoadedMetadata={reportVideoAspect}
        onResize={reportVideoAspect}
      />
    );
  }
  // iframe contents are opaque — no aspect ratio to report
  return <iframe src={source} allow="autoplay; fullscreen" style={VIDEO_FILL_STYLE} />;
}

function VideoSourceConfig({
  initial,
  onSave,
  onCancel,
  layout,
  onLayoutChange,
}: {
  initial: string;
  onSave: (source: string) => void;
  /** Present only when a source already exists (editing rather than first setup) */
  onCancel?: () => void;
  layout: VideoLayout;
  onLayoutChange: (layout: VideoLayout) => void;
}) {
  const [url, setUrl] = useState(initial === 'camera' ? '' : initial);

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        px: 2,
        border: '1px dashed rgba(255,255,255,0.15)',
        borderRadius: 1,
      }}
    >
      <Typography
        sx={{ color: 'rgba(255,255,255,0.6)', letterSpacing: 3, textTransform: 'uppercase', fontWeight: 700 }}
      >
        Video Stream
      </Typography>
      <Typography sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.85rem', textAlign: 'center', maxWidth: 480 }}>
        Enter a stream URL — an MJPEG snapshot/stream, a video file, or any embeddable page (MediaMTX, go2rtc, YouTube,
        …) — or use a camera attached to this device. For sub-second WebRTC from the field server, enter{' '}
        <code>whep:&lt;stream-name&gt;</code>. The choice is saved locally in this browser only.
      </Typography>
      <Box
        component="form"
        onSubmit={e => {
          e.preventDefault();
          if (url.trim()) onSave(url.trim());
        }}
        sx={{ display: 'flex', gap: 1, width: 'min(520px, 90%)' }}
      >
        <TextField fullWidth size="small" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} />
        <Button type="submit" variant="contained" disabled={!url.trim()}>
          Save
        </Button>
      </Box>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button variant="outlined" onClick={() => onSave('camera')}>
          Use local camera
        </Button>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, mt: 2 }}>
        <Typography
          sx={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.75rem', letterSpacing: 2, textTransform: 'uppercase' }}
        >
          Layout
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            size="small"
            variant={layout === 'landscape' ? 'contained' : 'outlined'}
            onClick={() => onLayoutChange('landscape')}
          >
            Wide — scores on top
          </Button>
          <Button
            size="small"
            variant={layout === 'square' ? 'contained' : 'outlined'}
            onClick={() => onLayoutChange('square')}
          >
            Square — scores beside
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

// ── Period Breakdown ──────────────────────────────────────────────────

/** Ordered sub-periods for determining which are "in the future". */
const SUB_PERIOD_ORDER: MatchSubPeriod[] = ['auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'];

function PeriodBreakdownImpl({
  alliance,
  breakdown,
  autoWinner,
  currentSubPeriod,
  align,
}: {
  alliance: Alliance;
  breakdown: Record<string, { red: number; blue: number }>;
  autoWinner: Alliance | null;
  currentSubPeriod: MatchSubPeriod | null;
  /** Which side of the score box this panel sits on. */
  align: 'left' | 'right';
}) {
  const color = alliance === 'red' ? '#ef5350' : '#42a5f5';
  const [scoring1, scoring2] = getAllianceScoringShifts(alliance, autoWinner);

  // Map display rows to their absolute sub-period keys
  const rows: { label: string; period: MatchSubPeriod }[] = [
    { label: 'Auto', period: 'auto' },
    { label: 'Transition', period: 'transition' },
    { label: 'Period 1', period: scoring1 },
    { label: 'Period 2', period: scoring2 },
    { label: 'Endgame', period: 'endgame' },
  ];

  // Determine which sub-periods are in the future
  const currentIdx = currentSubPeriod ? SUB_PERIOD_ORDER.indexOf(currentSubPeriod) : -1;
  const isFuture = (period: MatchSubPeriod) => {
    if (currentIdx < 0) return true; // no current period = all future (pre-match)
    return SUB_PERIOD_ORDER.indexOf(period) > currentIdx;
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {rows.map(({ label, period }) => {
        const points = breakdown[period]?.[alliance] ?? 0;
        const future = isFuture(period);
        const isCurrent = currentSubPeriod === period;

        return (
          <Box
            key={label}
            sx={{
              display: 'flex',
              gap: 1,
              alignItems: 'baseline',
              flexDirection: align === 'right' ? 'row' : 'row-reverse',
            }}
          >
            <Typography
              sx={{
                color: 'rgba(255,255,255,0.35)',
                fontSize: 'clamp(0.6rem, 1.2vw, 0.8rem)',
                textTransform: 'uppercase',
                fontWeight: isCurrent ? 700 : 400,
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </Typography>
            <Typography
              sx={{
                color: future ? 'rgba(255,255,255,0.15)' : color,
                fontFamily: 'monospace',
                fontSize: 'clamp(0.9rem, 1.8vw, 1.3rem)',
                fontWeight: 700,
                minWidth: '2ch',
                textAlign: align === 'right' ? 'right' : 'left',
              }}
            >
              {future ? '–' : points}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Alliance Score Box ────────────────────────────────────────────────

function AllianceScoreBoxImpl({
  alliance,
  total,
  active,
  inactiveTotal,
  freePlayLabel,
  isAutoWinner,
  isFreePlay,
  side,
  compact,
  reserveDecor,
}: {
  alliance: Alliance;
  total: number;
  active?: boolean;
  /** Goals scored while the hub was off (displayed as secondary count) */
  inactiveTotal?: number;
  /** If set, show this label instead of the alliance name (half-freeplay mode) */
  freePlayLabel?: string | null;
  /** Whether this alliance won auto */
  isAutoWinner?: boolean;
  /** Whether scoring is in freePlay mode (enables glow-proof bg + 400pt flourish) */
  isFreePlay?: boolean;
  /** Which side of the scoreboard this box is on (determines departure animation direction) */
  side?: 'left' | 'right';
  /** Smaller box for the video-mode header row */
  compact?: boolean;
  /** Always reserve space for the off-goal count and auto-winner badge (kept
   *  hidden when absent) so the box height doesn't change when a match starts —
   *  used in the video landscape header to prevent the video from reflowing. */
  reserveDecor?: boolean;
}) {
  const color = alliance === 'red' ? '#ef5350' : '#42a5f5';
  // Don't cap this with `cqh` / `container-type: size` — tried; it collapsed
  // the idle freeplay 0–0 to an invisible font. If a height cap is ever
  // needed, measure with a ResizeObserver.
  const mainFontSize = compact ? 'clamp(2rem, 5vw, 4rem)' : 'clamp(4rem, 15vw, 12rem)';
  const rgb = alliance === 'red' ? '239, 83, 80' : '66, 165, 245';
  const bgColor = isFreePlay
    ? alliance === 'red'
      ? 'rgba(15, 3, 3, 0.65)'
      : 'rgba(3, 8, 18, 0.65)'
    : alliance === 'red'
      ? 'rgba(239,83,80,0.08)'
      : 'rgba(66,165,245,0.08)';
  const goalOff = active === false;
  const hasInactive = inactiveTotal != null && inactiveTotal > 0;

  // Persistent chasing border in freeplay — thickness grows with each 50pt milestone
  const chaseLevel = isFreePlay ? Math.floor(total / 50) : 0;
  const showChase = chaseLevel > 0;
  const chaseWidth = showChase ? 2 + Math.min(chaseLevel, 10) : 0; // 3px → 12px
  const chaseDuration = Math.max(1.5, 3.5 - chaseLevel * 0.15); // slows growth rate for 50pt steps
  const chaseAlpha = Math.min(0.85, 0.35 + chaseLevel * 0.05); // 0.40 → 0.85
  // Snake segment length grows with level: two snakes chasing around the perimeter
  const dashLen = 20 + Math.min(chaseLevel, 10) * 5; // 25 → 70 (out of 400 pathLength)

  // Brief flourish on each 50pt crossing: fast chase burst, then gradual decay
  const [flourish, setFlourish] = useState(false);
  const prevFifty = useRef(Math.floor(total / 50));
  const flourishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isFreePlay) return;
    const cur = Math.floor(total / 50);
    const prev = prevFifty.current;
    prevFifty.current = cur;
    if (cur > prev && cur >= 1) {
      if (flourishTimer.current) clearTimeout(flourishTimer.current);
      setFlourish(true);
      flourishTimer.current = setTimeout(
        () => {
          setFlourish(false);
          flourishTimer.current = null;
        },
        2 * chaseDuration * 1000,
      ); // 2 full chase loops at fast speed
    }
    if (cur < prev) {
      if (flourishTimer.current) clearTimeout(flourishTimer.current);
      setFlourish(false);
      flourishTimer.current = null;
    }
  }, [total, isFreePlay, chaseDuration]);

  // JS-driven chase animation — smooth speed & color transitions via rAF
  const chaseRectRef = useRef<SVGRectElement>(null);
  const chaseOffsetRef = useRef(0);
  const chaseSpeedRef = useRef(0); // current pixels-per-ms in pathLength units
  const flourishRef = useRef(false);
  flourishRef.current = flourish;

  useEffect(() => {
    if (!showChase) return;
    // Speed in pathLength-units per second: 400 / chaseDuration
    const normalSpeed = 400 / chaseDuration;
    const flourishSpeed = 400 / (chaseDuration * 0.4); // 2.5× faster
    if (chaseSpeedRef.current === 0) chaseSpeedRef.current = normalSpeed;

    let lastTime: number | null = null;
    let rafId: number;

    const tick = (now: number) => {
      if (lastTime != null) {
        const dt = Math.min(now - lastTime, 50) / 1000; // seconds, capped to avoid jumps
        const targetSpeed = flourishRef.current ? flourishSpeed : normalSpeed;
        // Asymmetric lerp: snap fast on speed-up, decay gradually
        const lerpRate = targetSpeed > chaseSpeedRef.current ? 0.25 : 0.03;
        chaseSpeedRef.current += (targetSpeed - chaseSpeedRef.current) * lerpRate;
        chaseOffsetRef.current = (chaseOffsetRef.current - chaseSpeedRef.current * dt) % 400;
        chaseRectRef.current?.setAttribute('stroke-dashoffset', String(chaseOffsetRef.current));
      }
      lastTime = now;
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [showChase, chaseDuration]);

  // Score departure animation: when freeplay batch times out, animate the score
  // flying toward the batch list instead of just desaturating in place
  const [departingScore, setDepartingScore] = useState<number | null>(null);
  const prevTotalRef = useRef(total);
  const prevActiveRef = useRef(active);
  const departTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isFreePlay) {
      prevTotalRef.current = total;
      prevActiveRef.current = active;
      return;
    }
    const wasActive = prevActiveRef.current !== false;
    const isNowInactive = active === false;

    if (wasActive && isNowInactive && prevTotalRef.current > 0) {
      // Batch just timed out — capture the old score and animate its departure
      if (departTimerRef.current) clearTimeout(departTimerRef.current);
      setDepartingScore(prevTotalRef.current);
      departTimerRef.current = setTimeout(() => {
        setDepartingScore(null);
        departTimerRef.current = null;
      }, 900);
    }
    if (!wasActive && !isNowInactive) {
      // Scoring resumed — cancel any in-progress departure
      if (departTimerRef.current) clearTimeout(departTimerRef.current);
      setDepartingScore(null);
      departTimerRef.current = null;
    }

    prevTotalRef.current = total;
    prevActiveRef.current = active;
  }, [active, total, isFreePlay]);

  return (
    <Box
      sx={{
        position: 'relative',
        textAlign: 'center',
        px: compact ? 3 : 'clamp(1.5rem, 3vw, 3rem)',
        py: compact ? 1 : 3,
        borderRadius: 2,
        border: `3px solid ${showChase ? 'transparent' : color}`,
        backgroundColor: bgColor,
        transition: 'none',
      }}
    >
      {/* Chasing border — SVG rect with animated stroke-dashoffset for perimeter-following snakes */}
      {showChase && (
        <svg
          style={{
            position: 'absolute',
            top: -3,
            left: -3,
            width: 'calc(100% + 6px)',
            height: 'calc(100% + 6px)',
            overflow: 'visible',
            pointerEvents: 'none',
          }}
        >
          {/* Static base border */}
          <rect x="0" y="0" width="100%" height="100%" rx={8} ry={8} fill="none" stroke={color} strokeWidth={3} />
          {/* Animated chase snakes — JS-driven via rAF for smooth speed transitions */}
          <rect
            ref={chaseRectRef}
            x="0"
            y="0"
            width="100%"
            height="100%"
            rx={8}
            ry={8}
            fill="none"
            strokeWidth={chaseWidth}
            pathLength={400}
            strokeDasharray={`${dashLen} ${200 - dashLen}`}
            strokeLinecap="round"
            style={{
              stroke: flourish ? '#fff' : `rgba(${rgb}, ${chaseAlpha})`,
              transition: flourish ? 'stroke 0.15s ease-in' : 'stroke 2s ease-out',
            }}
          />
        </svg>
      )}
      {/* Main score — fades in as "0" when batch times out, desaturates when goal is off */}
      <Typography
        sx={{
          fontSize: mainFontSize,
          fontWeight: 800,
          fontFamily: 'monospace',
          color,
          lineHeight: 1,
          // Hold width during departure via ch units (monospace = uniform char width),
          // then smoothly shrink after the departing clone finishes its animation
          minWidth: `${(departingScore ?? total).toString().length}ch`,
          transition: `min-width 0.5s ease-out${goalOff ? '' : ', opacity 0.4s ease, filter 0.4s ease'}`,
          opacity: goalOff ? 0.3 : 1,
          filter: goalOff ? 'saturate(0.3)' : 'none',
          textAlign: 'center',
          '@keyframes fadeInZero': {
            from: { opacity: 0 },
          },
          ...(departingScore !== null && {
            animation: 'fadeInZero 0.8s ease-out',
          }),
        }}
      >
        {total}
      </Typography>
      {/* Departing score clone — flies toward the batch list on timeout */}
      {departingScore !== null && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            '@keyframes departLeft': {
              from: { transform: 'scale(1)', opacity: 1 },
              to: { transform: 'translateX(-70%) scale(0.15)', opacity: 0 },
            },
            '@keyframes departRight': {
              from: { transform: 'scale(1)', opacity: 1 },
              to: { transform: 'translateX(70%) scale(0.15)', opacity: 0 },
            },
            animation: `${side === 'left' ? 'departLeft' : 'departRight'} 0.85s ease-in forwards`,
          }}
        >
          <Typography
            sx={{
              fontSize: mainFontSize,
              fontWeight: 800,
              fontFamily: 'monospace',
              color,
              lineHeight: 1,
            }}
          >
            {departingScore}
          </Typography>
        </Box>
      )}
      {/* Off-goal count — swaps saturation prominence with main score */}
      {(hasInactive || reserveDecor) && (
        <Typography
          sx={{
            color,
            fontSize: compact ? 'clamp(0.9rem, 1.8vw, 1.4rem)' : 'clamp(1.5rem, 4vw, 3rem)',
            fontFamily: 'monospace',
            fontWeight: 700,
            mt: 0.5,
            opacity: goalOff ? 1 : 0.3,
            filter: goalOff ? 'none' : 'saturate(0.3)',
            visibility: hasInactive ? 'visible' : 'hidden',
          }}
        >
          +{inactiveTotal ?? 0}
        </Typography>
      )}
      {freePlayLabel && (
        <Typography
          sx={{
            color: 'rgba(255,255,255,0.35)',
            textTransform: 'uppercase',
            letterSpacing: compact ? 2 : 6,
            fontWeight: 700,
            fontSize: compact ? '0.7rem' : '1.2rem',
            mt: compact ? 0.5 : 1,
          }}
        >
          {freePlayLabel}
        </Typography>
      )}
      {/* Auto winner badge — shown below the winning alliance's score */}
      {(isAutoWinner || reserveDecor) && (
        <Typography
          sx={{
            color,
            fontSize: compact ? '0.65rem' : '0.8rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 2,
            mt: 0.5,
            opacity: 0.8,
            visibility: isAutoWinner ? 'visible' : 'hidden',
          }}
        >
          Auto Winner
        </Typography>
      )}
    </Box>
  );
}

function formatTimeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function BatchListImpl({ batches, color, align }: { batches: ScoreBatch[]; color: string; align: 'left' | 'right' }) {
  if (batches.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {batches.map((b, i) => (
        <Box
          key={i}
          sx={{
            opacity: 1 - i * 0.15,
            textAlign: align,
          }}
        >
          <Typography sx={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.65rem', lineHeight: 1.2 }}>
            {formatTimeAgo(b.endedAt)}
          </Typography>
          <Typography sx={{ color, fontFamily: 'monospace', fontSize: '1rem', fontWeight: 700, lineHeight: 1.2 }}>
            {b.total}{' '}
            <Typography component="span" sx={{ color: 'rgba(255,255,255,0.15)', fontSize: '0.7rem', fontWeight: 400 }}>
              in {Math.round((Math.max(...Object.values(b.elements).map(e => e.lastEventTime)) - b.startedAt) / 1000)}s
            </Typography>
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

// Memoized wrappers: these are pure displays of primitive/stable props, so
// they skip the page's fast-ticking re-renders (4 Hz match state, score
// bursts) and only re-render when their own values actually change.
const AllianceScoreBox = memo(AllianceScoreBoxImpl);
const PeriodBreakdown = memo(PeriodBreakdownImpl);
const BatchList = memo(BatchListImpl);
const FreeplayGlow = memo(FreeplayGlowImpl);
