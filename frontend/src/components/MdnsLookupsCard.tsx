import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import type { MdnsLookupEvent, MdnsQuestion, StationName } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import { serverToBrowserTime, staffAuthHeaders } from '../hooks/useBackend';
import { HostDisplay } from './HostDisplay';

const REFRESH_MS = 5_000;
const SHOWN = 150;

/** The newest lookups, refreshed while the page is open. Null until the first reply. */
function useMdnsLookups(): { events: MdnsLookupEvent[] | null; error: string | null } {
  const [events, setEvents] = useState<MdnsLookupEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch('/api/mdns-lookups?limit=500', { cache: 'no-store', headers: staffAuthHeaders() });
        const body = (await res.json()) as { events?: MdnsLookupEvent[]; error?: string };
        if (stopped) return;
        if (!res.ok) setError(body.error ?? `HTTP ${res.status}`);
        else {
          setEvents(body.events ?? []);
          setError(null);
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return { events, error };
}

function Clock({ t }: { t: number }) {
  const at = new Date(serverToBrowserTime(t));
  return (
    <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
      {at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
        {at.toISOString().slice(11, 19)}Z
      </Typography>
    </Box>
  );
}

function Questions({ questions }: { questions: MdnsQuestion[] }) {
  const shown = questions.slice(0, 3);
  return (
    <>
      {shown.map((q, i) => (
        <Box key={i} component="span" sx={{ display: 'block', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {q.name}{' '}
          <Typography component="span" variant="caption" color="text.secondary">
            {q.type}
            {q.qu ? ' QU' : ''}
          </Typography>
        </Box>
      ))}
      {questions.length > shown.length && (
        <Typography variant="caption" color="text.secondary">
          and {questions.length - shown.length} more
        </Typography>
      )}
    </>
  );
}

const station = (s: StationName, team: number) => `${prettyStationName(s)} (${team})`;

function Row({ event }: { event: MdnsLookupEvent }) {
  let who: React.ReactNode = null;
  let what: React.ReactNode = null;
  let outcome: React.ReactNode;
  switch (event.kind) {
    case 'forwarded':
      who = <HostDisplay ip={event.requester} />;
      what = <Questions questions={event.questions} />;
      outcome = <Chip size="small" variant="outlined" label={`Asked ${station(event.station, event.team)}`} />;
      break;
    case 'answered':
      who = event.to.map(to => (
        <Box key={to} component="span" sx={{ display: 'block' }}>
          <HostDisplay ip={to.split(':')[0]} />
        </Box>
      ));
      what = event.records.map((r, i) => (
        <Box key={i} component="span" sx={{ display: 'block', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {r.name}
          {r.resolvedIp ? ` → ${r.resolvedIp}` : ''}
        </Box>
      ));
      outcome = (
        <Chip size="small" color="success" label={`Answered by ${event.from}, ${station(event.station, event.team)}`} />
      );
      break;
    case 'unanswered':
      who = <HostDisplay ip={event.requester} />;
      what = <Questions questions={[{ name: event.name, type: '', qu: false }]} />;
      outcome = (
        <Chip size="small" color="warning" label={`No answer from ${prettyStationName(event.station)} in 3 s`} />
      );
      break;
    case 'dropped':
      who = <HostDisplay ip={event.requester} />;
      what = <Questions questions={event.questions} />;
      outcome = (
        <Chip
          size="small"
          color="default"
          label={
            event.reason === 'not placed'
              ? 'Not sent: pFMS doesn’t know this device’s robot'
              : event.reason === 'no team on station'
                ? 'Not sent: its station has no robot'
                : 'Not sent: the station’s mDNS socket isn’t open'
          }
        />
      );
      break;
    case 'send failed':
      who = <HostDisplay ip={event.to.split(':')[0]} />;
      outcome = <Chip size="small" color="error" label={`Answer not delivered: ${event.error}`} />;
      break;
  }
  return (
    <TableRow>
      <TableCell sx={{ verticalAlign: 'top' }}>
        <Clock t={event.t} />
      </TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>{who}</TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>{what}</TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>
        {outcome}
        {event.repeatsBefore ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            and {event.repeatsBefore} more like it before this
          </Typography>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/**
 * The mDNS reflector's lookups and what became of each, newest first: asked
 * of a robot, answered (and to whom), unanswered, or not sent and why.
 */
export function MdnsLookupsCard() {
  const { events, error } = useMdnsLookups();
  const [showUnplaced, setShowUnplaced] = useState(false);
  const shown = (events ?? [])
    .filter(e => showUnplaced || !(e.kind === 'dropped' && e.reason === 'not placed'))
    .slice(-SHOWN)
    .reverse();

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="h6">Name lookups (.local)</Typography>
          <FormControlLabel
            control={<Switch size="small" checked={showUnplaced} onChange={e => setShowUnplaced(e.target.checked)} />}
            label={<Typography variant="body2">Include devices not tied to a robot</Typography>}
          />
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          A laptop looking up a robot&apos;s device by name (limelight.local, roboRIO-TEAM-FRC.local…), and what
          happened to it. Repeats within 30 s are folded into a count.
        </Typography>
        {error && (
          <Typography variant="body2" color="error">
            Couldn&apos;t load lookups: {error}
          </Typography>
        )}
        {events && shown.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No lookups yet.
          </Typography>
        )}
        {shown.length > 0 && (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Device</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>What happened</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map((event, i) => (
                  <Row key={`${event.t}-${i}`} event={event} />
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
