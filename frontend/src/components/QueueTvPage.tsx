/**
 * The queue view of /scores: the match queue full screen, for a TV in the
 * pits or by the field (?view=queue, the control chip, or the admin page's
 * display list). Now playing, on deck, the next few matches, and the fill
 * line in order, so teams can see when they're up without asking.
 *
 * The queue stays on the field network: the server only sends it to an
 * on-site /scores page, and tells any other page so, which this shows
 * instead of waiting forever.
 */
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import type { Alliance, LineEntry, QueueEntry, QueueState } from '../../../src/types';
import { useQueueOffSite, useQueueState } from '../hooks/useBackend';
import { useCastReceiverRegistration } from '../hooks/useCastReceiverRegistration';
import { switchScoreboardView } from '../utils/scoreboardView';
import { ControlChip } from './ControlChip';
import { TeamAvatar } from './TeamAvatar';
import { formatQueueTime } from './QueueNextUp';

const ALLIANCE_COLOR: Record<Alliance, string> = { red: '#ef5350', blue: '#42a5f5' };
const ACCENT = '#29b6f6';
/** Upcoming matches shown after the on-deck one. More don't fit a TV. */
const UPCOMING = 5;
/** Line entries shown before "+N more". */
const LINE_SHOWN = 14;

export function QueueTvPage() {
  const queue = useQueueState();
  const offSite = useQueueOffSite();

  // The other display settings aren't used here, but the admin page's display
  // list shows them — report what the scoreboard would come back with.
  useCastReceiverRegistration({
    swapped: localStorage.getItem('scoreboard-swap') === '1',
    muted: localStorage.getItem('scoreboard-muted') === '1',
    checks: localStorage.getItem('scoreboard-checks') === '1',
    view: 'queue',
  });

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        backgroundColor: '#000',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        px: { xs: 2, md: 4 },
        py: 3,
        gap: 3,
      }}
    >
      <Typography
        sx={{
          color: ACCENT,
          fontWeight: 800,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          textAlign: 'center',
          fontSize: 'clamp(1.4rem, 3.5vw, 3rem)',
        }}
      >
        Match Queue
      </Typography>

      {offSite ? (
        <Notice
          title="The queue is only shown on the field network"
          detail="Open this page from a device at the field to see who's up next."
        />
      ) : !queue ? (
        <Notice title="Waiting for the queue…" />
      ) : (
        <QueueBoard queue={queue} />
      )}

      {/* Controls — hidden on a Chromecast receiver, faint until hovered */}
      {!window.__isCastReceiver && (
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            right: 16,
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            opacity: 0.2,
            transition: 'opacity 0.5s ease',
            '&:hover': { opacity: 1 },
          }}
        >
          <ControlChip icon="📊" label="scoreboard" onClick={() => switchScoreboardView('scoreboard')} />
          <ControlChip icon="🏆" label="leaderboard" onClick={() => switchScoreboardView('leaderboard')} />
          {window.__castReady && (
            <google-cast-launcher style={{ width: 24, height: 24, cursor: 'pointer', opacity: 0.5 }} />
          )}
        </Box>
      )}
    </Box>
  );
}

function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <Box sx={{ textAlign: 'center', mt: 8 }}>
      <Typography sx={{ color: 'rgba(255,255,255,0.75)', fontSize: 'clamp(1.4rem, 3vw, 2.4rem)', fontWeight: 700 }}>
        {title}
      </Typography>
      {detail && (
        <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 'clamp(1rem, 1.8vw, 1.5rem)', mt: 1 }}>
          {detail}
        </Typography>
      )}
    </Box>
  );
}

function QueueBoard({ queue }: { queue: QueueState }) {
  const playing = queue.entries.find(e => e.status === 'playing');
  const onDeck = queue.entries.find(e => e.status === 'onDeck');
  const queued = queue.entries.filter(e => e.status === 'queued').slice(0, UPCOMING);
  const noShows = queue.noShows ?? [];
  const nothingQueued = !playing && !onDeck && queued.length === 0;

  return (
    <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <Box sx={{ flex: '3 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {playing && <MatchRow entry={playing} label="Now playing" highlight="rgba(255,255,255,0.5)" />}
        {onDeck && <MatchRow entry={onDeck} label="On deck" highlight="#66bb6a" noShows={noShows} />}
        {queued.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <SectionLabel>Up next</SectionLabel>
            {queued.map(entry => (
              <MatchRow key={entry.id} entry={entry} compact />
            ))}
          </Box>
        )}
        {nothingQueued && (
          <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 'clamp(1.2rem, 2.4vw, 2rem)', mt: 2 }}>
            No matches queued
            {queue.settings.lineOpen ? ' — join the line from your team page' : ''}
          </Typography>
        )}
      </Box>

      <LineColumn line={queue.line} open={queue.settings.lineOpen} />
    </Box>
  );
}

function SectionLabel({ children, color = 'rgba(255,255,255,0.6)' }: { children: ReactNode; color?: string }) {
  return (
    <Typography
      sx={{
        color,
        fontWeight: 800,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontSize: 'clamp(0.9rem, 1.5vw, 1.3rem)',
      }}
    >
      {children}
    </Typography>
  );
}

/** One match: its number and time, and each alliance's teams. The live and
 *  on-deck ones are big and boxed; the rest are a line each. */
function MatchRow({
  entry,
  label,
  highlight,
  noShows = [],
  compact = false,
}: {
  entry: QueueEntry;
  label?: string;
  highlight?: string;
  noShows?: number[];
  compact?: boolean;
}) {
  const time = formatQueueTime(entry.scheduledAt);
  const teamSize = compact ? 'clamp(1.3rem, 2.4vw, 2.1rem)' : 'clamp(1.8rem, 3.6vw, 3.2rem)';
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: { xs: 2, md: 3 },
        flexWrap: 'wrap',
        ...(compact
          ? { py: 1, borderBottom: '1px solid rgba(255,255,255,0.12)' }
          : {
              px: 3,
              py: 2,
              borderRadius: 2,
              border: `2px solid ${highlight}`,
              backgroundColor: 'rgba(255,255,255,0.04)',
            }),
      }}
    >
      <Box sx={{ minWidth: compact ? 140 : 180 }}>
        {label && <SectionLabel color={highlight}>{label}</SectionLabel>}
        <Typography
          sx={{ fontWeight: 800, fontSize: compact ? 'clamp(1.1rem, 2vw, 1.7rem)' : 'clamp(1.4rem, 2.6vw, 2.2rem)' }}
        >
          Match {entry.number}
        </Typography>
        {time && (
          <Typography sx={{ color: 'rgba(255,255,255,0.6)', fontSize: 'clamp(0.9rem, 1.4vw, 1.2rem)' }}>
            {time}
          </Typography>
        )}
      </Box>
      <AllianceRow teams={entry.red} alliance="red" size={teamSize} noShows={noShows} />
      <Typography sx={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700, fontSize: teamSize }}>vs</Typography>
      <AllianceRow teams={entry.blue} alliance="blue" size={teamSize} noShows={noShows} />
    </Box>
  );
}

function AllianceRow({
  teams,
  alliance,
  size,
  noShows,
}: {
  teams: number[];
  alliance: Alliance;
  size: string;
  noShows: number[];
}) {
  if (teams.length === 0) {
    return <Typography sx={{ color: 'rgba(255,255,255,0.35)', fontSize: size, fontWeight: 700 }}>—</Typography>;
  }
  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
      {teams.map(team => {
        const noShow = noShows.includes(team);
        return (
          <Box key={team} sx={{ display: 'flex', alignItems: 'center', gap: 1, opacity: noShow ? 0.5 : 1 }}>
            <TeamAvatar teamNumber={team} size={36} />
            <Typography
              sx={{
                color: ALLIANCE_COLOR[alliance],
                fontWeight: 800,
                fontFamily: 'monospace',
                fontSize: size,
                textDecoration: noShow ? 'line-through' : undefined,
              }}
            >
              {team}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/** The fill line, in order. A team that asked for an alliance shows its color. */
function LineColumn({ line, open }: { line: LineEntry[]; open: boolean }) {
  if (!open && line.length === 0) return null;
  const shown = line.slice(0, LINE_SHOWN);
  const more = line.length - shown.length;
  return (
    <Box
      sx={{
        flex: '1 1 260px',
        minWidth: 0,
        maxWidth: { md: 420 },
        borderRadius: 2,
        border: '1px solid rgba(255,255,255,0.2)',
        px: 3,
        py: 2,
      }}
    >
      <SectionLabel color={ACCENT}>In line</SectionLabel>
      <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 'clamp(0.85rem, 1.3vw, 1.1rem)', mb: 1.5 }}>
        {open ? 'Join from your team page' : 'The line is closed'}
      </Typography>
      {line.length === 0 ? (
        <Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 'clamp(1.1rem, 2vw, 1.6rem)' }}>
          Nobody yet
        </Typography>
      ) : (
        <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {shown.map((entry, i) => (
            <Box component="li" key={entry.team} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography
                sx={{ color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace', minWidth: '2.2em', fontSize: '1.3rem' }}
              >
                {i + 1}.
              </Typography>
              <TeamAvatar teamNumber={entry.team} size={30} />
              <Typography
                sx={{
                  fontFamily: 'monospace',
                  fontWeight: 800,
                  fontSize: 'clamp(1.2rem, 2.2vw, 1.9rem)',
                  color: entry.alliance ? ALLIANCE_COLOR[entry.alliance] : '#fff',
                }}
              >
                {entry.team}
              </Typography>
            </Box>
          ))}
          {more > 0 && (
            <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: '1.2rem' }}>+{more} more</Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
