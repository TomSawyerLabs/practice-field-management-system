import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { StationName } from '../../../src/types';
import { getServerTime } from '../hooks/useBackend';
import { DEFAULT_LANES, LANES } from '../timeline/lanes';
import { liveTimeline, startLiveTimeline } from '../timeline/live';
import { drawTimeline, GUTTER, layoutLanes, paletteFor } from '../timeline/render';
import { RETAIN_MS } from '../../../src/timeline/store';

const SPANS = [
  { ms: 30_000, label: '30 s' },
  { ms: 120_000, label: '2 min' },
  { ms: RETAIN_MS, label: '10 min' },
];
const MIN_SPAN_MS = 10_000;
const PAD_RIGHT = 8;
/** Live, the chart scrolls; this is as often as it needs redrawing. */
const FRAME_MS = 33;

const LANES_KEY = 'pfms.timeline.lanes';
const SPAN_KEY = 'pfms.timeline.span';

function stored<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full disk: the choice just doesn't outlive the page.
  }
}

/** The colour actually behind an element: the nearest painted background,
 *  with MUI's dark-mode elevation overlay (a flat white gradient) blended in. */
function surfaceBehind(el: HTMLElement, fallback: string): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const bg = /rgba?\(([^)]+)\)/.exec(style.backgroundColor);
    if (!bg) continue;
    const [r, g, b, a = 1] = bg[1].split(',').map(Number);
    if (a === 0) continue;
    const overlay = /rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/.exec(style.backgroundImage);
    const k = overlay ? Number(overlay[1]) : 0;
    const mix = (c: number) => Math.round(c + (255 - c) * k);
    return `#${[mix(r), mix(g), mix(b)].map(c => c.toString(16).padStart(2, '0')).join('')}`;
  }
  return fallback;
}

interface Props {
  station: StationName;
  /** What the team calls this robot ("Elsa"), shown with its readings. */
  name: string;
  /** The team's other robot on the field, to lay over this one. */
  other?: { station: StationName; name: string } | null;
}

/**
 * The live timeline of one robot: its Wi-Fi link, comms and state as bands,
 * its battery and radio readings as lines, and what happened when as flags,
 * all on one time axis. Drag to look back, pinch or Ctrl+scroll to zoom,
 * point (or tap) for the readings at a moment.
 */
export function TimelineChart({ station, name, other = null }: Props) {
  const theme = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [surface, setSurface] = useState(theme.palette.background.paper);

  const [span, setSpanState] = useState(() =>
    stored(SPAN_KEY, SPANS[1].ms, (v): v is number => typeof v === 'number' && v >= MIN_SPAN_MS && v <= RETAIN_MS),
  );
  const [laneIds, setLaneIds] = useState<readonly string[]>(() =>
    stored(LANES_KEY, DEFAULT_LANES, (v): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')),
  );
  const [showOther, setShowOther] = useState(true);
  /** The right edge of the view when looking back; null follows the present. */
  const [pinnedEnd, setPinnedEnd] = useState<number | null>(null);
  const [lanesMenu, setLanesMenu] = useState<HTMLElement | null>(null);

  // The draw loop reads these every frame without re-subscribing.
  const view = useRef({ span, pinnedEnd });
  view.current = { span, pinnedEnd };
  const hover = useRef<{ x: number; y: number } | null>(null);
  const dirty = useRef(true);

  const setSpan = useCallback((ms: number) => {
    const clamped = Math.max(MIN_SPAN_MS, Math.min(RETAIN_MS, ms));
    setSpanState(clamped);
    store(SPAN_KEY, clamped);
  }, []);

  useEffect(startLiveTimeline, []);

  const lanes = useMemo(() => LANES.filter(l => laneIds.includes(l.id)), [laneIds]);
  const compare = other && showOther ? other : null;
  const layout = useMemo(() => layoutLanes(lanes, !!compare), [lanes, compare]);
  const palette = useMemo(() => paletteFor(theme.palette.mode, surface), [theme.palette.mode, surface]);

  // Width follows the container; the surface colour follows the theme.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (wrapRef.current) setSurface(surfaceBehind(wrapRef.current, theme.palette.background.paper));
  }, [theme.palette.mode, theme.palette.background.paper]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(width * dpr);
    const h = Math.round(layout.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const now = getServerTime();
    const { span, pinnedEnd } = view.current;
    const t1 = pinnedEnd ?? now;
    const t0 = t1 - span;
    const plotW = Math.max(1, width - GUTTER - PAD_RIGHT);
    const at = hover.current;
    drawTimeline(ctx, {
      width,
      layout,
      t0,
      t1,
      now,
      live: pinnedEnd === null,
      primary: liveTimeline.stations[station],
      primaryName: name,
      compare: compare ? { tracks: liveTimeline.stations[compare.station], name: compare.name } : null,
      field: liveTimeline.field,
      hoverT: at === null ? null : t0 + ((at.x - GUTTER) / plotW) * span,
      hoverY: at?.y ?? null,
      palette,
      fontFamily: theme.typography.fontFamily ?? 'system-ui, sans-serif',
    });
  }, [width, layout, station, name, compare, palette, theme.typography.fontFamily]);

  // Redraw: every frame's worth of time while live and on screen, otherwise
  // only when something changed (and a slow tick, for spans still running).
  useEffect(() => {
    dirty.current = true;
    let raf = 0;
    let last = 0;
    let onScreen = true;
    const io = new IntersectionObserver(entries => {
      onScreen = entries.some(e => e.isIntersecting);
    });
    if (canvasRef.current) io.observe(canvasRef.current);
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (!onScreen) return;
      const every = view.current.pinnedEnd === null ? FRAME_MS : 500;
      if (!dirty.current && ts - last < every) return;
      last = ts;
      dirty.current = false;
      draw();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [draw]);
  useEffect(() => {
    dirty.current = true;
  }, [span, pinnedEnd]);

  // ── pointer, wheel and keys ────────────────────────────────────────

  /** Move the view so its right edge is at `end`; at the present it goes live. */
  const lookAt = useCallback((end: number, spanMs = view.current.span) => {
    const now = getServerTime();
    const earliest = now - RETAIN_MS + spanMs;
    setPinnedEnd(end >= now - 250 ? null : Math.max(earliest, end));
  }, []);

  /** Zoom by `factor` (>1 = further out), holding the time under `x` still. */
  const zoomAt = useCallback(
    (factor: number, x: number | null) => {
      const now = getServerTime();
      const { span, pinnedEnd } = view.current;
      const next = Math.max(MIN_SPAN_MS, Math.min(RETAIN_MS, span * factor));
      if (next === span) return;
      const plotW = Math.max(1, width - GUTTER - PAD_RIGHT);
      const end = pinnedEnd ?? now;
      // Fraction of the way across the plot the anchor is (1 = right edge).
      const f = x === null ? 1 : Math.max(0, Math.min(1, (x - GUTTER) / plotW));
      const anchor = end - span * (1 - f);
      setSpan(next);
      // Live stays live unless the zoom was aimed at somewhere in the past.
      if (pinnedEnd !== null) lookAt(anchor + next * (1 - f), next);
    },
    [width, setSpan, lookAt],
  );

  const pointers = useRef(new Map<number, number>());
  const gesture = useRef<{
    startX: number;
    startEnd: number;
    moved: boolean;
    /** Two fingers: how far apart they started, and the span then. */
    pinch?: { distance: number; span: number };
  } | null>(null);

  const localX = (e: React.PointerEvent) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const localY = (e: React.PointerEvent) => e.clientY - e.currentTarget.getBoundingClientRect().top;

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    pointers.current.set(e.pointerId, x);
    e.currentTarget.setPointerCapture(e.pointerId);
    const end = view.current.pinnedEnd ?? getServerTime();
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        startX: x,
        startEnd: end,
        moved: true,
        pinch: { distance: Math.max(1, Math.abs(a - b)), span: view.current.span },
      };
    } else {
      gesture.current = { startX: x, startEnd: end, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = localX(e);
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) {
      // Nothing held down: the crosshair follows the pointer.
      if (e.pointerType === 'mouse') {
        hover.current = x >= GUTTER ? { x, y: localY(e) } : null;
        dirty.current = true;
      }
      return;
    }
    pointers.current.set(e.pointerId, x);
    const plotW = Math.max(1, width - GUTTER - PAD_RIGHT);
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.max(1, Math.abs(a - b));
      setSpan(g.pinch.span * (g.pinch.distance / distance));
      return;
    }
    const dx = x - g.startX;
    if (!g.moved && Math.abs(dx) < 5) return;
    g.moved = true;
    hover.current = null;
    lookAt(g.startEnd - (dx / plotW) * view.current.span);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (!g || g.moved) return;
    // A tap: put the crosshair there, or lift it if it already is.
    if (e.pointerType !== 'mouse') {
      const x = localX(e);
      const y = localY(e);
      const was = hover.current;
      const same = was !== null && Math.abs(was.x - x) < 16 && Math.abs(was.y - y) < 16;
      hover.current = same || x < GUTTER ? null : { x, y };
      dirty.current = true;
    }
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
  };

  const onPointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType !== 'mouse' || gesture.current) return;
    hover.current = null;
    dirty.current = true;
  };

  // Ctrl+scroll (and a trackpad pinch, which arrives as one) zooms; a
  // sideways scroll pans. A plain scroll is left to the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const x = e.clientX - canvas.getBoundingClientRect().left;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(Math.exp(e.deltaY * 0.004), x);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const plotW = Math.max(1, width - GUTTER - PAD_RIGHT);
        const end = view.current.pinnedEnd ?? getServerTime();
        lookAt(end + (e.deltaX / plotW) * view.current.span);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [width, zoomAt, lookAt]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const { span, pinnedEnd } = view.current;
    const end = pinnedEnd ?? getServerTime();
    if (e.key === 'ArrowLeft') lookAt(end - span / 5);
    else if (e.key === 'ArrowRight') lookAt(end + span / 5);
    else if (e.key === '+' || e.key === '=') zoomAt(1 / 1.5, null);
    else if (e.key === '-') zoomAt(1.5, null);
    else if (e.key === 'End' || e.key === 'Escape') setPinnedEnd(null);
    else return;
    e.preventDefault();
  };

  const toggleLane = (id: string) => {
    const next = LANES.map(l => l.id).filter(l => (l === id ? !laneIds.includes(l) : laneIds.includes(l)));
    setLaneIds(next);
    store(LANES_KEY, next);
  };

  const live = pinnedEnd === null;

  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={SPANS.find(s => s.ms === span)?.ms ?? null}
          onChange={(_, ms: number | null) => ms && setSpan(ms)}
          aria-label="How much time the chart shows"
        >
          {SPANS.map(s => (
            <ToggleButton key={s.ms} value={s.ms} sx={{ py: 0.25, px: 1, textTransform: 'none' }}>
              {s.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {live ? (
          <Chip
            size="small"
            variant="outlined"
            label="Live"
            icon={<Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main' }} />}
            sx={{ '& .MuiChip-icon': { ml: 1 } }}
          />
        ) : (
          <Button size="small" variant="contained" onClick={() => setPinnedEnd(null)} sx={{ textTransform: 'none' }}>
            Back to live
          </Button>
        )}
        <Button size="small" onClick={e => setLanesMenu(e.currentTarget)} sx={{ textTransform: 'none' }}>
          Lanes
        </Button>
        <Menu anchorEl={lanesMenu} open={!!lanesMenu} onClose={() => setLanesMenu(null)}>
          {LANES.map(l => (
            <MenuItem key={l.id} dense onClick={() => toggleLane(l.id)}>
              <Checkbox edge="start" size="small" checked={laneIds.includes(l.id)} tabIndex={-1} disableRipple />
              <ListItemText primary={l.title} secondary={l.kind === 'numeric' ? l.unit : undefined} />
            </MenuItem>
          ))}
        </Menu>
        {other && (
          <Chip
            size="small"
            variant={showOther ? 'filled' : 'outlined'}
            onClick={() => setShowOther(v => !v)}
            label={showOther ? `Also showing ${other.name}` : `Also show ${other.name}`}
            icon={
              <Box
                component="span"
                sx={{ width: 12, height: 3, borderRadius: 1, bgcolor: palette.compare, opacity: showOther ? 1 : 0.4 }}
              />
            }
            sx={{ '& .MuiChip-icon': { ml: 1 } }}
          />
        )}
      </Box>
      <Box ref={wrapRef} sx={{ width: '100%' }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Live timeline of this robot's Wi-Fi link, comms, state, battery and radio readings. The table view has the current values as text."
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={onPointerLeave}
          onDoubleClick={() => setPinnedEnd(null)}
          onKeyDown={onKeyDown}
          style={{
            display: 'block',
            width: '100%',
            height: layout.height,
            // Sideways drags belong to the chart; up and down still scrolls the page.
            touchAction: 'pan-y',
            cursor: 'crosshair',
            outlineOffset: 2,
          }}
        />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        Drag sideways to look back, pinch or Ctrl+scroll to zoom, point or tap for the readings at a moment.
      </Typography>
    </Box>
  );
}
