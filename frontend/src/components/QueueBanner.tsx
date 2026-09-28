import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { Alliance } from '../../../src/types';
import { useQueueState, sendQueueJoinLine, sendQueueLeaveLine } from '../hooks/useBackend';
import { formatQueueTime } from './QueueNextUp';

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/**
 * The team page's view of the queue: where this team stands, or a "Play
 * next" button when the line is open. Renders nothing when the queue is not
 * in use (line closed and the team in no upcoming match).
 */
export function QueueBanner({ teamNumber }: { teamNumber: number }) {
  const queue = useQueueState();
  const [alliance, setAlliance] = useState<Alliance | null>(null);
  if (!queue) return null;

  const upcoming = queue.entries.filter(e => e.status === 'queued' || e.status === 'onDeck');
  const index = upcoming.findIndex(e => e.red.includes(teamNumber) || e.blue.includes(teamNumber));
  const entry = index >= 0 ? upcoming[index] : null;

  if (entry) {
    const side = entry.red.includes(teamNumber) ? 'Red' : 'Blue';
    const when =
      entry.status === 'onDeck'
        ? 'on deck now — get your robot on the field'
        : index === 0
          ? 'next up'
          : `${ordinal(index + 1)} in the queue`;
    const time = formatQueueTime(entry.scheduledAt);
    const noShow = queue.noShows?.includes(teamNumber) ?? false;
    return (
      <Alert severity={noShow ? 'warning' : entry.status === 'onDeck' ? 'success' : 'info'} sx={{ mb: 2 }}>
        You&apos;re in <strong>Match {entry.number}</strong> on the {side} alliance — {when}
        {time ? ` (about ${time})` : ''}.
        {noShow && ' Field staff have you down as not here yet: enable your Wi-Fi and join, or you may be swapped out.'}
      </Alert>
    );
  }

  const position = queue.line.findIndex(l => l.team === teamNumber) + 1;
  if (position > 0) {
    const mine = queue.line[position - 1];
    return (
      <Alert
        severity="info"
        sx={{ mb: 2 }}
        action={
          <Button color="inherit" size="small" onClick={() => sendQueueLeaveLine(teamNumber)}>
            Leave the line
          </Button>
        }
      >
        You&apos;re <strong>{ordinal(position)}</strong> in line to play
        {mine.alliance ? ` (asked for ${mine.alliance})` : ''}. Field staff form the next match from the front of the
        line.
      </Alert>
    );
  }

  if (!queue.settings.lineOpen) return null;
  return (
    <Alert
      severity="info"
      icon={false}
      sx={{ mb: 2, '& .MuiAlert-action': { alignItems: 'center', pt: 0 } }}
      action={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={alliance}
            onChange={(_, v: Alliance | null) => setAlliance(v)}
            aria-label="alliance preference"
          >
            <ToggleButton value="red" sx={{ px: 1, '&.Mui-selected': { color: '#d32f2f' } }}>
              Red
            </ToggleButton>
            <ToggleButton value="blue" sx={{ px: 1, '&.Mui-selected': { color: '#1565c0' } }}>
              Blue
            </ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" size="small" onClick={() => sendQueueJoinLine(teamNumber, alliance ?? undefined)}>
            Play next
          </Button>
        </Box>
      }
    >
      Want a match? Join the line and field staff will put you in the next one.
      {queue.line.length > 0 && ` ${queue.line.length} ${queue.line.length === 1 ? 'team is' : 'teams are'} waiting.`}
    </Alert>
  );
}
