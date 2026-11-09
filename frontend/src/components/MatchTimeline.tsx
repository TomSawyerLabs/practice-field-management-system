import { useState, useEffect, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import {
  Alliance,
  MatchConfig,
  MatchPhase,
  AutoWinnerMode,
  ChallengeTiming,
  MatchFormat,
  CHALLENGE_DEFAULT_DURATION,
  CHALLENGE_MIN_DURATION,
  CHALLENGE_MAX_DURATION,
  CHALLENGE_MAX_PENALTY_LAPS,
  CHALLENGE_MAX_PENALTY_SECONDS,
  challengePenalties,
  isChallengeConfig,
  isCountUpTiming,
  RelayHandoff,
} from '../../../src/types';
import { sendUpdateMatchConfig } from '../hooks/useBackend';
import { gameOf, gamePeriods, goalOffFor, hasAutoWinner, type GameDefinition } from '../utils/game';
import type { GoalOffRule } from '../../../src/game/types';
import { CHALLENGE_COLOR } from '../utils/matchFormat';

// ── Colors ──────────────────────────────────────────────────────────
const RED_SOLID = '#ef5350';
const BLUE_SOLID = '#42a5f5';
const NEUTRAL_COLOR = '#66bb6a'; // Both goals active (auto, REBUILT's transition)
const ENDGAME_COLOR = '#ffa726'; // End game — gold/orange
const PAUSE_COLOR = '#9e9e9e';
const SKIPPED_COLOR = '#bdbdbd'; // Greyed-out auto when skipped

/** Window lengths offered as one-tap chips. */
const CHALLENGE_PRESETS = [30, 45, 60, 90, 120];

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

/** Shared text style for phase labels inside the bar. */
const phaseLabelSx = {
  color: '#fff',
  fontWeight: 700,
  textShadow: '0 1px 2px rgba(0,0,0,0.4)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  px: 0.5,
  lineHeight: 1,
} as const;

/**
 * CSS background for a teleop period, from whose goal it switches off.
 *
 * - Nobody's: green, both goals on (REBUILT's transition).
 * - A fixed alliance's: the other alliance's colour — they're the ones scoring.
 * - The auto winner's or loser's, winner known: the scoring alliance's colour.
 * - Winner not known yet: red/blue stripes, alternating direction.
 */
function getPeriodStyle(goalOff: GoalOffRule | undefined, index: number, winner: Alliance | null): React.CSSProperties {
  if (!goalOff) return { backgroundColor: NEUTRAL_COLOR };
  const off = goalOffFor(goalOff, winner);
  if (!off) {
    const angle = index % 2 === 0 ? 45 : -45;
    return {
      background: `repeating-linear-gradient(${angle}deg, ${RED_SOLID} 0px, ${RED_SOLID} 6px, ${BLUE_SOLID} 6px, ${BLUE_SOLID} 12px)`,
    };
  }
  return { backgroundColor: off === 'red' ? BLUE_SOLID : RED_SOLID };
}

// ── Period time label computation ───────────────────────────────────

/** One segment of the bar: the game's periods, plus the pause after auto. */
interface BarSegment {
  /** Unique key: `pause`, or the game's sub-period id. */
  id: string;
  /** Total duration of this segment (also its flex weight). */
  duration: number;
}

/** The segments of the bar for a game, in order. */
function barSegments(game: GameDefinition): BarSegment[] {
  const out: BarSegment[] = [];
  for (const p of gamePeriods(game)) {
    out.push({ id: p.id, duration: p.duration });
    if (p.phase === 'auto') out.push({ id: 'pause', duration: game.timing.pauseDuration });
  }
  return out;
}

/**
 * Given current match phase and remainingTime, return { id, countdown }
 * where countdown is seconds remaining within that segment (ceiled for display).
 */
function getActivePeriod(
  game: GameDefinition,
  phase: MatchPhase | undefined,
  remainingTime: number,
): { id: string; countdown: number } | null {
  if (!phase) return null;

  if (phase === 'auto') return { id: 'auto', countdown: Math.ceil(Math.max(0, remainingTime)) };
  if (phase === 'autoPause') return { id: 'pause', countdown: Math.ceil(Math.max(0, remainingTime)) };
  if (phase === 'countdown') return null; // countdown isn't a visible period

  if (phase === 'teleop' || phase === 'endgame') {
    const rt = Math.max(0, remainingTime);
    // Walk the teleop periods down from the top of teleop. REBUILT, by
    // remaining time: TS 140→130, S1 →105, S2 →80, S3 →55, S4 →30, Endgame →0.
    let top = game.timing.teleopDuration;
    const periods = gamePeriods(game).filter(p => p.phase !== 'auto');
    for (const p of periods) {
      const bottom = Math.max(0, top - p.duration);
      if (rt > bottom && rt <= top) return { id: p.id, countdown: Math.ceil(rt - bottom) };
      top = bottom;
    }
    // At exactly 0
    const last = periods[periods.length - 1];
    if (rt <= 0 && last) return { id: last.id, countdown: 0 };
  }

  return null;
}

// ── Component ───────────────────────────────────────────────────────

interface MatchTimelineProps {
  config: MatchConfig;
  disabled?: boolean;
  /**
   * Show the setup without any way to change it. The station page uses this
   * so teams can see what's about to run; the inputs (format, skip auto,
   * auto winner, challenge window/timing/penalties) exist only on /match.
   */
  readOnly?: boolean;
  autoWinnerAlliance?: Alliance | null;
  /** 0-1 progress; when set, the bar acts as a live progress indicator. */
  progress?: number;
  /** Current match phase (for per-period countdown display). */
  phase?: MatchPhase;
  /** Remaining time in current engine phase (for per-period countdown). */
  remainingTime?: number;
}

/** What the field is about to run. An official match and a speed challenge
 *  share the lifecycle but nothing else, so they get separate bars. */
export function MatchTimeline(props: MatchTimelineProps) {
  return isChallengeConfig(props.config) ? <ChallengeTimeline {...props} /> : <OfficialTimeline {...props} />;
}

/**
 * A number the server owns but the UI steps a tap at a time.
 *
 * Reading the value straight off the last broadcast loses taps: two presses
 * inside one round trip both compute from the same stale number and send the
 * same result. So hold the local guess, and adopt the server's whenever it
 * differs — which is either our own value coming back, or someone else
 * editing. Callers clamp before committing, so the server never disagrees
 * with a value we chose.
 */
function useStepped(
  serverValue: number,
  send: (value: number) => void,
): [number, (next: (current: number) => number) => void] {
  const [local, setLocal] = useState(serverValue);
  const sent = useRef(serverValue);

  useEffect(() => {
    if (serverValue === sent.current) return;
    sent.current = serverValue;
    setLocal(serverValue);
  }, [serverValue]);

  return [
    local,
    // Computed from the ref, not from the rendered value, so a burst of taps
    // inside one render still steps once each.
    (next: (current: number) => number) => {
      const value = next(sent.current);
      if (value === sent.current) return;
      sent.current = value;
      setLocal(value);
      send(value);
    },
  ];
}

/** Switch between a regulation match and a field event. Config mode only —
 *  the format is fixed once a match starts. */
function FormatSwitch({ config, disabled }: { config: MatchConfig; disabled?: boolean }) {
  const format: MatchFormat = config.format ?? 'official';

  const handleChange = (next: MatchFormat | null) => {
    if (!next || next === format) return;
    if (next === 'challenge') {
      sendUpdateMatchConfig({
        ...config,
        format: 'challenge',
        teleopDuration: CHALLENGE_DEFAULT_DURATION,
        challengeTiming: 'window',
      });
    } else {
      sendUpdateMatchConfig({ ...config, format: 'official' });
    }
  };

  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={format}
      disabled={disabled}
      onChange={(_, next) => handleChange(next as MatchFormat | null)}
    >
      <ToggleButton value="official" sx={{ px: 2 }}>
        Official Match
      </ToggleButton>
      <ToggleButton
        value="challenge"
        sx={{ px: 2, '&.Mui-selected': { backgroundColor: CHALLENGE_COLOR, color: '#fff' } }}
      >
        Speed Challenge
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

/**
 * A speed challenge is one enabled window — no auto, no shifts, no endgame —
 * so it gets one bar instead of eight segments. In progress mode the same bar
 * carries the run's progress cursor.
 */
function ChallengeTimeline({ config, disabled, readOnly, progress, remainingTime }: MatchTimelineProps) {
  const isProgressMode = progress !== undefined;
  const timing: ChallengeTiming = config.challengeTiming ?? 'window';

  // One penalty's cost, in whichever unit this run is scored in. The two are
  // stored separately so switching timing can't reinterpret "5 seconds" as
  // "5 laps".
  const { penaltyLaps, penaltySeconds } = challengePenalties({
    penaltyLaps: config.challengePenaltyLaps,
    penaltySeconds: config.challengePenaltySeconds,
  });
  const countUp = isCountUpTiming(timing);
  const penaltyMax = countUp ? CHALLENGE_MAX_PENALTY_SECONDS : CHALLENGE_MAX_PENALTY_LAPS;

  const [duration, commitDuration] = useStepped(config.teleopDuration, seconds =>
    sendUpdateMatchConfig({ ...config, teleopDuration: seconds }),
  );
  const clampDuration = (seconds: number) =>
    Math.min(CHALLENGE_MAX_DURATION, Math.max(CHALLENGE_MIN_DURATION, seconds));
  const setDuration = (seconds: number) => commitDuration(() => clampDuration(seconds));
  const stepDuration = (delta: number) => commitDuration(current => clampDuration(current + delta));

  const [penaltyCost, commitPenalty] = useStepped(countUp ? penaltySeconds : penaltyLaps, value =>
    sendUpdateMatchConfig({
      ...config,
      ...(countUp ? { challengePenaltySeconds: value } : { challengePenaltyLaps: value }),
    }),
  );
  const stepPenalty = (delta: number) => commitPenalty(current => Math.min(penaltyMax, Math.max(0, current + delta)));

  const penaltyLabel = countUp ? `${penaltyCost}s` : `${penaltyCost} ${penaltyCost === 1 ? 'lap' : 'laps'}`;

  const barLabel = isProgressMode
    ? `${Math.ceil(Math.max(0, remainingTime ?? 0))}s`
    : timing === 'stopwatch'
      ? `STOPWATCH — ${formatDuration(duration)} CAP`
      : timing === 'relay'
        ? `RELAY — ${formatDuration(duration)} CAP`
        : `SPEED CHALLENGE — ${formatDuration(duration)}`;
  const handoff: RelayHandoff = config.relayHandoff ?? 'staff';

  return (
    <Box sx={{ mb: isProgressMode ? 0 : 2 }}>
      <Box
        sx={{
          display: 'flex',
          height: isProgressMode ? 32 : 48,
          borderRadius: 1,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          userSelect: 'none',
          opacity: disabled ? 0.5 : 1,
          position: 'relative',
        }}
      >
        <Box
          sx={{
            flex: 1,
            backgroundColor: CHALLENGE_COLOR,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography sx={{ ...phaseLabelSx, fontSize: isProgressMode ? '0.65rem' : '0.75rem' }}>{barLabel}</Typography>
        </Box>

        {isProgressMode && (
          <Box
            sx={{
              position: 'absolute',
              left: `${Math.min(100, Math.max(0, progress * 100))}%`,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              borderLeft: '2px solid #fff',
              pointerEvents: 'none',
              transition: 'left 0.3s linear',
            }}
          />
        )}
      </Box>

      {!isProgressMode && readOnly && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {timing === 'window'
            ? 'Laps in the window — staff tally laps as they happen.'
            : timing === 'stopwatch'
              ? 'Stopwatch — staff press Finish when the last robot is home.'
              : handoff === 'staff'
                ? 'Relay — robots run one at a time; the line ref sends the next.'
                : handoff === 'ds'
                  ? 'Relay — robots run one at a time; disabling on the DS sends the next.'
                  : 'Relay — every robot enabled, drivers take turns.'}
          {' · '}
          {penaltyCost === 0 ? 'Penalties cost nothing.' : `One penalty costs ${penaltyLabel}.`}
        </Typography>
      )}

      {!isProgressMode && !readOnly && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
          <FormatSwitch config={config} disabled={disabled} />

          <Box>
            <FormLabel sx={{ fontSize: '0.75rem', display: 'block', mb: 0.5 }}>
              Window — robots are enabled for this long
            </FormLabel>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              {CHALLENGE_PRESETS.map(seconds => (
                <Chip
                  key={seconds}
                  label={formatDuration(seconds)}
                  size="small"
                  color={seconds === duration ? 'primary' : 'default'}
                  variant={seconds === duration ? 'filled' : 'outlined'}
                  disabled={disabled}
                  onClick={() => setDuration(seconds)}
                />
              ))}
              <Button
                size="small"
                sx={{ textTransform: 'none' }}
                disabled={disabled || duration <= CHALLENGE_MIN_DURATION}
                onClick={() => stepDuration(-5)}
              >
                −5s
              </Button>
              <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 48, textAlign: 'center' }}>
                {formatDuration(duration)}
              </Typography>
              <Button
                size="small"
                sx={{ textTransform: 'none' }}
                disabled={disabled || duration >= CHALLENGE_MAX_DURATION}
                onClick={() => stepDuration(5)}
              >
                +5s
              </Button>
            </Box>
          </Box>

          <FormControl disabled={disabled}>
            <FormLabel sx={{ fontSize: '0.75rem' }}>Timing</FormLabel>
            <RadioGroup
              row
              value={timing}
              onChange={e => sendUpdateMatchConfig({ ...config, challengeTiming: e.target.value as ChallengeTiming })}
            >
              <FormControlLabel
                value="window"
                control={<Radio size="small" />}
                label={<Typography variant="body2">Laps in the window</Typography>}
              />
              <FormControlLabel
                value="stopwatch"
                control={<Radio size="small" />}
                label={<Typography variant="body2">Stopwatch — staff press Finish</Typography>}
              />
              <FormControlLabel
                value="relay"
                control={<Radio size="small" />}
                label={<Typography variant="body2">Relay — robots run one at a time</Typography>}
              />
            </RadioGroup>
            <Typography variant="caption" color="text.secondary">
              {timing === 'window'
                ? 'Clock counts down; the buzzer ends the run. Staff tally laps as they happen.'
                : timing === 'relay'
                  ? 'Each alliance runs its robots in slot order (red1, red2, red3). First alliance with every robot home wins. The window above is the cap.'
                  : 'Clock counts up; the window above is the cap, and running it out is a DNF.'}
            </Typography>
          </FormControl>

          {timing === 'relay' && (
            <FormControl disabled={disabled}>
              <FormLabel sx={{ fontSize: '0.75rem' }}>Hand-off — how the next robot gets sent</FormLabel>
              <RadioGroup
                value={handoff}
                onChange={e => sendUpdateMatchConfig({ ...config, relayHandoff: e.target.value as RelayHandoff })}
              >
                <FormControlLabel
                  value="staff"
                  control={<Radio size="small" />}
                  label={
                    <Typography variant="body2">Line ref button — staff press Home when a robot crosses</Typography>
                  }
                />
                <FormControlLabel
                  value="ds"
                  control={<Radio size="small" />}
                  label={<Typography variant="body2">Driver Station — the running robot disables itself</Typography>}
                />
                <FormControlLabel
                  value="manual"
                  control={<Radio size="small" />}
                  label={<Typography variant="body2">Manual — every robot enabled, drivers take turns</Typography>}
                />
              </RadioGroup>
              <Typography variant="caption" color="text.secondary">
                {handoff === 'staff'
                  ? 'Only one robot per alliance is enabled at a time. Pressing Home disables it and enables the next; on the last robot it stops the clock.'
                  : handoff === 'ds'
                    ? 'Only one robot per alliance is enabled at a time. When the runner presses Disable on its DS, the next robot is enabled. Legacy NI Driver Stations only — the 2027 DS does not report its disable, so use the line ref button for those. The button stays as a backup.'
                    : 'A plain timer: all robots are live from the horn and staff press Finish when the last one is home.'}
              </Typography>
            </FormControl>
          )}

          <Box>
            <FormLabel sx={{ fontSize: '0.75rem', display: 'block', mb: 0.5 }}>What one penalty costs</FormLabel>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                size="small"
                sx={{ textTransform: 'none' }}
                disabled={disabled || penaltyCost <= 0}
                onClick={() => stepPenalty(-1)}
              >
                −1
              </Button>
              <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 90, textAlign: 'center' }}>
                {penaltyLabel}
              </Typography>
              <Button
                size="small"
                sx={{ textTransform: 'none' }}
                disabled={disabled || penaltyCost >= penaltyMax}
                onClick={() => stepPenalty(1)}
              >
                +1
              </Button>
            </Box>
            <Typography variant="caption" color="text.secondary">
              {penaltyCost === 0
                ? 'Penalties are tallied but cost nothing — the count is just a record.'
                : countUp
                  ? 'Added to the finishing time before ranking.'
                  : 'Taken off the lap count before ranking.'}
            </Typography>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function OfficialTimeline({
  config,
  disabled,
  readOnly,
  autoWinnerAlliance,
  progress,
  phase,
  remainingTime,
}: MatchTimelineProps) {
  const isProgressMode = progress !== undefined;
  const game = gameOf(config);
  const gameHasAutoWinner = hasAutoWinner(game);

  const [skipAuto, setSkipAuto] = useState(config.skipAuto ?? false);
  const [autoWinner, setAutoWinner] = useState<AutoWinnerMode>(config.autoWinner ?? 'scores');

  useEffect(() => {
    setSkipAuto(config.skipAuto ?? false);
    setAutoWinner(config.autoWinner ?? 'scores');
  }, [config.skipAuto, config.autoWinner]);

  const visualWinner: Alliance | null = useMemo(() => {
    if (autoWinnerAlliance) return autoWinnerAlliance;
    const mode = config.autoWinner ?? 'scores';
    if (mode === 'red') return 'red';
    if (mode === 'blue') return 'blue';
    return null;
  }, [autoWinnerAlliance, config.autoWinner]);

  // ── Durations ───────────────────────────────────────────────────
  const autoDuration = config.autoDuration;
  const pauseDuration = config.pauseDuration;
  const teleopTotal = config.teleopDuration;
  const matchTotal = skipAuto ? teleopTotal : autoDuration + pauseDuration + teleopTotal;
  const segments = useMemo(() => barSegments(game), [game]);
  const periods = useMemo(() => gamePeriods(game), [game]);
  const teleopSegments = periods.filter(p => p.phase !== 'auto');

  const fontSize = isProgressMode ? '0.65rem' : '0.75rem';
  const timeLabelFontSize = isProgressMode ? '0.6rem' : '0.65rem';

  // ── Active period (for countdown labels) ────────────────────────
  const activePeriod = useMemo(
    () => (isProgressMode ? getActivePeriod(game, phase, remainingTime ?? 0) : null),
    [isProgressMode, game, phase, remainingTime],
  );

  // ── Handlers ────────────────────────────────────────────────────
  const handleSkipAutoChange = (checked: boolean) => {
    setSkipAuto(checked);
    // Skipping auto means nobody wins it, so a game that has an auto winner
    // needs one picked by hand.
    const newAutoWinner =
      gameHasAutoWinner && checked && (autoWinner === 'scores' || autoWinner === 'pause') ? 'red' : autoWinner;
    if (checked && newAutoWinner !== autoWinner) setAutoWinner(newAutoWinner);
    sendUpdateMatchConfig({ ...config, skipAuto: checked, autoWinner: newAutoWinner });
  };

  const handleAutoWinnerChange = (value: AutoWinnerMode) => {
    setAutoWinner(value);
    sendUpdateMatchConfig({ ...config, skipAuto, autoWinner: value });
  };

  const autoWinnerOptions: { value: AutoWinnerMode; label: string; color?: string }[] = skipAuto
    ? [
        { value: 'red', label: 'Red', color: '#d32f2f' },
        { value: 'blue', label: 'Blue', color: '#1565c0' },
      ]
    : [
        { value: 'red', label: 'Red', color: '#d32f2f' },
        { value: 'blue', label: 'Blue', color: '#1565c0' },
        { value: 'scores', label: 'Scores' },
        { value: 'pause', label: 'Pause' },
      ];

  const autoWinnerHint =
    game.gameData?.kind === 'autoWinner'
      ? `Decides whose goal goes inactive first, and the ${game.name} game data sent to the robots`
      : 'Decides whose goal goes inactive first';

  // ── Per-period time label ───────────────────────────────────────
  function periodTimeLabel(p: BarSegment): string {
    if (activePeriod && activePeriod.id === p.id) {
      return `${activePeriod.countdown}s`;
    }
    return formatDuration(p.duration);
  }

  const gameLabel = game.season ? `${game.name} (${game.season})` : game.name;

  return (
    <Box sx={{ mb: isProgressMode ? 0 : 2 }}>
      {/* ── Which game this is ──────────────────────────────────── */}
      {!isProgressMode && (
        <Tooltip title={game.description ?? ''} arrow disableHoverListener={!game.description}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Game: <strong>{gameLabel}</strong>
          </Typography>
        </Tooltip>
      )}

      {/* ── Per-period time labels above the bar ─────────────────── */}
      <Box sx={{ display: 'flex', mb: 0.25 }}>
        {segments.map(p => (
          <Box
            key={p.id}
            sx={{
              flex: p.duration,
              minWidth: 0,
              textAlign: 'center',
            }}
          >
            <Typography
              sx={{
                fontSize: timeLabelFontSize,
                fontFamily: 'monospace',
                fontWeight: activePeriod?.id === p.id ? 700 : 400,
                color: activePeriod?.id === p.id ? 'text.primary' : 'text.secondary',
                opacity: p.id === 'pause' ? 0 : 1, // hide the tiny pause label
                transition: 'color 0.3s ease, font-weight 0.3s ease',
              }}
            >
              {periodTimeLabel(p)}
            </Typography>
          </Box>
        ))}
      </Box>

      {/* ── Timeline bar ─────────────────────────────────────────── */}
      <Box
        sx={{
          display: 'flex',
          height: isProgressMode ? 32 : 48,
          borderRadius: 1,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          userSelect: 'none',
          opacity: disabled ? 0.5 : 1,
          position: 'relative',
        }}
      >
        {autoDuration > 0 && (
          <>
            {/* AUTO — green (greyed out when skipped) */}
            <Tooltip title={`Autonomous: ${formatDuration(autoDuration)}`} arrow>
              <Box
                sx={{
                  flex: autoDuration,
                  minWidth: 32,
                  backgroundColor: skipAuto ? SKIPPED_COLOR : NEUTRAL_COLOR,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: skipAuto ? 0.6 : 1,
                  transition: 'background-color 0.4s ease, opacity 0.4s ease',
                }}
              >
                <Typography
                  sx={{ ...phaseLabelSx, fontSize, opacity: skipAuto ? 0.7 : 1, transition: 'opacity 0.4s ease' }}
                >
                  AUTO
                </Typography>
              </Box>
            </Tooltip>

            {/* Pause — no text label */}
            <Tooltip title={`Scoring Delay: ${formatDuration(pauseDuration)}`} arrow>
              <Box
                sx={{
                  flex: pauseDuration,
                  minWidth: pauseDuration > 0 ? 8 : 0,
                  backgroundColor: skipAuto ? SKIPPED_COLOR : PAUSE_COLOR,
                  opacity: skipAuto ? 0.6 : 1,
                  transition: 'background-color 0.4s ease, opacity 0.4s ease',
                }}
              />
            </Tooltip>
          </>
        )}

        {/* Teleop — the game's periods, then the endgame */}
        <Box sx={{ flex: teleopTotal, display: 'flex', minWidth: 0 }}>
          {teleopSegments.map((p, i) => (
            <Tooltip key={p.id} title={`${p.label}: ${formatDuration(p.duration)}`} arrow>
              <Box
                sx={{
                  flex: p.duration,
                  minWidth: 0,
                  ...(p.phase === 'endgame'
                    ? { backgroundColor: ENDGAME_COLOR }
                    : getPeriodStyle(p.goalOff, i, visualWinner)),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background-color 0.4s ease, background 0.4s ease',
                }}
              >
                <Typography sx={{ ...phaseLabelSx, fontSize }}>{p.short.toUpperCase()}</Typography>
              </Box>
            </Tooltip>
          ))}
        </Box>

        {/* ── Progress cursor & future mask ───────────────────────── */}
        {isProgressMode && (
          <Box
            sx={{
              position: 'absolute',
              left: `${Math.min(100, Math.max(0, progress * 100))}%`,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              borderLeft: '2px solid #fff',
              pointerEvents: 'none',
              transition: 'left 0.3s linear',
            }}
          />
        )}
      </Box>

      {/* ── Duration labels — flex row mirrors bar proportions ──── */}
      {!isProgressMode && (
        <Box sx={{ display: 'flex', columnGap: 1, mt: 0.5 }}>
          {/* On a phone the auto segment is narrower than this label */}
          <Box sx={{ flex: autoDuration + pauseDuration, minWidth: 'max-content' }}>
            <Typography variant="caption" color="text.secondary" noWrap>
              Total: {formatDuration(matchTotal)}
            </Typography>
          </Box>
          <Box sx={{ flex: teleopTotal, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap>
              Teleop: {formatDuration(teleopTotal)}
            </Typography>
          </Box>
        </Box>
      )}

      {/* ── Controls (config mode only) ──────────────────────────── */}
      {!isProgressMode && readOnly && (autoDuration > 0 || gameHasAutoWinner) && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {skipAuto ? 'Autonomous skipped' + (gameHasAutoWinner ? ' · ' : '.') : ''}
          {!gameHasAutoWinner
            ? ''
            : autoWinner === 'red'
              ? 'Auto winner: Red.'
              : autoWinner === 'blue'
                ? 'Auto winner: Blue.'
                : autoWinner === 'pause'
                  ? 'Auto winner: chosen during the pause after auto.'
                  : 'Auto winner: decided by auto scores.'}
        </Typography>
      )}
      {!isProgressMode && !readOnly && (
        <Box sx={{ mt: 1.5 }}>
          <FormatSwitch config={config} disabled={disabled} />
        </Box>
      )}
      {!isProgressMode && !readOnly && autoDuration > 0 && (
        <Box sx={{ display: 'flex', gap: 3, mt: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={skipAuto}
                onChange={(_, checked) => handleSkipAutoChange(checked)}
                disabled={disabled}
                size="small"
              />
            }
            label={<Typography variant="body2">Skip Auto</Typography>}
          />

          {gameHasAutoWinner && (
            <FormControl disabled={disabled}>
              <FormLabel sx={{ fontSize: '0.75rem' }}>
                <Tooltip title={autoWinnerHint} arrow>
                  <span>Auto Winner</span>
                </Tooltip>
              </FormLabel>
              <RadioGroup
                row
                value={autoWinner}
                onChange={e => handleAutoWinnerChange(e.target.value as AutoWinnerMode)}
              >
                {autoWinnerOptions.map(opt => (
                  <FormControlLabel
                    key={opt.value}
                    value={opt.value}
                    control={
                      <Radio
                        size="small"
                        sx={opt.color ? { color: opt.color, '&.Mui-checked': { color: opt.color } } : undefined}
                      />
                    }
                    label={
                      <Typography variant="body2" sx={opt.color ? { color: opt.color } : undefined}>
                        {opt.label}
                      </Typography>
                    }
                  />
                ))}
              </RadioGroup>
            </FormControl>
          )}
        </Box>
      )}
    </Box>
  );
}
