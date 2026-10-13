import { useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { EStopSource, MatchState, StationControlState, StationName } from '../../../src/types';
import { sendAdminClearFieldEStop, sendAdminGlobalEStop, useMatchState } from '../hooks/useBackend';

// ── Why a robot is e-stopped ────────────────────────────────────────

export type EStopReason = {
  /** `field`: the field E-Stop, every robot. `robot`: this robot's own. */
  scope: 'field' | 'robot';
  /** Short, shouty: what the team sees first. */
  title: string;
  /** What happened and what to do about it, for the team. */
  detail: string;
};

const ROBOT_ESTOP_DETAIL: Record<EStopSource, string> = {
  ds:
    'Your Driver Station’s own E-Stop stopped it (the E-Stop button, or the Space bar — even when the DS isn’t the ' +
    'focused window). Only your robot is stopped. Reboot the roboRIO to clear the Driver Station’s side, and ask ' +
    'field staff to clear the field’s.',
  team:
    'Someone pressed E-Stop on your team’s pFMS page. Only your robot is stopped. Field staff clear it; then enable ' +
    'again from your Driver Station.',
  staff:
    'Field staff e-stopped your robot. Only your robot is stopped. Talk to field staff: they clear it, then you ' +
    'enable again from your Driver Station.',
};

/** Why this station is e-stopped, in words for its team; null when it isn't.
 *  The field E-Stop comes first: clearing the robot's own e-stop alone
 *  wouldn't let it drive. */
export function eStopReason(
  state: StationControlState | undefined,
  fieldEStop: MatchState['fieldEStop'],
): EStopReason | null {
  if (fieldEStop) {
    const own = state?.eStopBy ? ' Your robot is also e-stopped on its own, which field staff clear separately.' : '';
    return {
      scope: 'field',
      title: 'FIELD E-STOP',
      detail:
        'Field staff stopped every robot on the field — this is not about your robot alone. Wait for field staff ' +
        `to clear it, then enable again from your Driver Station.${own}`,
    };
  }
  if (!state?.eStop) return null;
  return {
    scope: 'robot',
    title: 'E-STOPPED — your robot',
    detail: ROBOT_ESTOP_DETAIL[state.eStopBy ?? 'staff'],
  };
}

function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── Team pages ──────────────────────────────────────────────────────

/** The big E-STOPPED notice on a team's page: shown whenever the field
 *  E-Stop is latched (whether or not the team has a robot on the field), or
 *  when this team's robot is e-stopped on its own — with the reason, so the
 *  team knows whether it's theirs to sort out or the whole field's. */
export function TeamEStopBanner({ station }: { station?: StationName }) {
  const matchState = useMatchState();
  if (!matchState) return null;
  const reason = eStopReason(station ? matchState.stationStates[station] : undefined, matchState.fieldEStop);
  if (!reason) return null;
  return (
    <Alert
      severity="error"
      variant="filled"
      sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' }, '& .MuiAlert-icon': { fontSize: '2.5rem' } }}
    >
      <AlertTitle sx={{ fontSize: '2rem', fontWeight: 900, lineHeight: 1.1, mb: 0.5 }}>
        E-STOPPED
        <Typography component="span" sx={{ display: 'block', fontSize: '1.1rem', fontWeight: 700 }}>
          {reason.scope === 'field' ? 'Field E-Stop — every robot on the field' : 'Your robot only'}
          {reason.scope === 'field' && matchState.fieldEStop && ` · since ${clockTime(matchState.fieldEStop.since)}`}
        </Typography>
      </AlertTitle>
      {reason.detail}
    </Alert>
  );
}

// ── Staff pages ─────────────────────────────────────────────────────

/** The field E-Stop for staff pages (/match, /admin): one big button that
 *  latches a stop on every robot on the field. Once latched it becomes a
 *  banner with the way to clear it, in every phase, so the latch can never
 *  be left with no Clear on screen. */
export function FieldEStopControl() {
  const matchState = useMatchState();
  const [confirmClear, setConfirmClear] = useState(false);
  const fieldEStop = matchState?.fieldEStop;

  if (!fieldEStop) {
    return (
      <Box sx={{ mb: 2 }}>
        <Button
          variant="contained"
          color="error"
          fullWidth
          sx={{ fontSize: '1.75rem', py: 2.5, fontWeight: 900, letterSpacing: 2, flexDirection: 'column' }}
          onClick={() => sendAdminGlobalEStop()}
        >
          E-STOP
          <Typography
            component="span"
            sx={{ fontSize: '0.9rem', fontWeight: 600, letterSpacing: 0, textTransform: 'none' }}
          >
            Stops every robot on the field, in a match or not, until cleared
          </Typography>
        </Button>
      </Box>
    );
  }

  return (
    <Alert
      severity="error"
      variant="filled"
      sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' }, '& .MuiAlert-icon': { fontSize: '2.5rem' } }}
    >
      <AlertTitle sx={{ fontSize: '1.75rem', fontWeight: 900 }}>FIELD E-STOPPED</AlertTitle>
      Every robot on the field has been stopped since {clockTime(fieldEStop.since)}. Every team’s page and the
      scoreboard say so. No match can start until the field E-Stop is cleared.
      <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        {confirmClear ? (
          <>
            <Typography sx={{ fontWeight: 700 }}>Is the field safe for robots to drive?</Typography>
            <Button
              variant="contained"
              color="inherit"
              sx={{ color: 'error.main', fontWeight: 700 }}
              onClick={() => {
                sendAdminClearFieldEStop();
                setConfirmClear(false);
              }}
            >
              Yes, clear the field E-Stop
            </Button>
            <Button color="inherit" onClick={() => setConfirmClear(false)}>
              Not yet
            </Button>
          </>
        ) : (
          <Button variant="outlined" color="inherit" sx={{ fontWeight: 700 }} onClick={() => setConfirmClear(true)}>
            Clear field E-Stop
          </Button>
        )}
      </Box>
    </Alert>
  );
}
