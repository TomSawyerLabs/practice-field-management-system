import { useMemo, type MouseEvent } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { TeamAvatar } from './TeamAvatar';
import { AStopPopout, openMatchPopup } from './AStopPopout';
import { MatchPhase, StationName, StationControlState } from '../../../src/types';
import {
  useMatchState,
  sendStationJoin,
  sendStationJoinAlliance,
  sendStationLeave,
  sendStationReady,
  sendStationSelfDisable,
  sendStationSelfUndisable,
  sendStationSelfEStop,
  sendStationSelfAStop,
  sendStationClearAStop,
} from '../hooks/useBackend';
import { MatchTimeline } from './MatchTimeline';

const phaseColors: Record<MatchPhase, string> = {
  idle: 'text.secondary',
  created: 'info.main',
  countdown: 'warning.main',
  auto: 'info.main',
  autoPause: 'text.disabled',
  paused: 'warning.main',
  teleop: 'success.main',
  endgame: 'warning.main',
  postMatch: 'text.secondary',
};

const phaseLabels: Record<MatchPhase, string> = {
  idle: 'Idle',
  created: 'Match Created',
  countdown: 'Countdown',
  auto: 'Autonomous',
  autoPause: 'Pause',
  paused: 'Paused',
  teleop: 'Teleoperated',
  endgame: 'Endgame',
  postMatch: 'Post-Match',
};

function MatchTimer({ remainingTime, phase }: { remainingTime: number; phase: MatchPhase }) {
  const display = Math.ceil(Math.max(0, remainingTime));
  const minutes = Math.floor(display / 60);
  const seconds = display % 60;
  return (
    <Typography
      variant="h2"
      sx={{
        fontFamily: 'monospace',
        textAlign: 'center',
        color: phaseColors[phase],
        lineHeight: 1,
        mb: 1,
      }}
    >
      {minutes}:{seconds.toString().padStart(2, '0')}
    </Typography>
  );
}

/** Build a display label for a joined station chip, using team number. */
function stationChipLabel(
  station: StationName,
  state: StationControlState | undefined,
  allStates: Partial<Record<StationName, StationControlState>>,
) {
  const team = state?.teamNumber;
  if (!team) return 'No Team';

  // Check if another joined station shares the same team number
  const sameTeamStations = (Object.entries(allStates) as [StationName, StationControlState | undefined][]).filter(
    ([s, st]) => st?.joined && st?.teamNumber === team && s !== station,
  ).length;

  const suffix = state?.ready ? ' \u2713' : '';
  if (sameTeamStations > 0) {
    // Disambiguate with alliance tag
    const alliance = state?.alliance;
    const tag = alliance ? (alliance === 'red' ? 'R' : 'B') : '?';
    return `${team}-${tag}${suffix}`;
  }
  return `${team}${suffix}`;
}

/** Compute MatchTimeline progress (0-1) from match state. */
function computeBarProgress(
  totalMatchTime: number,
  config: { autoDuration: number; pauseDuration: number; teleopDuration: number; skipAuto?: boolean },
): number {
  const countdownDuration = 3;
  const barTotal = config.autoDuration + config.pauseDuration + config.teleopDuration;
  if (barTotal <= 0) return 0;
  const elapsed = Math.max(0, totalMatchTime - countdownDuration);
  if (config.skipAuto) {
    const skipOffset = config.autoDuration + config.pauseDuration;
    return Math.min(1, (skipOffset + elapsed) / barTotal);
  }
  return Math.min(1, elapsed / barTotal);
}

/**
 * Match control panel.
 * - With `station` prop: per-station view with join/leave/ready buttons (for station pages)
 * - Without `station` prop: master overview (for main page)
 *
 * NOTE: Start/Pause/Resume/Abandon are NOT available from station views.
 * Those controls are only on the /match controller page.
 */
/** Self-service controls while a match is running: disable / re-enable,
 *  A-Stop, and E-Stop. E-Stop fires on the first tap — an emergency stop must
 *  never wait, and field staff can clear an accidental one. The `blurring`
 *  wrapper still drops focus so a later stray Space/Enter meant for the Driver
 *  Station can't re-fire it. Re-enable is the recovery path after an accidental
 *  disable (console button or DS Enter key), and after staff clear an e-stop. */
function SelfServiceControls({
  station,
  phase,
  myState,
}: {
  station: StationName;
  phase: MatchPhase;
  myState: StationControlState | undefined;
}) {
  const robotsRunning = phase === 'auto' || phase === 'teleop' || phase === 'endgame';
  const staffDisabled = myState?.disabledBy === 'admin';

  // Blur after every activation: the browser "clicks" the focused button on
  // Space/Enter, and drivers hit those keys aiming for the Driver Station —
  // a previously-tapped robot-stopping (or -starting) button must not fire.
  const blurring = (fn: () => void) => (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    fn();
  };

  return (
    <>
      {/* Countdown: backing out aborts the 3-2-1 and returns everyone to setup */}
      {phase === 'countdown' && (
        <Button variant="outlined" color="warning" onClick={blurring(() => sendStationReady(station, false))}>
          Not Ready — Cancel Countdown
        </Button>
      )}
      {myState?.enabled ? (
        <Button variant="outlined" color="warning" onClick={blurring(() => sendStationSelfDisable(station))}>
          Disable
        </Button>
      ) : myState?.eStop || myState?.aStop ? null : robotsRunning ? (
        <>
          <Button
            variant="contained"
            color="success"
            onClick={blurring(() => sendStationSelfUndisable(station))}
            disabled={staffDisabled}
          >
            Re-enable
          </Button>
          {staffDisabled && (
            <Typography variant="caption" color="warning.main" sx={{ width: '100%' }}>
              Disabled by field staff — they can re-enable you from the admin console.
            </Typography>
          )}
        </>
      ) : (
        <Button variant="outlined" color="warning" disabled>
          Disable
        </Button>
      )}
      {/* A-Stop: only meaningful before/during auto; self-releases at teleop */}
      {(phase === 'countdown' || phase === 'auto') &&
        (myState?.aStop ? (
          <Chip label="A-Stopped until teleop" size="small" color="warning" />
        ) : (
          <Button
            variant="contained"
            color="warning"
            size="small"
            onClick={blurring(() => sendStationSelfAStop(station))}
          >
            A-Stop
          </Button>
        ))}
      {myState?.eStop ? (
        <Chip label="E-Stopped — field staff can clear it" size="small" color="error" />
      ) : (
        <Button variant="contained" color="error" size="small" onClick={blurring(() => sendStationSelfEStop(station))}>
          E-Stop
        </Button>
      )}
      <Button variant="outlined" onClick={() => sendStationLeave(station)}>
        Leave Match
      </Button>
    </>
  );
}

export function MatchPanel({ station }: { station?: StationName }) {
  const matchState = useMatchState();
  if (!matchState) return null;

  const { phase, remainingTime, totalMatchTime, config, stationStates, readyRequested } = matchState;

  const isActive = phase !== 'idle' && phase !== 'postMatch' && phase !== 'created';
  const isPostMatch = phase === 'postMatch';
  const isCreated = phase === 'created';

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  // Per-station state (only when station prop is provided)
  const myState = station ? stationStates[station] : undefined;
  const joined = myState?.joined ?? false;
  const ready = myState?.ready ?? false;

  // Master view: any station joined means we show controls
  const anyJoined = joinedStations.length > 0;

  const progress = useMemo(() => computeBarProgress(totalMatchTime, config), [totalMatchTime, config]);

  // Don't render at all if phase is idle (no match created)
  if (phase === 'idle') return null;

  // Don't render the master panel at all if nothing is happening
  if (!station && !anyJoined && !isActive && !isPostMatch && !isCreated) return null;

  // Don't render per-station panel if no team is configured and no match is active
  if (station && !myState?.teamNumber && !isActive && !isPostMatch && !isCreated) return null;

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        {/* Phase display when active or post-match */}
        {(isActive || isPostMatch) && (
          <>
            <Box sx={{ textAlign: 'center', mb: 1 }}>
              <Chip
                label={matchState.awaitingAutoWinner ? 'Awaiting Auto Winner' : phaseLabels[phase]}
                sx={{
                  fontSize: '1rem',
                  py: 2,
                  px: 1.5,
                  fontWeight: 'bold',
                  color: phaseColors[phase],
                  borderColor: phaseColors[phase],
                }}
                variant="outlined"
              />
            </Box>
            <MatchTimer remainingTime={remainingTime} phase={phase} />
            <Box sx={{ mb: 2 }}>
              <MatchTimeline
                config={config}
                progress={progress}
                autoWinnerAlliance={matchState.autoWinnerAlliance}
                phase={matchState.phase}
                remainingTime={matchState.remainingTime}
              />
            </Box>
          </>
        )}

        {/* Created state: show who has joined */}
        {isCreated && (
          <Box sx={{ textAlign: 'center', mb: 1 }}>
            <Chip
              label={phaseLabels.created}
              sx={{
                fontSize: '1rem',
                py: 2,
                px: 1.5,
                fontWeight: 'bold',
                color: phaseColors.created,
                borderColor: phaseColors.created,
              }}
              variant="outlined"
            />
          </Box>
        )}

        {/* Idle/created/waiting: show who has joined */}
        {!isActive && !isPostMatch && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1.5 }}>
            {joinedStations.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No stations joined yet
              </Typography>
            )}
            {joinedStations.map(s => (
              <Chip
                key={s}
                avatar={<TeamAvatar teamNumber={stationStates[s]?.teamNumber} size={20} />}
                label={stationChipLabel(s, stationStates[s], stationStates)}
                size="small"
                color={stationStates[s]?.ready ? 'success' : 'default'}
                variant="outlined"
              />
            ))}
          </Box>
        )}

        {/* Action buttons */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {station && (
            <>
              {/* Not joined, match created: join button. Opening the guide
                  window inside the click keeps it pop-up-blocker-proof. */}
              {!joined && isCreated && (
                <Button
                  variant="contained"
                  color="primary"
                  onClick={() => {
                    openMatchPopup();
                    sendStationJoin(station);
                  }}
                >
                  Join Match
                </Button>
              )}

              {/* Joined, match created (not active): ready / leave */}
              {joined && isCreated && (
                <>
                  <Button
                    variant={ready ? 'outlined' : 'contained'}
                    color={ready ? 'warning' : 'success'}
                    disabled={!ready && !readyRequested}
                    onClick={() => sendStationReady(station, !ready)}
                  >
                    {ready ? 'Not Ready' : readyRequested ? 'Ready' : 'Waiting for host…'}
                  </Button>
                  <Button variant="outlined" color="error" onClick={() => sendStationLeave(station)} disabled={ready}>
                    Leave
                  </Button>
                  {myState?.aStop ? (
                    <>
                      <Chip label="A-Stop armed — robot sits out auto" size="small" color="warning" />
                      <Button
                        variant="outlined"
                        color="warning"
                        size="small"
                        onClick={() => sendStationClearAStop(station)}
                      >
                        Cancel A-Stop
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outlined"
                      color="warning"
                      size="small"
                      onClick={() => sendStationSelfAStop(station)}
                    >
                      A-Stop
                    </Button>
                  )}
                  {!ready && myState?.dsAttached === false && (
                    <Typography variant="caption" color="warning.main" sx={{ width: '100%' }}>
                      The Driver Station isn't talking to the field yet — you can still ready up, but the robot won't
                      enable until it connects.
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
                    Robot is under field control and disabled until the match starts — leave the match to drive freely.
                  </Typography>
                </>
              )}

              {/* Active match: self-service controls */}
              {joined && isActive && <SelfServiceControls station={station} phase={phase} myState={myState} />}

              {/* Post-match: leave to get control back */}
              {joined && isPostMatch && (
                <Button variant="outlined" color="primary" onClick={() => sendStationLeave(station)}>
                  Leave Match
                </Button>
              )}

              {/* Match pop-out window controller — always mounted so the
                  window survives phase transitions instead of being torn
                  down between blocks */}
              <AStopPopout station={station} />
            </>
          )}
        </Box>

        {/* Match timing config — visual timeline (only during created phase when joined) */}
        {isCreated && (station ? joined : anyJoined) && <MatchTimeline config={config} />}
      </CardContent>
    </Card>
  );
}

/**
 * Build a display label for a joined station chip in the control page context.
 * Uses team number — never exposes physical slot / radio identifiers.
 */
function controlChipLabel(_station: StationName, state: StationControlState | undefined) {
  const team = state?.teamNumber;
  const readySuffix = state?.ready ? ' \u2713' : '';
  const alliance = state?.alliance;
  const allianceTag = alliance ? `${alliance === 'red' ? 'R' : 'B'}` : '';
  if (team) return `${allianceTag} ${team}${readySuffix}`;
  return `No Team${readySuffix}`;
}

/**
 * Team-centric match panel for the /<ssid> page.
 * Shows "Join Red" / "Join Blue" buttons instead of "Join Match".
 * Does not reference station names like "Blue 1" or "Red 2".
 *
 * NOTE: Start/Pause/Resume/Abandon are NOT available here.
 * Those controls are only on the /match controller page.
 */
export function MatchPanelForControl({ station }: { station: StationName; ssid: string }) {
  const matchState = useMatchState();
  if (!matchState) return null;

  const { phase, remainingTime, totalMatchTime, config, stationStates, readyRequested } = matchState;

  const isActive = phase !== 'idle' && phase !== 'postMatch' && phase !== 'created';
  const isPostMatch = phase === 'postMatch';
  const isCreated = phase === 'created';

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const myState = stationStates[station];
  const joined = myState?.joined ?? false;
  const ready = myState?.ready ?? false;
  const myAlliance = myState?.alliance ?? null;

  const progress = useMemo(() => computeBarProgress(totalMatchTime, config), [totalMatchTime, config]);

  // Don't render at all if phase is idle (no match created)
  if (phase === 'idle') return null;

  // Don't render if no team is configured and no match is active
  if (!myState?.teamNumber && !isActive && !isPostMatch && !isCreated) return null;

  // Group joined stations by alliance for display
  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        {/* Phase display when active */}
        {(isActive || isPostMatch) && (
          <>
            <Box sx={{ textAlign: 'center', mb: 1 }}>
              <Chip
                label={matchState.awaitingAutoWinner ? 'Awaiting Auto Winner' : phaseLabels[phase]}
                sx={{
                  fontSize: '1rem',
                  py: 2,
                  px: 1.5,
                  fontWeight: 'bold',
                  color: phaseColors[phase],
                  borderColor: phaseColors[phase],
                }}
                variant="outlined"
              />
              {myAlliance && (
                <Typography
                  variant="body2"
                  sx={{ mt: 0.5, color: myAlliance === 'red' ? 'error.main' : 'info.main', fontWeight: 700 }}
                >
                  Playing {myAlliance === 'red' ? 'Red' : 'Blue'} Alliance
                </Typography>
              )}
            </Box>
            <MatchTimer remainingTime={remainingTime} phase={phase} />
            <Box sx={{ mb: 2 }}>
              <MatchTimeline
                config={config}
                progress={progress}
                autoWinnerAlliance={matchState.autoWinnerAlliance}
                phase={matchState.phase}
                remainingTime={matchState.remainingTime}
              />
            </Box>
          </>
        )}

        {/* Created state: header badge */}
        {isCreated && (
          <Box sx={{ textAlign: 'center', mb: 1 }}>
            <Chip
              label={phaseLabels.created}
              sx={{
                fontSize: '1rem',
                py: 2,
                px: 1.5,
                fontWeight: 'bold',
                color: phaseColors.created,
                borderColor: phaseColors.created,
              }}
              variant="outlined"
            />
          </Box>
        )}

        {/* Pre-match / created: show who has joined, grouped by alliance */}
        {isCreated && (
          <Box sx={{ mb: 1.5 }}>
            {joinedStations.length === 0 && !joined && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                No teams joined yet. Choose an alliance to join the match.
              </Typography>
            )}
            {(redStations.length > 0 || blueStations.length > 0) && (
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                {redStations.length > 0 && (
                  <Box>
                    <Typography variant="caption" sx={{ color: 'error.main', fontWeight: 700 }}>
                      Red Alliance
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                      {redStations.map(s => (
                        <Chip
                          key={s}
                          avatar={<TeamAvatar teamNumber={stationStates[s]?.teamNumber} size={20} />}
                          label={controlChipLabel(s, stationStates[s])}
                          size="small"
                          color={stationStates[s]?.ready ? 'success' : 'default'}
                          variant={s === station ? 'filled' : 'outlined'}
                          sx={s === station ? { fontWeight: 'bold' } : {}}
                        />
                      ))}
                    </Box>
                  </Box>
                )}
                {blueStations.length > 0 && (
                  <Box>
                    <Typography variant="caption" sx={{ color: 'info.main', fontWeight: 700 }}>
                      Blue Alliance
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                      {blueStations.map(s => (
                        <Chip
                          key={s}
                          avatar={<TeamAvatar teamNumber={stationStates[s]?.teamNumber} size={20} />}
                          label={controlChipLabel(s, stationStates[s])}
                          size="small"
                          color={stationStates[s]?.ready ? 'success' : 'default'}
                          variant={s === station ? 'filled' : 'outlined'}
                          sx={s === station ? { fontWeight: 'bold' } : {}}
                        />
                      ))}
                    </Box>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Action buttons */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {/* Not joined, match created: Join Red / Join Blue buttons */}
          {!joined && isCreated && (
            <>
              {/* Opening the guide window inside the click keeps it pop-up-blocker-proof */}
              <Button
                variant="contained"
                onClick={() => {
                  openMatchPopup();
                  sendStationJoinAlliance(station, 'red');
                }}
                sx={{
                  backgroundColor: '#d32f2f',
                  '&:hover': { backgroundColor: '#b71c1c' },
                  fontWeight: 'bold',
                  flex: 1,
                  minWidth: 120,
                }}
              >
                Join Red
              </Button>
              <Button
                variant="contained"
                onClick={() => {
                  openMatchPopup();
                  sendStationJoinAlliance(station, 'blue');
                }}
                sx={{
                  backgroundColor: '#1565c0',
                  '&:hover': { backgroundColor: '#0d47a1' },
                  fontWeight: 'bold',
                  flex: 1,
                  minWidth: 120,
                }}
              >
                Join Blue
              </Button>
            </>
          )}

          {/* Joined, match created: ready / leave / switch alliance */}
          {joined && isCreated && (
            <>
              <Button
                variant={ready ? 'outlined' : 'contained'}
                color={ready ? 'warning' : 'success'}
                disabled={!ready && !readyRequested}
                onClick={() => sendStationReady(station, !ready)}
              >
                {ready ? 'Not Ready' : readyRequested ? 'Ready' : 'Waiting for host…'}
              </Button>
              {!ready && myAlliance && (
                <Button
                  variant="outlined"
                  onClick={() => sendStationJoinAlliance(station, myAlliance === 'red' ? 'blue' : 'red')}
                  sx={{
                    borderColor: myAlliance === 'red' ? '#1565c0' : '#d32f2f',
                    color: myAlliance === 'red' ? '#1565c0' : '#d32f2f',
                    '&:hover': {
                      borderColor: myAlliance === 'red' ? '#0d47a1' : '#b71c1c',
                      backgroundColor: myAlliance === 'red' ? 'rgba(21,101,192,0.08)' : 'rgba(211,47,47,0.08)',
                    },
                  }}
                >
                  Switch to {myAlliance === 'red' ? 'Blue' : 'Red'}
                </Button>
              )}
              <Button variant="outlined" color="error" onClick={() => sendStationLeave(station)} disabled={ready}>
                Leave
              </Button>
              {myState?.aStop ? (
                <>
                  <Chip label="A-Stop armed — robot sits out auto" size="small" color="warning" />
                  <Button
                    variant="outlined"
                    color="warning"
                    size="small"
                    onClick={() => sendStationClearAStop(station)}
                  >
                    Cancel A-Stop
                  </Button>
                </>
              ) : (
                <Button variant="outlined" color="warning" size="small" onClick={() => sendStationSelfAStop(station)}>
                  A-Stop
                </Button>
              )}
              {!ready && myState?.dsAttached === false && (
                <Typography variant="caption" color="warning.main" sx={{ width: '100%' }}>
                  The Driver Station isn't talking to the field yet — you can still ready up, but the robot won't enable
                  until it connects.
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
                Robot is under field control and disabled until the match starts — leave the match to drive freely.
              </Typography>
            </>
          )}

          {/* Active match: self-service controls */}
          {joined && isActive && <SelfServiceControls station={station} phase={phase} myState={myState} />}

          {/* Post-match: leave */}
          {joined && isPostMatch && (
            <Button variant="outlined" color="primary" onClick={() => sendStationLeave(station)}>
              Leave Match
            </Button>
          )}

          {/* Match pop-out window controller — always mounted so the window
              survives phase transitions instead of being torn down */}
          <AStopPopout station={station} />
        </Box>

        {/* Match timing config — visual timeline (created phase only, when joined) */}
        {isCreated && joined && <MatchTimeline config={config} />}
      </CardContent>
    </Card>
  );
}
