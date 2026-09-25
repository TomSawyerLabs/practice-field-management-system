import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { Alliance, StaffRole, StaffRoleList, StaffRoleLabels, isStaffRole } from '../../../src/types';
import { useMatchState, sendStaffReady, sendStaffHeartbeat } from '../hooks/useBackend';
import { useDsClientStation, DsClientBlock } from './DsClientGuard';
import { ChallengeTallyPanel } from './ChallengeTallyPanel';

/** Which side of the field this phone is on, kept in ?alliance=red|blue so
 *  it survives a reload and can be bookmarked. A line ref at one end only
 *  wants that side's hand-off button; undefined shows both. */
function allianceFromUrl(): Alliance | undefined {
  try {
    const a = new URLSearchParams(window.location.search).get('alliance');
    return a === 'red' || a === 'blue' ? a : undefined;
  } catch {
    return undefined;
  }
}

function useSide(): [Alliance | undefined, (side: Alliance | undefined) => void] {
  const [side, setSide] = useState<Alliance | undefined>(allianceFromUrl);
  return [
    side,
    next => {
      setSide(next);
      const url = new URL(window.location.href);
      if (next) url.searchParams.set('alliance', next);
      else url.searchParams.delete('alliance');
      window.history.replaceState(null, '', url);
    },
  ];
}

/** Both / Red / Blue. Shown whenever the field is set up for a challenge. */
function SidePicker({ side, onChange }: { side: Alliance | undefined; onChange: (s: Alliance | undefined) => void }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2, flexWrap: 'wrap' }}>
      <Typography variant="body2" color="text.secondary">
        Your side of the field
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={side ?? 'both'}
        onChange={(_, v: string | null) => {
          if (v === null) return;
          onChange(v === 'red' || v === 'blue' ? v : undefined);
        }}
      >
        <ToggleButton value="both" sx={{ px: 2 }}>
          Both
        </ToggleButton>
        <ToggleButton value="red" sx={{ px: 2, '&.Mui-selected': { backgroundColor: '#d32f2f', color: '#fff' } }}>
          Red
        </ToggleButton>
        <ToggleButton value="blue" sx={{ px: 2, '&.Mui-selected': { backgroundColor: '#1565c0', color: '#fff' } }}>
          Blue
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
}

/** Read the staff role from ?role=… (bookmarkable per device). */
function roleFromUrl(): StaffRole | null {
  try {
    const r = new URLSearchParams(window.location.search).get('role');
    return isStaffRole(r) ? r : null;
  } catch {
    return null;
  }
}

/** Field-staff ready-up page. One per role (?role=headRef|scorekeeper|safety).
 *  Mirrors a driver station's ready flow: locked until the host opens the ready
 *  check, then a big Ready toggle. */
export function StaffPage() {
  const role = roleFromUrl();
  const dsStation = useDsClientStation();

  // Presence heartbeat so the host sees this role as connected. Runs whenever a
  // valid role is selected; the effect's cleanup stops it if the role changes.
  // A DS device must not register as staff, so the beat waits until the DS
  // check has an answer (null = confirmed not a DS) rather than assuming.
  useEffect(() => {
    if (!role || dsStation !== null) return;
    sendStaffHeartbeat(role);
    const iv = setInterval(() => sendStaffHeartbeat(role), 2000);
    return () => clearInterval(iv);
  }, [role, dsStation]);

  if (dsStation) return <DsClientBlock station={dsStation} roleNoun="field staff" />;

  if (!role) return <RolePicker />;

  return <StaffConsole role={role} />;
}

function RolePicker() {
  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Typography variant="h4" sx={{ mb: 1, fontWeight: 700 }}>
        Field Staff
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Choose your role to ready up for matches.
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {StaffRoleList.map(r => (
          <Button
            key={r}
            variant="contained"
            size="large"
            href={`/staff?role=${r}`}
            sx={{ py: 1.5, fontWeight: 'bold' }}
          >
            {StaffRoleLabels[r]}
          </Button>
        ))}
      </Box>
    </Container>
  );
}

function StaffConsole({ role }: { role: StaffRole }) {
  const matchState = useMatchState();
  const label = StaffRoleLabels[role];
  const [alliance, setAlliance] = useSide();

  const phase = matchState?.phase;
  const readyRequested = matchState?.readyRequested ?? false;
  const roleState = matchState?.staffStates?.[role];
  const ready = roleState?.ready ?? false;
  const ignored = roleState?.ignored ?? false;
  const inSetup = phase === 'created';

  const canToggle = inSetup && !ignored && (ready || readyRequested);

  let statusLine: string;
  if (!matchState) statusLine = 'Connecting…';
  else if (!inSetup)
    statusLine =
      phase === 'idle' || phase === undefined
        ? 'No match is being set up right now.'
        : phase === 'postMatch'
          ? 'Match finished.'
          : 'Match in progress.';
  else if (ignored) statusLine = 'The host marked this role not required for this match.';
  else if (!readyRequested) statusLine = 'Waiting for the host to open the ready check…';
  else if (ready) statusLine = 'You are ready. The match starts once everyone is ready.';
  else statusLine = 'The host opened the ready check — ready up when you are set.';

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          {label}
        </Typography>
        <Button variant="text" size="small" href="/staff">
          Change role
        </Button>
      </Box>

      <Card>
        <CardContent sx={{ textAlign: 'center', py: 4 }}>
          {inSetup && !ignored && (
            <Button
              variant={ready ? 'outlined' : 'contained'}
              color={ready ? 'warning' : 'success'}
              size="large"
              disabled={!canToggle}
              onClick={() => sendStaffReady(role, !ready)}
              sx={{ px: 6, py: 2, fontSize: '1.3rem', fontWeight: 'bold', mb: 2 }}
            >
              {ready ? '✓ Ready — tap to un-ready' : readyRequested ? 'Ready Up' : 'Waiting for host…'}
            </Button>
          )}
          {ignored && <Chip label="Not required this match" color="default" sx={{ mb: 2 }} />}
          <Typography color="text.secondary">{statusLine}</Typography>
        </CardContent>
      </Card>

      {/* During a challenge this page is also the line ref's phone: laps,
          penalties and — in a relay — the hand-off button for their side. */}
      {matchState?.challenge && (
        <>
          <SidePicker side={alliance} onChange={setAlliance} />
          <Box sx={{ mt: 1.5 }}>
            <ChallengeTallyPanel matchState={matchState} alliance={alliance} />
          </Box>
        </>
      )}
    </Container>
  );
}
