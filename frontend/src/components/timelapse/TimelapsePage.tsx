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
/** Looking at now: fetch again this often, so the live chunk grows. */
const REFRESH_MS = 20_000;
const MIN_FIT_MS = 20 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Widest the timeline zooms out. */
const MAX_VIEW_MS = 3 * DAY_MS;
/** Wait this long after the view stops moving before fetching for it. */
const LOAD_DEBOUNCE_MS = 120;

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

/** Everything worth seeing within `range`, padded — the view a day opens at. */
function activityExtent(data: TimelapseTimeline, range: View): View {
  const inRange = (s: { start: number; end: number }) => s.end > range.start && s.start < range.end;
  const spans = [...data.segments, ...data.matches, ...data.robots].filter(inRange);
  if (spans.length === 0) return range;
  let start = Math.max(range.start, Math.min(...spans.map(s => s.start)));
  let end = Math.min(range.end, Math.max(...spans.map(s => s.end)));
  if (end - start < MIN_FIT_MS) {
    const mid = (start + end) / 2;
    start = mid - MIN_FIT_MS / 2;
    end = mid + MIN_FIT_MS / 2;
  }
  const pad = (end - start) * 0.03;
  return clampView({ start: start - pad, end: end + pad }, range);
}

/** The practice days a view touches, as one range. */
function daysOfView(view: View): View {
  return {
    start: practiceDayRange(practiceDayOf(view.start)).start,
    end: practiceDayRange(practiceDayOf(view.end - 1)).end,
  };
}

/**
 * /timelapse — the field as one logical film, with the robots, enables and
 * matches laid out underneath it.
 *
 * The timeline is continuous: pan or zoom straight across a day boundary
 * and the next day's data is fetched around the view. The day picker and the
 * previous/next buttons are jumps along that one timeline, not page loads.
 */
export function TimelapsePage() {
  const initial = useMemo(readUrl, []);
  const status = useTimelapseState();
  const [days, setDays] = useState<TimelapseDaySummary[] | null>(null);
  const [stream, setStream] = useState<string | undefined>(initial.stream);
  const [data, setData] = useState<TimelapseTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [view, setView] = useState<View | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  /** A day to open on once its data is in: fit its activity, set the playhead. */
  const [opening, setOpening] = useState<{ day: string; t?: number; play?: boolean } | null>(null);

  const playhead = useMemo(() => createPlayhead(initial.t ?? Date.now()), [initial.t]);
  const player = useRef<PlayerHandle>(null);
  const scrubbing = useRef<{ wasPlaying: boolean } | null>(null);
  const request = useRef(0);
  const started = useRef(false);

  // Everything there is footage for, plus today: how far the view can go.
  const bounds = useMemo<View>(() => {
    const today = practiceDayRange(practiceDayOf(Date.now()));
    const first = days?.[0] ? practiceDayRange(days[0].day).start : today.start;
    return { start: Math.min(first, today.start), end: today.end };
  }, [days]);

  /** The day in the middle of the view: what the picker shows. */
  const day = view ? practiceDayOf((view.start + view.end) / 2) : (opening?.day ?? null);

  // ── data ───────────────────────────────────────────────────────────

  const goToDay = useCallback((target: string, t?: number, play?: boolean) => {
    player.current?.pause();
    setOpening({ day: target, t, play });
    // Look at the whole day now; this is also what gets its data fetched.
    setView(practiceDayRange(target));
  }, []);

  // The days with footage, and the first place to look: the linked moment,
  // else the linked day, else the latest day with anything.
  useEffect(() => {
    void fetchTimelapseDays(stream).then(r => {
      const list = r?.days ?? [];
      setDays(list);
      if (started.current) return;
      started.current = true;
      const target =
        initial.t !== undefined
          ? practiceDayOf(initial.t)
          : (initial.day ?? list[list.length - 1]?.day ?? practiceDayOf(Date.now()));
      setOpening({ day: target, t: initial.t });
      setView(practiceDayRange(target));
    });
  }, [stream, initial]);

  const fetchRange = useCallback(
    async (range: View, quiet: boolean) => {
      const id = ++request.current;
      if (!quiet) setLoading(true);
      const next = await fetchTimelapseTimeline(range.start, range.end, stream);
      if (id !== request.current) return; // the view has moved on
      if (!quiet) setLoading(false);
      if (!next) {
        if (!quiet) setError('Could not load the timeline from the server.');
        return;
      }
      setError(null);
      setData(next);
      setGeneration(g => g + 1);
    },
    [stream],
  );

  // Keep the days under the view loaded, with a day to spare either side so
  // a pan across a boundary already has something to show.
  const wanted = useMemo(() => (view ? daysOfView(view) : null), [view]);
  const covered = !!data && !!wanted && data.from <= wanted.start && data.to >= wanted.end;
  useEffect(() => {
    if (!wanted || covered) return;
    const range = { start: wanted.start - DAY_MS, end: wanted.end + DAY_MS };
    const timer = setTimeout(() => void fetchRange(range, false), LOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [wanted, covered, fetchRange]);

  // A different stream: what is loaded is for the old one.
  useEffect(() => setData(null), [stream]);

  // Opening a day, once its data is here: fit the view to what happened and
  // put the playhead on its first footage (or wherever the link said).
  useEffect(() => {
    if (!opening || !data) return;
    const range = practiceDayRange(opening.day);
    if (data.from > range.start || data.to < range.end) return;
    const inDay = (at: number) => at >= range.start && at < range.end;
    const t =
      (opening.t !== undefined && inDay(opening.t) ? opening.t : undefined) ??
      data.segments.find(s => s.end > range.start && s.start < range.end)?.start ??
      data.frames.find(f => inDay(f.at))?.at ??
      range.start;
    // Widened to take in a linked moment outside the day's activity, so the
    // playhead is never off-screen.
    const fit = activityExtent(data, range);
    const pad = (fit.end - fit.start) * 0.03;
    setView(clampView({ start: Math.min(fit.start, t - pad), end: Math.max(fit.end, t + pad) }, range));
    playhead.set(t);
    player.current?.seek(t, 'exact');
    if (opening.play) player.current?.play();
    setOpening(null);
  }, [opening, data, playhead]);

  // After each fetch, show the playhead's moment in the new data (the
  // player keeps playing through a refresh on its own).
  useEffect(() => {
    if (!data || opening || scrubbing.current || player.current?.isPlaying()) return;
    player.current?.seek(playhead.get(), 'exact');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, generation, playhead]);

  // What is loaded includes now: keep it fresh.
  const live = !!data && data.from <= Date.now() && data.to >= Date.now();
  useEffect(() => {
    if (!live || !data) return;
    const range = { start: data.from, end: data.to };
    const id = setInterval(() => void fetchRange(range, true), REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, data?.from, data?.to, fetchRange]);

  // ── the playhead: URL, and keeping it in view ──────────────────────

  // The address bar follows the playhead, so a copied link opens on this
  // moment. At most once a second, but always with the final position.
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = () => {
      last = performance.now();
      timer = undefined;
      const t = playhead.get();
      const p = new URLSearchParams({ day: practiceDayOf(t), t: String(Math.round(t)) });
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
  }, [playhead, stream]);

  useEffect(() => {
    return playhead.subscribe(t => {
      if (!player.current?.isPlaying()) return;
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

  /** The nearest day with footage before / after the one on screen. */
  const neighbour = useCallback(
    (dir: 1 | -1): TimelapseDaySummary | undefined => {
      if (!days || !day) return undefined;
      return dir > 0 ? days.find(d => d.day > day) : [...days].reverse().find(d => d.day < day);
    },
    [days, day],
  );
  const stepDay = useCallback(
    (dir: 1 | -1) => {
      const next = neighbour(dir);
      if (next) goToDay(next.day);
    },
    [neighbour, goToDay],
  );

  /** The film that is loaded ran out: carry on into the next day that has
   *  any, if there is one. */
  const onEnd = useCallback(() => {
    const t = playhead.get();
    const next = days?.find(d => d.videoSeconds > 0 && practiceDayRange(d.day).start > t);
    if (next) goToDay(next.day, undefined, true);
  }, [days, playhead, goToDay]);

  const fitDay = useCallback(() => {
    if (!data) return;
    const range = practiceDayRange(practiceDayOf(playhead.get()));
    setView(activityExtent(data, range));
  }, [data, playhead]);

  // Keyboard: Space play/pause, ←/→ a frame (Shift: a minute), ,/. the
  // previous/next match or enable, [ / ] the previous/next day, F fits the
  // day's activity.
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
      } else if (e.key === '[' || e.key === ']' || e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        stepDay(e.key === ']' || e.key === 'PageDown' ? 1 : -1);
      } else if (e.key === 'f' || e.key === 'F') {
        fitDay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, jumpEvent, stepDay, fitDay, playhead]);

  // ── render ─────────────────────────────────────────────────────────

  const summary = days?.find(d => d.day === day);
  const dayRange = day ? practiceDayRange(day) : null;
  const inDay = <T extends { start: number; end: number }>(xs: T[]) =>
    dayRange ? xs.filter(x => x.end > dayRange.start && x.start < dayRange.end) : [];
  const dayMatches = data ? inDay(data.matches).length : 0;
  const dayTeams = data ? new Set(inDay(data.robots).map(r => r.team)).size : 0;
  const speed = segments.length > 0 ? segmentSpeed(segments[0]) : 60;
  const previous = neighbour(-1);
  const next = neighbour(1);

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
        <Tooltip title="Previous day with footage ( [ )">
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={<ChevronLeftIcon />}
              disabled={!previous}
              onClick={() => stepDay(-1)}
              sx={{ minWidth: 132 }}
            >
              {previous ? dayLabel(previous.day) : 'Earlier'}
            </Button>
          </span>
        </Tooltip>
        <Select size="small" value={day ?? ''} onChange={e => goToDay(e.target.value)} sx={{ minWidth: 260 }}>
          {day && !days?.some(d => d.day === day) && (
            <MenuItem value={day}>{dayLabel(day)} · nothing recorded</MenuItem>
          )}
          {[...(days ?? [])].reverse().map(d => (
            <MenuItem key={d.day} value={d.day}>
              {dayLabel(d.day)} ·{' '}
              {d.videoSeconds > 0 ? `${duration(d.videoSeconds * 1000)} of field time` : 'stills only'}
            </MenuItem>
          ))}
        </Select>
        <Tooltip title="Next day with footage ( ] )">
          <span>
            <Button
              size="small"
              variant="outlined"
              endIcon={<ChevronRightIcon />}
              disabled={!next}
              onClick={() => stepDay(1)}
              sx={{ minWidth: 132 }}
            >
              {next ? dayLabel(next.day) : 'Later'}
            </Button>
          </span>
        </Tooltip>
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
            {summary.segments} piece{summary.segments === 1 ? '' : 's'} · {dayMatches} match
            {dayMatches === 1 ? '' : 'es'} · {dayTeams} team{dayTeams === 1 ? '' : 's'}
          </Typography>
        )}
        {status?.capturing && <Chip size="small" color="error" label="● Capturing now" />}
        <Box sx={{ flex: 1 }} />
        {status && !status.enabled && <Chip size="small" label="Timelapse off" />}
      </Box>
      <Box sx={{ height: 4 }}>{loading && <LinearProgress />}</Box>
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
          onEnd={onEnd}
        />
      </Box>

      {/* Transport. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.5, flexWrap: 'wrap' }}>
        <Tooltip title="Previous match or enable ( , )">
          <span>
            <IconButton onClick={() => jumpEvent(-1)} disabled={events.length === 0}>
              <SkipPreviousIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={playing ? 'Pause (Space)' : 'Play (Space)'}>
          <span>
            <IconButton onClick={togglePlay} disabled={segments.length === 0} color="primary" size="large">
              {playing ? <PauseIcon fontSize="large" /> : <PlayArrowIcon fontSize="large" />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Next match or enable ( . )">
          <span>
            <IconButton onClick={() => jumpEvent(1)} disabled={events.length === 0}>
              <SkipNextIcon />
            </IconButton>
          </span>
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
        <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', lg: 'block' } }}>
          Drag to scrub · wheel to zoom · drag the time axis (or Shift-drag) to pan, across days · ←/→ frame · [ ] day
        </Typography>
        <Tooltip title="Fit the day's activity (F)">
          <span>
            <Button size="small" startIcon={<ZoomOutMapIcon />} disabled={!data} onClick={fitDay}>
              Fit
            </Button>
          </span>
        </Tooltip>
      </Box>

      {/* The timeline. */}
      <Box sx={{ px: 1, pt: 1, pb: 1, maxHeight: '45vh', overflowY: 'auto', flexShrink: 0 }}>
        {data && view && (
          <TimelineCanvas
            data={data}
            view={view}
            bounds={bounds}
            maxSpanMs={MAX_VIEW_MS}
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
  const dateRef = useRef<HTMLSpanElement>(null);
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
      if (dateRef.current) {
        dateRef.current.textContent = new Date(t).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
      }
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
      <Typography component="span" ref={dateRef} variant="body2" color="text.secondary" />
      <Typography
        component="span"
        ref={timeRef}
        sx={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
      />
      <Typography component="span" ref={contextRef} variant="body2" color="text.secondary" />
    </Box>
  );
}
