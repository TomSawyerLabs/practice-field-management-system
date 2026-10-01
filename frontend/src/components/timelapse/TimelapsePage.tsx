import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import type { TimelapseDaySummary, TimelapseTimeline } from '../../../../src/types';
import { fetchTimelapseDays, fetchTimelapseTimeline, useTimelapseState } from '../../hooks/useBackend';
import {
  clock,
  dayLabel,
  duration,
  eventTimes,
  practiceDayOf,
  practiceDayRange,
  segmentAt,
  segmentSpeed,
} from '../../utils/timelapseModel';
import { createPlayhead } from './playhead';
import { TimelapsePlayer, type PlayerHandle } from './TimelapsePlayer';
import { clampView, TimelineCanvas, type View } from './TimelineCanvas';

/** Film speeds offered, as multiples of the film's own 30 fps. At the
 *  default capture that is 15× to 960× real time. */
const RATES = [0.25, 0.5, 1, 2, 4, 8, 16];
/** Viewing today: fetch again this often, so the live chunk grows. */
const REFRESH_MS = 20_000;
const MIN_FIT_MS = 20 * 60_000;

function readUrl(): { day?: string; t?: number; stream?: string } {
  const p = new URLSearchParams(window.location.search);
  const day = p.get('day') ?? undefined;
  const t = Number(p.get('t'));
  return {
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined,
    t: Number.isFinite(t) && t > 0 ? t : undefined,
    stream: p.get('stream') ?? undefined,
  };
}

/** Everything worth seeing on a day, padded — the view a day opens at. */
function activityExtent(data: TimelapseTimeline, fallback: View): View {
  const starts = [
    ...data.segments.map(s => s.start),
    ...data.matches.map(m => m.start),
    ...data.robots.map(r => r.start),
  ];
  const ends = [...data.segments.map(s => s.end), ...data.matches.map(m => m.end), ...data.robots.map(r => r.end)];
  if (starts.length === 0) return fallback;
  let start = Math.min(...starts);
  let end = Math.max(...ends);
  if (end - start < MIN_FIT_MS) {
    const mid = (start + end) / 2;
    start = mid - MIN_FIT_MS / 2;
    end = mid + MIN_FIT_MS / 2;
  }
  const pad = (end - start) * 0.03;
  return clampView({ start: start - pad, end: end + pad }, fallback);
}

/**
 * /timelapse — one logical film of the field for a practice day, with the
 * robots, enables and matches laid out underneath it.
 */
export function TimelapsePage() {
  const initial = useMemo(readUrl, []);
  const status = useTimelapseState();
  const [days, setDays] = useState<TimelapseDaySummary[] | null>(null);
  const [day, setDay] = useState<string | null>(initial.day ?? null);
  const [stream, setStream] = useState<string | undefined>(initial.stream);
  const [data, setData] = useState<TimelapseTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [view, setView] = useState<View | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);

  const playhead = useMemo(() => createPlayhead(initial.t ?? Date.now()), [initial.t]);
  const player = useRef<PlayerHandle>(null);
  const scrubbing = useRef<{ wasPlaying: boolean } | null>(null);
  const pendingT = useRef<number | undefined>(initial.t);
  const bounds = useMemo(() => (day ? practiceDayRange(day) : null), [day]);

  // ── data ───────────────────────────────────────────────────────────

  useEffect(() => {
    void fetchTimelapseDays(stream).then(r => {
      const list = r?.days ?? [];
      setDays(list);
      setDay(d => d ?? list[list.length - 1]?.day ?? practiceDayOf(Date.now()));
    });
  }, [stream]);

  const load = useCallback(
    async (quiet: boolean) => {
      if (!day) return;
      const range = practiceDayRange(day);
      if (!quiet) setLoading(true);
      const next = await fetchTimelapseTimeline(range.start, range.end, stream);
      if (!quiet) setLoading(false);
      if (!next) {
        if (!quiet) setError('Could not load the timeline from the server.');
        return;
      }
      setError(null);
      setData(next);
      setGeneration(g => g + 1);
    },
    [day, stream],
  );

  // A new day: load it, open the view on its activity, put the playhead on
  // the first footage (or wherever the link said).
  useEffect(() => {
    setData(null);
    setView(null);
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!data || !bounds || view) return;
    const linked =
      pendingT.current !== undefined && pendingT.current >= bounds.start && pendingT.current < bounds.end
        ? pendingT.current
        : undefined;
    const t = linked ?? data.segments[0]?.start ?? data.frames[0]?.at ?? bounds.start;
    pendingT.current = undefined;
    // Open on the day's activity — widened to take in a linked moment that
    // falls outside it, so the playhead is never off-screen.
    const fit = activityExtent(data, bounds);
    const pad = (fit.end - fit.start) * 0.03;
    setView(clampView({ start: Math.min(fit.start, t - pad), end: Math.max(fit.end, t + pad) }, bounds));
    playhead.set(t);
  }, [data, bounds, view, playhead]);

  // After each fetch, show the playhead's moment in the new data (the
  // player keeps playing through a refresh on its own).
  useEffect(() => {
    if (!data || scrubbing.current || player.current?.isPlaying()) return;
    player.current?.seek(playhead.get(), 'exact');
  }, [data, generation, playhead]);

  // Viewing a day that is still going: keep it fresh.
  useEffect(() => {
    if (!bounds || Date.now() > bounds.end) return;
    const id = setInterval(() => void load(true), REFRESH_MS);
    return () => clearInterval(id);
  }, [bounds, load]);

  // ── the playhead: URL, and keeping it in view ──────────────────────

  // The address bar follows the playhead, so a copied link opens on this
  // moment. At most once a second, but always with the final position.
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = () => {
      last = performance.now();
      timer = undefined;
      const p = new URLSearchParams();
      if (day) p.set('day', day);
      p.set('t', String(Math.round(playhead.get())));
      if (stream) p.set('stream', stream);
      window.history.replaceState(null, '', `${window.location.pathname}?${p}`);
    };
    const unsubscribe = playhead.subscribe(() => {
      if (timer) return;
      timer = setTimeout(write, Math.max(0, 1000 - (performance.now() - last)));
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [playhead, day, stream]);

  useEffect(() => {
    return playhead.subscribe(t => {
      if (!player.current?.isPlaying() || !bounds) return;
      setView(v => {
        if (!v) return v;
        const span = v.end - v.start;
        if (t >= v.start && t <= v.end - span * 0.02) return v;
        return clampView({ start: t - span * 0.1, end: t + span * 0.9 }, bounds);
      });
    });
  }, [playhead, bounds]);

  // ── transport ──────────────────────────────────────────────────────

  const segments = data?.segments ?? [];
  const events = useMemo(() => (data ? eventTimes(data.matches, data.enables) : []), [data]);

  const seek = useCallback(
    (t: number) => {
      playhead.set(t);
      player.current?.seek(t, 'exact');
    },
    [playhead],
  );

  const onScrub = useCallback(
    (t: number, phase: 'start' | 'move' | 'end') => {
      if (phase === 'start') {
        scrubbing.current = { wasPlaying: !!player.current?.isPlaying() };
        player.current?.pause();
      }
      playhead.set(t);
      player.current?.seek(t, phase === 'end' ? 'exact' : 'scrub');
      if (phase === 'end') {
        const resume = scrubbing.current?.wasPlaying;
        scrubbing.current = null;
        if (resume) player.current?.play();
      }
    },
    [playhead],
  );

  const togglePlay = useCallback(() => {
    if (player.current?.isPlaying()) player.current.pause();
    else player.current?.play();
  }, []);

  const jumpEvent = useCallback(
    (dir: 1 | -1) => {
      const t = playhead.get();
      const next = dir > 0 ? events.find(e => e > t + 500) : [...events].reverse().find(e => e < t - 500);
      if (next !== undefined) seek(next);
    },
    [events, playhead, seek],
  );

  const changeRate = (r: number) => {
    setRate(r);
    player.current?.setRate(r);
  };

  const stepDay = (dir: 1 | -1) => {
    if (!days || !day) return;
    const i = days.findIndex(d => d.day === day);
    const next = days[i + dir];
    if (next) {
      player.current?.pause();
      setDay(next.day);
    }
  };

  // Keyboard: Space play/pause, ←/→ a frame (Shift: a minute), ,/. the
  // previous/next match or enable, F fits the day's activity.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) {
          player.current?.pause();
          seek(playhead.get() + dir * 60_000);
        } else {
          player.current?.stepFrames(dir);
        }
      } else if (e.key === ',' || e.key === '.') {
        jumpEvent(e.key === '.' ? 1 : -1);
      } else if ((e.key === 'f' || e.key === 'F') && data && bounds) {
        setView(activityExtent(data, bounds));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, jumpEvent, playhead, data, bounds]);

  // ── render ─────────────────────────────────────────────────────────

  const dayIndex = days && day ? days.findIndex(d => d.day === day) : -1;
  const summary = dayIndex >= 0 ? days![dayIndex] : undefined;
  const speed = segments.length > 0 ? segmentSpeed(segments[0]) : 60;

  if (days && days.length === 0 && !data?.segments.length) {
    return (
      <Box sx={{ p: 3, maxWidth: 720 }}>
        <Typography variant="h5" gutterBottom>
          Field timelapse
        </Typography>
        <Alert severity="info">
          There is no timelapse footage yet.{' '}
          {status && !status.enabled ? (
            <>
              The timelapse is off — switch it on in <Link href="/admin">Admin → Field Timelapse</Link>.
            </>
          ) : (
            'It is captured whenever robots are on the field, so it will appear here after the next practice.'
          )}
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header: which day, which stream, what is happening now. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" sx={{ mr: 1 }}>
          Field timelapse
        </Typography>
        <IconButton size="small" disabled={dayIndex <= 0} onClick={() => stepDay(-1)} aria-label="Previous day">
          <ChevronLeftIcon />
        </IconButton>
        <Select
          size="small"
          value={day ?? ''}
          onChange={e => {
            player.current?.pause();
            setDay(e.target.value);
          }}
          sx={{ minWidth: 260 }}
        >
          {day && !days?.some(d => d.day === day) && <MenuItem value={day}>{dayLabel(day)}</MenuItem>}
          {[...(days ?? [])].reverse().map(d => (
            <MenuItem key={d.day} value={d.day}>
              {dayLabel(d.day)} ·{' '}
              {d.videoSeconds > 0 ? `${duration(d.videoSeconds * 1000)} of field time` : 'stills only'}
            </MenuItem>
          ))}
        </Select>
        <IconButton
          size="small"
          disabled={!days || dayIndex < 0 || dayIndex >= days.length - 1}
          onClick={() => stepDay(1)}
          aria-label="Next day"
        >
          <ChevronRightIcon />
        </IconButton>
        {data && data.streams.length > 1 && (
          <Select size="small" value={data.stream ?? ''} onChange={e => setStream(e.target.value)}>
            {data.streams.map(s => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </Select>
        )}
        {summary && (
          <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
            {summary.segments} piece{summary.segments === 1 ? '' : 's'} · {data?.matches.length ?? 0} match
            {data?.matches.length === 1 ? '' : 'es'} · {new Set(data?.robots.map(r => r.team)).size} team
            {new Set(data?.robots.map(r => r.team)).size === 1 ? '' : 's'}
          </Typography>
        )}
        {status?.capturing && <Chip size="small" color="error" label="● Capturing now" />}
        <Box sx={{ flex: 1 }} />
        {status && !status.enabled && <Chip size="small" label="Timelapse off" />}
      </Box>
      {loading && <LinearProgress />}
      {error && (
        <Alert severity="error" sx={{ mx: 2 }}>
          {error}
        </Alert>
      )}

      {/* The film. */}
      <Box sx={{ flex: 1, minHeight: 200, position: 'relative' }}>
        <TimelapsePlayer
          ref={player}
          segments={segments}
          frames={data?.frames ?? []}
          generation={generation}
          onTime={t => playhead.set(t)}
          onPlayingChange={setPlaying}
        />
        {data && segments.length === 0 && data.frames.length === 0 && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'grey.400',
            }}
          >
            No footage on {day ? dayLabel(day) : 'this day'}.
          </Box>
        )}
      </Box>

      {/* Transport. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.5, flexWrap: 'wrap' }}>
        <Tooltip title="Previous match or enable ( , )">
          <IconButton onClick={() => jumpEvent(-1)} disabled={events.length === 0}>
            <SkipPreviousIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={playing ? 'Pause (Space)' : 'Play (Space)'}>
          <IconButton onClick={togglePlay} disabled={segments.length === 0} color="primary" size="large">
            {playing ? <PauseIcon fontSize="large" /> : <PlayArrowIcon fontSize="large" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Next match or enable ( . )">
          <IconButton onClick={() => jumpEvent(1)} disabled={events.length === 0}>
            <SkipNextIcon />
          </IconButton>
        </Tooltip>
        <Select size="small" value={rate} onChange={e => changeRate(Number(e.target.value))}>
          {RATES.map(r => (
            <MenuItem key={r} value={r}>
              {Math.round(r * speed)}× real time
            </MenuItem>
          ))}
        </Select>
        <Readout playhead={playhead} data={data} />
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', md: 'block' } }}>
          Drag to scrub · wheel to zoom · drag the time axis (or Shift-drag) to pan · ←/→ frame · Shift ←/→ minute
        </Typography>
        <Tooltip title="Fit the day's activity (F)">
          <span>
            <Button
              size="small"
              startIcon={<ZoomOutMapIcon />}
              disabled={!data || !bounds}
              onClick={() => data && bounds && setView(activityExtent(data, bounds))}
            >
              Fit
            </Button>
          </span>
        </Tooltip>
      </Box>

      {/* The timeline. */}
      <Box sx={{ px: 1, pt: 4, pb: 1, maxHeight: '45vh', overflowY: 'auto', flexShrink: 0 }}>
        {data && view && bounds && (
          <TimelineCanvas
            data={data}
            view={view}
            bounds={bounds}
            onViewChange={setView}
            playhead={playhead}
            onScrub={onScrub}
          />
        )}
      </Box>
    </Box>
  );
}

/** The moment on screen, and what was going on then. Written straight into
 *  the DOM: it changes every frame during playback. */
function Readout({ playhead, data }: { playhead: ReturnType<typeof createPlayhead>; data: TimelapseTimeline | null }) {
  const timeRef = useRef<HTMLSpanElement>(null);
  const contextRef = useRef<HTMLSpanElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    let lastContext = 0;
    const update = (t: number) => {
      if (timeRef.current) timeRef.current.textContent = clock(t, true);
      const now = performance.now();
      if (now - lastContext < 150 || !contextRef.current) return;
      lastContext = now;
      const d = dataRef.current;
      if (!d) return;
      const match = d.matches.find(m => m.start <= t && m.end > t);
      const here = new Set(d.robots.filter(r => r.start <= t && r.end > t).map(r => r.team));
      const on = new Set(d.enables.filter(r => r.start <= t && r.end > t).map(r => r.team));
      const inVideo = segmentAt(d.segments, t) >= 0;
      const parts: string[] = [];
      if (match) parts.push(`${match.challenge ? 'Challenge run' : 'Match'} ${match.matchNumber}`);
      if (here.size > 0) parts.push(`${here.size} robot${here.size === 1 ? '' : 's'} here`);
      if (on.size > 0) parts.push(`${[...on].join(', ')} enabled`);
      if (!inVideo) parts.push('no video');
      contextRef.current.textContent = parts.join(' · ');
    };
    update(playhead.get());
    return playhead.subscribe(update);
  }, [playhead]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, ml: 1 }}>
      <Typography
        component="span"
        ref={timeRef}
        sx={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
      />
      <Typography component="span" ref={contextRef} variant="body2" color="text.secondary" />
    </Box>
  );
}
