import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Box from '@mui/material/Box';
import { QRCodeSVG } from 'qrcode.react';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import CancelIcon from '@mui/icons-material/Cancel';
import DangerousIcon from '@mui/icons-material/Dangerous';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import RateReviewIcon from '@mui/icons-material/RateReview';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import { TeamAvatar } from './TeamAvatar';
import {
  Alliance,
  MatchPhase,
  MatchState,
  MatchHistoryEntry,
  StationName,
  StationControlState,
  StaffRole,
  StaffRoleList,
  StaffRoleLabels,
  MatchHistoryTeam,
  challengeScore,
} from '../../../src/types';
import {
  useMatchState,
  useMatchHistory,
  sendMatchCreate,
  sendMatchCancel,
  sendMatchAbortCountdown,
  sendMatchClear,
  sendMatchSwapStation,
  sendMatchKickStation,
  sendMatchSetAutoWinner,
  sendMatchRequestReady,
  sendMatchStaffIgnore,
  sendPlayGetReady,
  onPlayGetReady,
  sendStationStartMatch,
  sendStationPauseMatch,
  sendStationResumeMatch,
  sendStationAbandonMatch,
  sendAdminStationDisable,
  sendAdminStationEnable,
  sendAdminStationEStop,
  sendAdminGlobalEStop,
  sendAdminClearEStop,
  sendClearMatchHistory,
  useMatchRecordingState,
  usePublicUrl,
  matchSummaryUrl,
} from '../hooks/useBackend';
import { MatchTimeline } from './MatchTimeline';
import { ChallengeTallyPanel } from './ChallengeTallyPanel';
import { ChallengeLeaderboard } from './ChallengeLeaderboard';
import { RecordingButtons, RecordingIconButtons } from './MatchVideoCard';
import { CopyToClipboard } from './CopyToClipboard';
import { useDsClientStation, DsClientBlock } from './DsClientGuard';
import { MatchTimer, PHASE_HEX, getActiveColor } from './MatchTimer';
import { getAllianceShiftState } from '../utils/shiftState';
import { phaseLabel, formatName, isChallengeConfig, CHALLENGE_COLOR, challengeElapsed } from '../utils/matchFormat';

// ── Phase display helpers ───────────────────────────────────────────

// Muted versions for the page background
const PHASE_BG: Record<MatchPhase, string> = {
  idle: 'transparent',
  created: 'rgba(66,165,245,0.10)',
  countdown: 'rgba(255,167,38,0.12)',
  auto: 'rgba(102,187,106,0.12)',
  autoPause: 'rgba(158,158,158,0.08)',
  paused: 'rgba(255,167,38,0.12)',
  teleop: 'rgba(102,187,106,0.10)',
  endgame: 'rgba(255,167,38,0.12)',
  postMatch: 'transparent',
};

/** Muted page background; during teleop shifts, tint by alliance colour. */
function getPageBg(matchState: MatchState): string {
  const { phase } = matchState;

  if ((phase === 'teleop' || phase === 'endgame') && !isChallengeConfig(matchState.config)) {
    const inactive = getAllianceShiftState(
      phase,
      matchState.remainingTime,
      matchState.config.teleopDuration,
      matchState.config.endgameDuration,
      matchState.autoWinnerAlliance,
    );
    if (inactive === 'red') return 'rgba(66,165,245,0.10)';
    if (inactive === 'blue') return 'rgba(239,83,80,0.10)';
  }

  return PHASE_BG[phase];
}

// ── Station label — uses team number, never exposes slot/radio ids ──

function teamLabel(state: StationControlState | undefined): string {
  const team = state?.teamNumber;
  if (team) return String(team);
  return '(no team)';
}

// ── Progress computation ────────────────────────────────────────────

function computeBarProgress(
  totalMatchTime: number,
  config: { autoDuration: number; pauseDuration: number; teleopDuration: number; skipAuto?: boolean },
): number {
  const countdownDuration = 3;
  // The bar always shows auto + pause + teleop (even when skipped, they're greyed not hidden)
  const barTotal = config.autoDuration + config.pauseDuration + config.teleopDuration;
  if (barTotal <= 0) return 0;
  const elapsed = Math.max(0, totalMatchTime - countdownDuration);
  if (config.skipAuto) {
    // Auto/pause are skipped in real time but still shown in bar — offset progress past them
    const skipOffset = config.autoDuration + config.pauseDuration;
    return Math.min(1, (skipOffset + elapsed) / barTotal);
  }
  return Math.min(1, elapsed / barTotal);
}

// ── Root component ──────────────────────────────────────────────────

/**
 * The dedicated match controller page at /match.
 *
 * Manages the full match lifecycle: create → setup → start → control → post-match.
 * Only this page has access to start/pause/resume/abandon/e-stop/disable controls.
 */
// ── Hold-to-start ───────────────────────────────────────────────────
// The start button must be held for the whole 3-2-1 countdown. Releasing
// before the robots enable (still in `countdown`) aborts the start with a
// fault; releasing during/after the start horn (auto onward) does nothing.
//
// The countdown replaces CreatedView with the active view, so the button
// unmounts mid-hold. Release is therefore watched at the window level from a
// module-scoped handler that outlives the button — and we defeat the implicit
// pointer capture on press so the pointerup still reaches the window on touch
// (iOS) after the button is gone.
let holdArmed = false;
/** Set when the pointer is released before robots enabled — cancels the start
 *  even if it's still in flight (a quick tap releases while the phase is still
 *  locally `created`, so we also abort the moment `countdown` shows up). */
let holdAbortWanted = false;
let holdLatestPhase: MatchPhase = 'idle';

/** Robots are enabled from auto onward — once there, releasing is a no-op. */
function robotsEnabled(phase: MatchPhase): boolean {
  return phase !== 'idle' && phase !== 'created' && phase !== 'countdown';
}

function setHoldLatestPhase(phase: MatchPhase) {
  holdLatestPhase = phase;
  if (!holdAbortWanted) return;
  // A start we let go of early has now reached the countdown — abort it.
  if (phase === 'countdown') sendMatchAbortCountdown();
  // Abort took effect (back to setup) or the start slipped through to enabled —
  // either way stop chasing it.
  if (phase === 'created' || robotsEnabled(phase)) holdAbortWanted = false;
}

function endHold() {
  if (!holdArmed) return;
  holdArmed = false;
  window.removeEventListener('pointerup', endHold);
  window.removeEventListener('pointercancel', endHold);
  // Released before robots enabled → abandon the start. Abort now if we're
  // already counting down; if the start is still in flight (phase 'created'),
  // arm the abort so setHoldLatestPhase fires it the instant countdown begins.
  if (!robotsEnabled(holdLatestPhase)) {
    holdAbortWanted = true;
    if (holdLatestPhase === 'countdown') sendMatchAbortCountdown();
  }
}

function beginHold() {
  if (holdArmed) return;
  holdArmed = true;
  holdAbortWanted = false;
  window.addEventListener('pointerup', endHold);
  window.addEventListener('pointercancel', endHold);
  sendStationStartMatch();
}

/** Press-and-hold start control. Fires the countdown on press; a release before
 *  the robots enable aborts it. */
function HoldToStartButton({ canStart, holdDisabledReason }: { canStart: boolean; holdDisabledReason?: string }) {
  const [pressed, setPressed] = useState(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canStart) return;
    // Defeat implicit pointer capture so the window pointerup still fires after
    // this button unmounts at the countdown (crucial on touch / iOS).
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // No capture to release — fine.
    }
    setPressed(true);
    beginHold();
  };

  // Local visual reset only — the authoritative release/abort is the module
  // window handler (this button may already be unmounted by then).
  const onRelease = () => setPressed(false);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
      <Button
        variant="contained"
        color={pressed ? 'warning' : 'success'}
        size="large"
        disabled={!canStart}
        onPointerDown={onPointerDown}
        onPointerUp={onRelease}
        onPointerCancel={onRelease}
        onPointerLeave={onRelease}
        sx={{ px: 6, py: 1.5, fontWeight: 'bold', touchAction: 'none', userSelect: 'none' }}
      >
        {pressed ? 'Hold… release aborts' : 'Hold to Start'}
      </Button>
      {canStart ? (
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
          Hold through the 3-2-1 — let go before the horn to abort.
        </Typography>
      ) : (
        <Typography variant="body2" sx={{ textAlign: 'center', color: 'warning.main', fontWeight: 600, maxWidth: 360 }}>
          {holdDisabledReason ?? 'Not ready to start'}
        </Typography>
      )}
    </Box>
  );
}

export function MatchControlPage() {
  const matchState = useMatchState();
  const matchHistory = useMatchHistory();
  const dsStation = useDsClientStation();

  // Keep the module-level hold watcher's view of the phase current so a release
  // mid-countdown makes the right call even after the button unmounts.
  useEffect(() => {
    if (matchState) setHoldLatestPhase(matchState.phase);
  }, [matchState?.phase]);

  if (dsStation) return <DsClientBlock station={dsStation} roleNoun="the match operator" />;

  if (!matchState) {
    return (
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Typography variant="h4" sx={{ mb: 2, fontWeight: 700 }}>
          Match Control
        </Typography>
        <Typography color="text.secondary">Connecting...</Typography>
      </Container>
    );
  }

  const { phase } = matchState;
  const activeColor = getActiveColor(matchState);
  const pageBg = getPageBg(matchState);
  const showHistory = (phase === 'idle' || phase === 'postMatch') && matchHistory && matchHistory.matches.length > 0;

  return (
    <Box sx={{ minHeight: '100dvh', backgroundColor: pageBg, transition: 'background-color 1s ease' }}>
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Match Control
          </Typography>
          <Chip
            label={phaseLabel(phase, matchState.config)}
            sx={{
              fontWeight: 'bold',
              color: activeColor,
              borderColor: activeColor,
              transition: 'color 1s ease, border-color 1s ease',
            }}
            variant="outlined"
          />
        </Box>

        {phase === 'idle' && <IdleView />}
        {phase === 'created' && <CreatedView matchState={matchState} />}
        {phase === 'postMatch' && <PostMatchView matchState={matchState} />}
        {phase !== 'idle' && phase !== 'created' && phase !== 'postMatch' && (
          <ActiveMatchView matchState={matchState} activeColor={activeColor} />
        )}

        {showHistory && <ChallengeLeaderboard matches={matchHistory.matches} />}
        {showHistory && <MatchHistorySection matches={matchHistory.matches} />}
      </Container>
    </Box>
  );
}

// ── Idle view ───────────────────────────────────────────────────────

function IdleView() {
  return (
    <Card>
      <CardContent sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          No match in progress. Create a match to allow teams to join.
        </Typography>
        <Button
          variant="contained"
          color="primary"
          size="large"
          onClick={sendMatchCreate}
          sx={{ px: 6, py: 1.5, fontSize: '1.2rem', fontWeight: 'bold' }}
        >
          Create Match
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Created view — pre-match setup ──────────────────────────────────

function CreatedView({ matchState }: { matchState: NonNullable<ReturnType<typeof useMatchState>> }) {
  const { config, stationStates, readyRequested, staffStates } = matchState;

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  // Start gate: ready check opened, ≥1 team joined and all joined teams ready,
  // and every non-ignored staff role ready.
  const requiredStaff = StaffRoleList.filter(r => !staffStates[r].ignored);
  const staffAllReady = requiredStaff.every(r => staffStates[r].ready);
  const stationsAllReady = joinedStations.length > 0 && joinedStations.every(s => stationStates[s]?.ready);
  const allReady = readyRequested && stationsAllReady && staffAllReady;

  const notReadyStaff = requiredStaff.filter(r => !staffStates[r].ready).map(r => StaffRoleLabels[r]);
  const notReadyTeams = joinedStations.filter(s => !stationStates[s]?.ready).map(s => teamLabel(stationStates[s]));
  // Spell out exactly who or what is holding the start, right under the button.
  const holdDisabledReason = !readyRequested
    ? 'Ask for Ready first — nobody can ready up until the check is open.'
    : joinedStations.length === 0
      ? 'No team has joined this match yet.'
      : !stationsAllReady
        ? `Waiting for ${notReadyTeams.join(', ')} to press Ready`
        : !staffAllReady
          ? `Waiting for staff: ${notReadyStaff.join(', ')}`
          : undefined;

  // While the get-ready announcement plays, hold off starting: a countdown
  // started mid-announcement loses its 3-2-1 audio to the busy field speaker.
  // The server enforces the same hold; this just makes it visible.
  const [getReadyHold, setGetReadyHold] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onPlayGetReady(() => {
      setGetReadyHold(true);
      clearTimeout(timer);
      timer = setTimeout(() => setGetReadyHold(false), 3000);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      {/* Participants */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1.5 }}>
            Participants
          </Typography>

          {joinedStations.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Waiting for teams to join from their control pages...
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {/* Red Alliance */}
              <Box sx={{ flex: 1, minWidth: 200 }}>
                <Typography variant="subtitle2" sx={{ color: 'error.main', fontWeight: 700, mb: 1 }}>
                  Red Alliance
                </Typography>
                {redStations.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No teams
                  </Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {redStations.map(s => (
                      <ParticipantRow
                        key={s}
                        station={s}
                        state={stationStates[s]}
                        onSwap={() => sendMatchSwapStation(s)}
                        onKick={() => sendMatchKickStation(s)}
                      />
                    ))}
                  </Box>
                )}
              </Box>

              {/* Blue Alliance */}
              <Box sx={{ flex: 1, minWidth: 200 }}>
                <Typography variant="subtitle2" sx={{ color: 'info.main', fontWeight: 700, mb: 1 }}>
                  Blue Alliance
                </Typography>
                {blueStations.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No teams
                  </Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {blueStations.map(s => (
                      <ParticipantRow
                        key={s}
                        station={s}
                        state={stationStates[s]}
                        onSwap={() => sendMatchSwapStation(s)}
                        onKick={() => sendMatchKickStation(s)}
                      />
                    ))}
                  </Box>
                )}
              </Box>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Staff ready-up */}
      <StaffPanel staffStates={staffStates} readyRequested={readyRequested} />

      {/* Match Config */}
      <Card sx={{ mb: 2, ...(isChallengeConfig(config) && { borderLeft: `6px solid ${CHALLENGE_COLOR}` }) }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            {isChallengeConfig(config) ? `${formatName(config)} Setup` : 'Match Configuration'}
          </Typography>
          <MatchTimeline config={config} />
        </CardContent>
      </Card>

      {/* Ready check + start controls */}
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' }}>
            <Button variant="outlined" color="info" disabled={getReadyHold} onClick={sendPlayGetReady}>
              📢 Get Ready
            </Button>
            {!readyRequested ? (
              <Button
                variant="contained"
                color="primary"
                size="large"
                onClick={() => sendMatchRequestReady(true)}
                sx={{ px: 4, fontWeight: 'bold' }}
              >
                Ask for Ready
              </Button>
            ) : (
              <>
                <Button variant="outlined" color="warning" onClick={() => sendMatchRequestReady(false)}>
                  Retract Ready Check
                </Button>
                <HoldToStartButton
                  canStart={allReady && !getReadyHold}
                  holdDisabledReason={
                    holdDisabledReason ?? (getReadyHold ? 'Get-ready announcement playing — a moment…' : undefined)
                  }
                />
              </>
            )}
            <Button variant="outlined" color="error" onClick={sendMatchCancel}>
              Cancel Match
            </Button>
          </Box>
          {!readyRequested && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, textAlign: 'center' }}>
              Teams and staff can&rsquo;t ready up until you open the ready check.
              {joinedStations.length === 0 && ' Waiting for teams to join…'}
            </Typography>
          )}
          {getReadyHold && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, textAlign: 'center' }}>
              Get-ready announcement playing — starting is enabled again in a moment...
            </Typography>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** Non-team staff ready-up panel — each role can be readied from its /staff
 *  page; the host toggles roles not present this match to "not required". */
function StaffPanel({
  staffStates,
  readyRequested,
}: {
  staffStates: MatchState['staffStates'];
  readyRequested: boolean;
}) {
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          Field Staff
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {StaffRoleList.map(role => {
            const s = staffStates[role];
            const statusLabel = s.ignored
              ? 'Not required'
              : s.ready
                ? 'Ready'
                : s.connected
                  ? readyRequested
                    ? 'Waiting to ready'
                    : 'Connected'
                  : 'Not connected';
            const statusColor: 'success' | 'default' | 'warning' = s.ignored
              ? 'default'
              : s.ready
                ? 'success'
                : 'warning';
            return (
              <Box
                key={role}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  px: 1.5,
                  py: 0.75,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                  opacity: s.ignored ? 0.55 : 1,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {StaffRoleLabels[role]}
                  </Typography>
                  <Chip
                    label={statusLabel}
                    color={statusColor}
                    size="small"
                    variant={s.ready ? 'filled' : 'outlined'}
                    sx={{ height: 20, fontSize: '0.7rem' }}
                  />
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  color={s.ignored ? 'primary' : 'inherit'}
                  onClick={() => sendMatchStaffIgnore(role, !s.ignored)}
                >
                  {s.ignored ? 'Require' : 'Ignore'}
                </Button>
              </Box>
            );
          })}
        </Box>
      </CardContent>
    </Card>
  );
}

/** A single participant row in the pre-match setup */
function ParticipantRow({
  state,
  onSwap,
  onKick,
}: {
  station: StationName;
  state: StationControlState | undefined;
  onSwap: () => void;
  onKick: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TeamAvatar teamNumber={state?.teamNumber} size={22} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {teamLabel(state)}
        </Typography>
        {state?.ready && <Chip label="Ready" color="success" size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
      </Box>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <Button size="small" variant="outlined" onClick={onSwap}>
          Swap
        </Button>
        <Button size="small" variant="outlined" color="error" onClick={onKick}>
          Kick
        </Button>
      </Box>
    </Box>
  );
}

// ── Active match view ───────────────────────────────────────────────

/**
 * Live "resuming in N…" readout. The server sends the wall-clock instant the
 * resume lands rather than ticking seconds at us, so this counts down locally
 * and stays smooth without a broadcast per second.
 */
function ResumeCountdown({ resumeAt }: { resumeAt: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, resumeAt - Date.now()));

  useEffect(() => {
    setRemaining(Math.max(0, resumeAt - Date.now()));
    const id = setInterval(() => setRemaining(Math.max(0, resumeAt - Date.now())), 100);
    return () => clearInterval(id);
  }, [resumeAt]);

  return (
    <Box sx={{ textAlign: 'center' }}>
      <Typography variant="h4" sx={{ fontWeight: 'bold', color: 'success.main', lineHeight: 1 }}>
        Resuming in {Math.ceil(remaining / 1000)}…
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Robots stay disabled until the countdown ends
      </Typography>
    </Box>
  );
}

function ActiveMatchView({
  matchState,
  activeColor,
}: {
  matchState: NonNullable<ReturnType<typeof useMatchState>>;
  activeColor: string;
}) {
  const { phase, remainingTime, totalMatchTime, config, stationStates, awaitingAutoWinner, resumeAt } = matchState;

  const isPaused = phase === 'paused';
  const isResuming = isPaused && resumeAt !== undefined;

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  const progress = useMemo(() => computeBarProgress(totalMatchTime, config), [totalMatchTime, config]);
  // A stopwatch run is timed by what has elapsed, not what is left.
  const countUp = isChallengeConfig(config) && config.challengeTiming === 'stopwatch';

  // Pulse the timer in the last 3 seconds of each game period
  const shouldPulse = useMemo(() => {
    if (remainingTime <= 0) return false;

    // Auto / countdown: pulse at end of the phase
    if (phase === 'auto' || phase === 'countdown') return remainingTime <= 3;

    // During teleop/endgame: pulse at the end of each sub-period boundary
    if (phase === 'teleop' || phase === 'endgame') {
      const teleopDur = config.teleopDuration; // 140
      // Period boundaries are at these remainingTime values:
      // TS ends:        130  (elapsed 10)
      // S1 ends:        105  (elapsed 35)
      // S2 ends:         80  (elapsed 60)
      // S3 ends:         55  (elapsed 85)
      // S4 ends:         30  (elapsed 110)
      // End Game ends:    0  (elapsed 140)
      const boundaries = [
        teleopDur - 10, // 130 — end of transition
        teleopDur - 35, // 105 — end of S1
        teleopDur - 60, //  80 — end of S2
        teleopDur - 85, //  55 — end of S3
        teleopDur - 110, // 30 — end of S4
        0, //               0 — end of endgame
      ];
      for (const b of boundaries) {
        if (remainingTime > b && remainingTime <= b + 3) return true;
      }
    }

    return false;
  }, [phase, remainingTime, config.teleopDuration]);

  return (
    <>
      {/* Timer and progress */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ textAlign: 'center', mb: 1 }}>
            <Chip
              label={awaitingAutoWinner ? 'Awaiting Auto Winner' : phaseLabel(phase, config)}
              sx={{
                fontSize: '1.2rem',
                py: 2.5,
                px: 2,
                fontWeight: 'bold',
                color: activeColor,
                borderColor: activeColor,
                transition: 'color 1s ease, border-color 1s ease',
              }}
              variant="outlined"
            />
          </Box>
          <Box sx={{ mb: 2 }}>
            <MatchTimer
              remainingTime={countUp ? challengeElapsed(matchState) : remainingTime}
              color={activeColor}
              pulse={shouldPulse}
              countUp={countUp}
            />
          </Box>
          <MatchTimeline
            config={config}
            progress={progress}
            autoWinnerAlliance={matchState.autoWinnerAlliance}
            phase={matchState.phase}
            remainingTime={matchState.remainingTime}
          />
        </CardContent>
      </Card>

      <ChallengeTallyPanel matchState={matchState} />

      {/* Auto winner prompt — shown during autoPause in 'pause' mode */}
      {awaitingAutoWinner && (
        <Card sx={{ mb: 2, border: 2, borderColor: 'warning.main' }}>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 2 }}>
              Select Auto Winner
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The match is paused until you select which alliance won autonomous.
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button
                variant="contained"
                size="large"
                onClick={() => sendMatchSetAutoWinner('red')}
                sx={{
                  backgroundColor: '#d32f2f',
                  '&:hover': { backgroundColor: '#b71c1c' },
                  fontWeight: 'bold',
                  px: 4,
                  py: 1.5,
                  fontSize: '1.1rem',
                }}
              >
                Red Wins Auto
              </Button>
              <Button
                variant="contained"
                size="large"
                onClick={() => sendMatchSetAutoWinner('blue')}
                sx={{
                  backgroundColor: '#1565c0',
                  '&:hover': { backgroundColor: '#0d47a1' },
                  fontWeight: 'bold',
                  px: 4,
                  py: 1.5,
                  fontSize: '1.1rem',
                }}
              >
                Blue Wins Auto
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Participants status */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Participants
          </Typography>
          <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography variant="subtitle2" sx={{ color: 'error.main', fontWeight: 700, mb: 0.5 }}>
                Red Alliance
              </Typography>
              {redStations.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  —
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {redStations.map(s => (
                    <ActiveParticipantRow key={s} station={s} state={stationStates[s]} />
                  ))}
                </Box>
              )}
            </Box>
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography variant="subtitle2" sx={{ color: 'info.main', fontWeight: 700, mb: 0.5 }}>
                Blue Alliance
              </Typography>
              {blueStations.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  —
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {blueStations.map(s => (
                    <ActiveParticipantRow key={s} station={s} state={stationStates[s]} />
                  ))}
                </Box>
              )}
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Global match controls */}
      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1.5 }}>
            Match Controls
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {/* Abort countdown — returns to created/setup phase. The start
                button is hold-to-start, so simply letting go also aborts. */}
            {phase === 'countdown' && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Button variant="outlined" color="warning" onClick={sendMatchAbortCountdown}>
                  Abort Countdown
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Keep holding the start button — let go before the horn to abort.
                </Typography>
              </Box>
            )}

            {/* Pause — stays put through the whole running match so it doesn't
                jump around; just disabled when you can't pause yet (during the
                start countdown) or when auto is already paused for the
                transition. Hidden only while paused, where Resume/Abandon
                replace it. */}
            {!isPaused && !isResuming && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Button
                  variant="outlined"
                  color="warning"
                  disabled={phase === 'countdown' || phase === 'autoPause'}
                  onClick={sendStationPauseMatch}
                >
                  Pause Match
                </Button>
                {phase === 'autoPause' && (
                  <Typography variant="caption" color="text.secondary">
                    Auto is already paused for the transition.
                  </Typography>
                )}
              </Box>
            )}

            {/* Paused: resume / abandon */}
            {isPaused && !isResuming && (
              <>
                <Button variant="contained" color="success" onClick={sendStationResumeMatch}>
                  Resume
                </Button>
                <Button variant="outlined" color="error" onClick={sendStationAbandonMatch}>
                  Abandon Match
                </Button>
              </>
            )}

            {/* Resume countdown running — robots are still disabled until it ends */}
            {isResuming && (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <ResumeCountdown resumeAt={resumeAt} />
                <Button variant="outlined" color="warning" onClick={sendStationPauseMatch}>
                  Cancel Resume
                </Button>
              </Box>
            )}

            {/* Global E-Stop — always available during active match */}
            <Button variant="contained" color="error" onClick={sendAdminGlobalEStop} sx={{ fontWeight: 'bold' }}>
              E-Stop All
            </Button>
          </Box>
        </CardContent>
      </Card>
    </>
  );
}

/** A participant row during an active match, with per-station disable/e-stop controls */
function ActiveParticipantRow({ station, state }: { station: StationName; state: StationControlState | undefined }) {
  const phase = useMatchState()?.phase;
  const isEnabled = state?.enabled ?? false;
  const isEStopped = state?.eStop ?? false;
  // Re-enable is only meaningful while robots run; A-Stop latches through auto
  const canEnable =
    (phase === 'auto' || phase === 'teleop' || phase === 'endgame') && !state?.aStop && (state?.joined ?? false);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        border: 1,
        borderColor: isEStopped ? 'error.main' : !isEnabled ? 'warning.main' : 'divider',
        backgroundColor: isEStopped ? 'rgba(211,47,47,0.08)' : !isEnabled ? 'rgba(255,167,38,0.08)' : undefined,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TeamAvatar teamNumber={state?.teamNumber} size={22} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {teamLabel(state)}
        </Typography>
        {isEStopped && (
          <Chip
            label="E-STOPPED"
            color="error"
            size="small"
            sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700 }}
          />
        )}
        {!isEStopped && !isEnabled && (
          <Chip label="Disabled" color="warning" size="small" sx={{ height: 20, fontSize: '0.65rem' }} />
        )}
        {!isEStopped && isEnabled && (
          <Chip label="Enabled" color="success" size="small" sx={{ height: 20, fontSize: '0.65rem' }} />
        )}
      </Box>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        {isEStopped ? (
          <Button size="small" variant="outlined" onClick={() => sendAdminClearEStop(station)}>
            Clear
          </Button>
        ) : (
          <>
            {isEnabled ? (
              <Button size="small" variant="outlined" color="warning" onClick={() => sendAdminStationDisable(station)}>
                Disable
              </Button>
            ) : (
              <Button
                size="small"
                variant="outlined"
                color="success"
                onClick={() => sendAdminStationEnable(station)}
                disabled={!canEnable}
              >
                Enable
              </Button>
            )}
            <Button size="small" variant="contained" color="error" onClick={() => sendAdminStationEStop(station)}>
              E-Stop One
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
}

// ── Post-match view ─────────────────────────────────────────────────

function PostMatchView({ matchState }: { matchState: NonNullable<ReturnType<typeof useMatchState>> }) {
  const { remainingTime, totalMatchTime, config, stationStates, endReason, autoWinnerAlliance } = matchState;

  const isCounting = remainingTime > 0;

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  const progress = useMemo(() => computeBarProgress(totalMatchTime, config), [totalMatchTime, config]);

  const endReasonLabels: Record<string, string> = {
    normal: 'Match Completed',
    completed: 'Match Completed',
    stopped: 'Match Stopped',
    estop: 'Emergency Stopped',
    abandoned: 'Match Abandoned',
    empty: 'All Teams Left',
  };

  return (
    <>
      {/* Result header + timeline */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ textAlign: 'center', mb: 2 }}>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>
              {isCounting ? 'Counting...' : (endReasonLabels[endReason ?? ''] ?? 'Post-Match')}
            </Typography>
            {isCounting && <MatchTimer remainingTime={remainingTime} color={PHASE_HEX.postMatch} />}
            {autoWinnerAlliance && (
              <Typography
                variant="body1"
                sx={{
                  color: autoWinnerAlliance === 'red' ? 'error.main' : 'info.main',
                  fontWeight: 700,
                }}
              >
                Auto Winner: {autoWinnerAlliance === 'red' ? 'Red' : 'Blue'}
              </Typography>
            )}
          </Box>

          {/* Timeline bar at 100% (or near if still counting) */}
          <MatchTimeline
            config={config}
            progress={Math.min(1, progress)}
            autoWinnerAlliance={autoWinnerAlliance}
            phase={matchState.phase}
            remainingTime={matchState.remainingTime}
          />
        </CardContent>
      </Card>

      {/* Tally stays editable after the buzzer — a miscount is always
          noticed a few seconds too late. */}
      <ChallengeTallyPanel matchState={matchState} />

      {/* Participants — still in the match */}
      {joinedStations.length > 0 && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Participants
            </Typography>
            <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {redStations.length > 0 && (
                <Box sx={{ flex: 1, minWidth: 200 }}>
                  <Typography variant="subtitle2" sx={{ color: 'error.main', fontWeight: 700, mb: 0.5 }}>
                    Red Alliance
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {redStations.map(s => (
                      <Box
                        key={s}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          px: 1.5,
                          py: 0.5,
                          borderRadius: 1,
                          border: 1,
                          borderColor: 'divider',
                        }}
                      >
                        <TeamAvatar teamNumber={stationStates[s]?.teamNumber} size={20} />
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {teamLabel(stationStates[s])}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
              {blueStations.length > 0 && (
                <Box sx={{ flex: 1, minWidth: 200 }}>
                  <Typography variant="subtitle2" sx={{ color: 'info.main', fontWeight: 700, mb: 0.5 }}>
                    Blue Alliance
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {blueStations.map(s => (
                      <Box
                        key={s}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          px: 1.5,
                          py: 0.5,
                          borderRadius: 1,
                          border: 1,
                          borderColor: 'divider',
                        }}
                      >
                        <TeamAvatar teamNumber={stationStates[s]?.teamNumber} size={20} />
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {teamLabel(stationStates[s])}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
            </Box>
          </CardContent>
        </Card>
      )}

      <PostMatchRecordings matchId={matchState.matchId} shareToken={matchState.shareToken} />

      {/* Actions — only when counting period is done */}
      {!isCounting && (
        <Card>
          <CardContent>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button
                variant="contained"
                color="primary"
                size="large"
                onClick={sendMatchCreate}
                sx={{ px: 4, py: 1.5, fontSize: '1.1rem', fontWeight: 'bold' }}
              >
                Create New Match
              </Button>
              <Button variant="outlined" onClick={sendMatchClear}>
                Clear Match
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}
    </>
  );
}

/** "Summary" opens the public page for this match; the copy button puts its
 *  URL (with the share token) on the clipboard to text to a team. */
function ShareLinkButtons({ token, size = 'small' }: { token: string; size?: 'small' | 'medium' }) {
  const publicUrl = usePublicUrl();
  const url = matchSummaryUrl(publicUrl, token);
  return (
    <>
      <Button size={size} variant="outlined" href={url} target="_blank" rel="noopener">
        Summary
      </Button>
      <CopyToClipboard text={url} tooltipText="Copy the summary link">
        <Button size={size} variant="outlined">
          Copy link
        </Button>
      </CopyToClipboard>
    </>
  );
}

/** Icon-only share controls for the history list. */
function ShareLinkIcons({ token }: { token: string }) {
  const publicUrl = usePublicUrl();
  const url = matchSummaryUrl(publicUrl, token);
  return (
    <>
      <Tooltip title="Open the match summary">
        <IconButton size="small" color="primary" href={url} target="_blank" rel="noopener">
          <OpenInNewIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <CopyToClipboard text={url} tooltipText="Copy the summary link">
        <IconButton size="small" color="primary">
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </CopyToClipboard>
    </>
  );
}

/** After the match: the QR code teams scan off the TV, the same link for
 *  copying, and one download per recorded stream ("still finalizing" until
 *  the recorder attaches the files to the history entry). */
function PostMatchRecordings({ matchId, shareToken }: { matchId?: string; shareToken?: string }) {
  const history = useMatchHistory();
  const recording = useMatchRecordingState();
  const publicUrl = usePublicUrl();
  if (!matchId) return null;
  const entry = history?.matches.find(m => m.matchId === matchId);
  const busy = recording?.activeMatchId === matchId;
  const token = shareToken ?? entry?.shareToken;
  if (!entry?.recordings?.length && !busy && !token) return null;
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Match Summary &amp; Video
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {token && (
            <Box sx={{ bgcolor: '#fff', p: 1, borderRadius: 1, lineHeight: 0 }}>
              <QRCodeSVG value={matchSummaryUrl(publicUrl, token)} size={112} marginSize={0} />
            </Box>
          )}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 220 }}>
            {token && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <ShareLinkButtons token={token} size="medium" />
              </Box>
            )}
            {busy && !entry?.recordings?.length ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Finalizing the recording…
              </Typography>
            ) : entry?.recordings?.length ? (
              <RecordingButtons match={entry} size="medium" />
            ) : null}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

// ── Match History ──────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const endReasonChip: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'default' }> = {
  normal: { label: 'Completed', color: 'success' },
  stopped: { label: 'Stopped', color: 'warning' },
  estop: { label: 'E-Stopped', color: 'error' },
  abandoned: { label: 'Abandoned', color: 'default' },
};

/** How the match ended, as one icon (label on hover/long-press). */
function EndReasonIcon({ reason }: { reason: string }) {
  const info = endReasonChip[reason] ?? endReasonChip.normal;
  const sx = { fontSize: 20, color: info.color === 'default' ? 'text.disabled' : `${info.color}.main` };
  const icon =
    reason === 'estop' ? (
      <DangerousIcon sx={sx} />
    ) : reason === 'stopped' ? (
      <StopCircleIcon sx={sx} />
    ) : reason === 'abandoned' ? (
      <CancelIcon sx={sx} />
    ) : (
      <CheckCircleIcon sx={sx} />
    );
  return (
    <Tooltip title={info.label}>
      <Box sx={{ display: 'flex', alignItems: 'center' }}>{icon}</Box>
    </Tooltip>
  );
}

/** One alliance's teams for the history grid: avatars + numbers, in the
 *  alliance colour, anchored toward the score so the red|blue split lines up
 *  on every row regardless of how many teams played. */
function HistoryTeams({ teams, color, align }: { teams: MatchHistoryTeam[]; color: string; align: 'left' | 'right' }) {
  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        minWidth: 0,
        overflow: 'hidden',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      {teams.map(t => (
        <Box key={t.station} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, whiteSpace: 'nowrap' }}>
          <TeamAvatar teamNumber={t.teamNumber} size={16} />
          <Typography variant="body2" sx={{ fontWeight: 500, color }}>
            {t.teamNumber}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

function MatchHistorySection({ matches }: { matches: MatchHistoryEntry[] }) {
  // Show most recent first
  const reversed = [...matches].reverse();

  return (
    <Card sx={{ mt: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6">Match History</Typography>
          <Button size="small" color="inherit" onClick={sendClearMatchHistory} sx={{ opacity: 0.6 }}>
            Clear
          </Button>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {reversed.map((match, i) => (
            <MatchHistoryRow key={match.startedAt} match={match} index={matches.length - i} />
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}

/** One alliance's score: human-reviewed value when available (with the sensor
 *  count struck through if it disagreed), otherwise the live sensor count. */
function HistoryScore({
  score,
  review,
  color,
  align,
  won,
}: {
  score: number;
  review?: { score: number };
  color: string;
  align: 'left' | 'right';
  won: boolean;
}) {
  const disagrees = review !== undefined && review.score !== score;
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 0.5,
        flexDirection: align === 'right' ? 'row' : 'row-reverse',
      }}
    >
      {disagrees && (
        <Typography variant="caption" sx={{ color: 'text.disabled', textDecoration: 'line-through' }}>
          {score}
        </Typography>
      )}
      <Typography variant="h6" sx={{ fontWeight: 700, color, minWidth: 40, textAlign: align, opacity: won ? 1 : 0.6 }}>
        {review?.score ?? score}
      </Typography>
    </Box>
  );
}

/** A challenge run's result in a history row — laps, or a finishing time. */
function ChallengeResult({ label, color, align }: { label: string; color: string; align: 'left' | 'right' }) {
  return (
    <Typography variant="body2" sx={{ color, fontWeight: 700, fontFamily: 'monospace', textAlign: align }}>
      {label}
    </Typography>
  );
}

/** What a challenge run's row shows in place of a ball score: laps, or the
 *  finishing time for a stopwatch run. */
function challengeResultLabel(match: MatchHistoryEntry, alliance: Alliance): string | null {
  if (!match.challenge) return null;
  const tally = match.challenge.tally[alliance];
  if (!tally) return null;
  const { laps, seconds } = challengeScore(tally, match.challenge.timing);
  if (match.challenge.timing === 'stopwatch') return seconds === null ? 'DNF' : `${seconds.toFixed(1)}s`;
  return `${laps}`;
}

function MatchHistoryRow({ match, index }: { match: MatchHistoryEntry; index: number }) {
  const redTeams = match.teams.filter(t => t.alliance === 'red');
  const blueTeams = match.teams.filter(t => t.alliance === 'blue');
  const redChallenge = challengeResultLabel(match, 'red');
  const blueChallenge = challengeResultLabel(match, 'blue');
  // Winner from the best-known score: human review beats the sensor count
  const redFinal = match.review?.red?.score ?? match.redScore;
  const blueFinal = match.review?.blue?.score ?? match.blueScore;
  const redWon = redFinal > blueFinal;
  const blueWon = blueFinal > redFinal;
  const fullyReviewed = match.review?.red !== undefined && match.review?.blue !== undefined;

  return (
    <Box
      sx={{
        display: 'grid',
        // #  | red teams | red score | — | blue score | blue teams | duration | actions | end | ago
        // The two team columns share the leftover width equally and the score
        // columns are fixed, so the red|blue split sits at the same x on every row.
        gridTemplateColumns: '36px minmax(0, 1fr) 64px 16px 64px minmax(0, 1fr) 44px auto 28px 56px',
        alignItems: 'center',
        columnGap: 1,
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
        #{index}
      </Typography>
      <HistoryTeams teams={redTeams} color="error.main" align="right" />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        {redChallenge !== null ? (
          <ChallengeResult label={redChallenge} color="error.main" align="right" />
        ) : (
          <HistoryScore
            score={match.redScore}
            review={match.review?.red}
            color="error.main"
            align="right"
            won={redWon}
          />
        )}
      </Box>
      <Typography variant="body2" sx={{ color: 'text.disabled', fontWeight: 300, textAlign: 'center' }}>
        {match.challenge ? (match.challenge.timing === 'stopwatch' ? '⏱' : '↻') : '—'}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
        {blueChallenge !== null ? (
          <ChallengeResult label={blueChallenge} color="info.main" align="left" />
        ) : (
          <HistoryScore
            score={match.blueScore}
            review={match.review?.blue}
            color="info.main"
            align="left"
            won={blueWon}
          />
        )}
      </Box>
      <HistoryTeams teams={blueTeams} color="info.main" align="left" />
      <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {formatDuration(match.durationSeconds)}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <RecordingIconButtons match={match} />
        {match.shareToken && <ShareLinkIcons token={match.shareToken} />}
        {match.reviewUrl && (
          <Tooltip title={fullyReviewed ? 'Reviewed — open the review' : 'Review the video and scores'}>
            <IconButton
              size="small"
              color={fullyReviewed ? 'success' : 'primary'}
              href={match.reviewUrl}
              target="_blank"
              rel="noopener"
            >
              {fullyReviewed ? <TaskAltIcon fontSize="small" /> : <RateReviewIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <EndReasonIcon reason={match.endReason} />
      <Typography variant="caption" sx={{ color: 'text.disabled', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {formatTimeAgo(match.endedAt)}
      </Typography>
    </Box>
  );
}
