import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { TeamAvatar } from './TeamAvatar';
import type { Alliance, QueueEntry, QueueState } from '../../../src/types';
import { useMatchState, useQueueState, sendQueueAdmin } from '../hooks/useBackend';

export const ALLIANCE_COLOR: Record<Alliance, string> = { red: '#d32f2f', blue: '#1565c0' };

export function formatQueueTime(t: number | undefined): string | null {
  if (!t) return null;
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The match to set up next: on deck if one is, else the first queued. */
export function nextEntry(queue: QueueState): QueueEntry | undefined {
  return queue.entries.find(e => e.status === 'onDeck') ?? queue.entries.find(e => e.status === 'queued');
}

export function entryStatusLabel(status: QueueEntry['status']): string {
  switch (status) {
    case 'onDeck':
      return 'on deck';
    case 'playing':
      return 'playing';
    case 'played':
      return 'played';
    case 'skipped':
      return 'skipped';
    default:
      return 'queued';
  }
}

/** One alliance's teams as chips. A no-show is outlined and says so. */
export function AllianceTeams({
  teams,
  alliance,
  noShows,
  onSwap,
}: {
  teams: number[];
  alliance: Alliance;
  noShows?: number[];
  /** Offered per no-show: swap in the next team from the line. */
  onSwap?: (team: number) => void;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
      <Chip
        label={alliance === 'red' ? 'Red' : 'Blue'}
        size="small"
        sx={{ backgroundColor: ALLIANCE_COLOR[alliance], color: '#fff', fontWeight: 700, minWidth: 48 }}
      />
      {teams.length === 0 && (
        <Typography variant="body2" sx={{ color: 'text.disabled' }}>
          nobody
        </Typography>
      )}
      {teams.map(team => {
        const noShow = noShows?.includes(team) ?? false;
        return (
          <Tooltip key={team} title={noShow ? 'No robot on the field and not joined — the clock has run out' : ''}>
            <Chip
              avatar={<TeamAvatar teamNumber={team} size={22} />}
              label={noShow ? `${team} · no-show` : String(team)}
              size="small"
              variant={noShow ? 'outlined' : 'filled'}
              color={noShow ? 'warning' : 'default'}
              onDelete={noShow && onSwap ? () => onSwap(team) : undefined}
              deleteIcon={
                noShow && onSwap ? <span style={{ fontSize: '0.7rem', padding: '0 4px' }}>swap</span> : undefined
              }
              sx={{ fontFamily: 'monospace' }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}

/**
 * The match up next, with the buttons that make the field match it. On the
 * match page and the queue page. Renders nothing when the queue is empty
 * and nobody is in line.
 */
export function QueueNextUp({ linkToQueue = false }: { linkToQueue?: boolean }) {
  const queue = useQueueState();
  const match = useMatchState();
  if (!queue) return null;
  const next = nextEntry(queue);
  const lineCount = queue.line.length;
  if (!next && lineCount === 0) return null;

  const phase = match?.phase ?? 'idle';
  const running = phase !== 'idle' && phase !== 'created' && phase !== 'postMatch';
  const hasJoined = Object.values(match?.stationStates ?? {}).some(s => s?.joined);
  const canCreate = !running && !(phase === 'created' && hasJoined);
  const noShows = queue.noShows ?? [];
  const swap = next ? (team: number) => sendQueueAdmin({ type: 'queueReplaceTeam', id: next.id, team }) : undefined;

  return (
    <Card sx={{ mb: 2, borderLeft: '6px solid', borderColor: 'info.main' }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
          <Typography variant="h6">Next up</Typography>
          {next && (
            <>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                Match {next.number}
              </Typography>
              {next.status === 'onDeck' && <Chip label="on deck" size="small" color="success" />}
              {formatQueueTime(next.scheduledAt) && (
                <Chip label={formatQueueTime(next.scheduledAt)} size="small" variant="outlined" />
              )}
              {next.source === 'line' && <Chip label="from the line" size="small" variant="outlined" />}
            </>
          )}
          <Box sx={{ flex: 1 }} />
          {linkToQueue && (
            <Link href="/queue" underline="hover" variant="body2">
              Manage the queue
            </Link>
          )}
        </Box>

        {next ? (
          <>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 1.5 }}>
              <AllianceTeams teams={next.red} alliance="red" noShows={noShows} onSwap={swap} />
              <AllianceTeams teams={next.blue} alliance="blue" noShows={noShows} onSwap={swap} />
            </Box>
            {next.notes && (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
                {next.notes}
              </Typography>
            )}
            {noShows.length > 0 && (
              <Typography variant="body2" sx={{ color: 'warning.main', mb: 1 }}>
                {noShows.length === 1 ? 'A team has' : `${noShows.length} teams have`} not shown. Tap <em>swap</em> on a
                team to bring in the next one from the line{lineCount === 0 ? ' — the line is empty right now' : ''}.
              </Typography>
            )}
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <Tooltip
                title={
                  running
                    ? 'Available when the match ends'
                    : 'Stage Wi-Fi for every robot in the match, apply it, create the match, and join each robot to its alliance'
                }
              >
                <span>
                  <Button
                    variant="contained"
                    color="primary"
                    disabled={!canCreate}
                    onClick={() => sendQueueAdmin({ type: 'queueSetupNext', id: next.id, mode: 'all' })}
                  >
                    Set up next match
                  </Button>
                </span>
              </Tooltip>
              <Button
                size="small"
                variant="outlined"
                disabled={running}
                onClick={() => sendQueueAdmin({ type: 'queueSetupNext', id: next.id, mode: 'wifi' })}
              >
                Stage Wi-Fi only
              </Button>
              <Button
                size="small"
                variant="outlined"
                disabled={!canCreate}
                onClick={() => sendQueueAdmin({ type: 'queueSetupNext', id: next.id, mode: 'match' })}
              >
                Create match only
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button size="small" color="warning" onClick={() => sendQueueAdmin({ type: 'queueSkip', id: next.id })}>
                Skip
              </Button>
            </Box>
          </>
        ) : (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Nothing queued. {lineCount === 1 ? '1 team is' : `${lineCount} teams are`} in line.
            </Typography>
            <Button variant="contained" size="small" onClick={() => sendQueueAdmin({ type: 'queueForm' })}>
              Form the next match from the line
            </Button>
          </Box>
        )}
        {next && lineCount > 0 && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
            {lineCount === 1 ? '1 team is' : `${lineCount} teams are`} waiting in line after this.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
