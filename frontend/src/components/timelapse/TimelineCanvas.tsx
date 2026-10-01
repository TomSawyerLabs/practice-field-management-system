import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import type { TimelapseSegment, TimelapseTimeline } from '../../../../src/types';
import {
  axisTicks,
  clock,
  clusterSpans,
  concurrency,
  duration,
  scrubTile,
  segmentAt,
  teamLanes,
  type Cluster,
} from '../../utils/timelapseModel';
import type { Playhead } from './playhead';

export interface View {
  start: number;
  end: number;
}

interface Props {
  data: TimelapseTimeline;
  view: View;
  /** The range the view may move within (the practice day). */
  bounds: View;
  onViewChange: (view: View) => void;
  playhead: Playhead;
  /** A drag across the timeline: `start`, any number of `move`, `end`. */
  onScrub: (t: number, phase: 'start' | 'move' | 'end') => void;
}

// Layout, in CSS pixels.
const GUTTER = 76;
const AXIS_H = 24;
const VIDEO_H = 46;
const MATCH_H = 20;
const FIELD_H = 30;
const LANE_H = 16;
const SECTION_GAP = 6;
const MIN_SPAN_MS = 2 * 60_000;
const PREVIEW_W = 200;

// Data colours: the same green for "enabled" as the practice-day activity
// strip, so the two pages agree.
const C = {
  video: '#5c6bc0',
  matchVideo: '#7e57c2',
  match: '#ab47bc',
  robot: 'rgba(144, 164, 174, 0.45)',
  enabled: '#66bb6a',
  playhead: '#ff5252',
  still: '#ffd54f',
};

/** Something under the pointer that has a story to tell. */
interface Hit {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  lines: string[];
  /** Double-click zooms to this. */
  range?: View;
}

/**
 * The timeline under the film: the video that exists, the matches, a
 * field-wide row of how many robots were here and enabled, and a row per
 * team. Drawn on a canvas — a day can hold thousands of spans — in two
 * layers: the data (redrawn when the view or the data changes) and the
 * playhead and hover line on top (redrawn every frame).
 *
 * Crowds are decimated rather than drawn: spans closer together than a few
 * pixels at the current zoom merge into one bar, shaded by how much of it
 * was actually busy and labelled with how many it holds. Zoom in and they
 * come apart.
 */
export function TimelineCanvas({ data, view, bounds, onViewChange, playhead, onScrub }: Props) {
  const theme = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const hits = useRef<Hit[]>([]);
  const hoverX = useRef<number | null>(null);
  const sheets = useRef(new Map<string, HTMLImageElement>());
  const [sheetTick, setSheetTick] = useState(0);
  const drag = useRef<{ kind: 'scrub' | 'pan'; x0: number; view0: View; moved: boolean } | null>(null);

  const lanes = useMemo(() => teamLanes(data.robots, data.enables), [data]);
  const height =
    AXIS_H + VIDEO_H + SECTION_GAP + MATCH_H + SECTION_GAP + FIELD_H + SECTION_GAP + lanes.length * LANE_H + 4;
  const plotW = Math.max(1, width - GUTTER);

  const xOf = useCallback((t: number) => GUTTER + ((t - view.start) / (view.end - view.start)) * plotW, [view, plotW]);
  const tOf = useCallback((x: number) => view.start + ((x - GUTTER) / plotW) * (view.end - view.start), [view, plotW]);

  // Width follows the container.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const sheet = useCallback((file: string): HTMLImageElement | null => {
    let img = sheets.current.get(file);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.onload = () => setSheetTick(n => n + 1);
      img.src = `/api/timelapse/scrub/${file}`;
      sheets.current.set(file, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }, []);

  // ── the data layer ─────────────────────────────────────────────────

  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const out: Hit[] = [];
    const msPerPx = (view.end - view.start) / plotW;
    const text = theme.palette.text.primary;
    const muted = theme.palette.text.secondary;
    const grid = theme.palette.divider;
    const clampX = (x: number) => Math.max(GUTTER, Math.min(width, x));
    const visible = (a: number, b: number) => b >= view.start && a <= view.end;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Axis and grid.
    const ticks = axisTicks(view.start, view.end, plotW);
    ctx.fillStyle = muted;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (const t of ticks.minor) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H - 5);
      ctx.lineTo(x, AXIS_H);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    for (const t of ticks.major) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H - 9);
      ctx.lineTo(x, height);
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(clock(t, ticks.step < 60_000), x, 8);
    }

    // Row labels.
    const label = (y: number, h: number, s: string, color = muted) => {
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(s, GUTTER - 8, y + h / 2);
    };

    // ── video ──
    let y = AXIS_H;
    label(y, VIDEO_H, 'Video');
    const tileAspect = (s: TimelapseSegment) => (s.scrub ? s.scrub.tileWidth / s.scrub.tileHeight : 16 / 9);
    for (const seg of data.segments) {
      if (!visible(seg.start, seg.end)) continue;
      const x0 = clampX(xOf(seg.start));
      const x1 = clampX(xOf(seg.end));
      ctx.fillStyle = seg.source === 'match' ? C.matchVideo : C.video;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x0, y, Math.max(1, x1 - x0), VIDEO_H);
      ctx.globalAlpha = 1;
      // A filmstrip where there is room for pictures.
      const img = seg.scrub ? sheet(seg.scrub.file) : null;
      const slotW = VIDEO_H * tileAspect(seg);
      if (img && x1 - x0 >= slotW * 0.75) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, x1 - x0, VIDEO_H);
        ctx.clip();
        const first = Math.floor((x0 - GUTTER) / slotW) * slotW + GUTTER;
        for (let x = first; x < x1; x += slotW) {
          const tile = scrubTile(seg, tOf(x + slotW / 2));
          if (!tile) continue;
          const { tileWidth: tw, tileHeight: th } = tile.scrub;
          ctx.drawImage(img, tile.sx, tile.sy, tw, th, x, y, slotW, VIDEO_H);
        }
        ctx.restore();
      }
      out.push({
        x0,
        x1,
        y0: y,
        y1: y + VIDEO_H,
        range: { start: seg.start, end: seg.end },
        lines: [
          seg.source === 'match' ? 'Made from the match recording' : 'Timelapse while robots were here',
          `${clock(seg.start, true)}–${clock(seg.end, true)} (${duration(seg.end - seg.start)})`,
          `${(seg.mediaEnd - seg.mediaStart).toFixed(1)} s of film` +
            (seg.capturing ? ' — still recording' : seg.estimated ? ' — timing estimated' : ''),
        ],
      });
    }
    // Archival stills: a small marker along the top edge.
    ctx.fillStyle = C.still;
    for (const f of data.frames) {
      if (!visible(f.at, f.at)) continue;
      const x = xOf(f.at);
      ctx.beginPath();
      ctx.moveTo(x - 4, y);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 6);
      ctx.fill();
      out.push({ x0: x - 5, x1: x + 5, y0: y, y1: y + 8, lines: [`Archival frame, ${clock(f.at)}`] });
    }

    // ── matches ──
    y += VIDEO_H + SECTION_GAP;
    label(y, MATCH_H, 'Matches');
    const matchClusters = clusterSpans(data.matches, msPerPx, 2);
    for (const c of matchClusters) {
      if (!visible(c.start, c.end)) continue;
      const x0 = clampX(xOf(c.start));
      const x1 = clampX(xOf(c.end));
      const w = Math.max(2, x1 - x0);
      ctx.fillStyle = C.match;
      ctx.globalAlpha = c.count === 1 ? 0.9 : 0.35 + 0.55 * (c.busyMs / Math.max(1, c.end - c.start));
      ctx.fillRect(x0, y + 1, w, MATCH_H - 2);
      ctx.globalAlpha = 1;
      const m = c.items[0];
      const text1 = c.count === 1 ? `${m.challenge ? 'Run' : 'M'}${m.matchNumber}` : `${c.count} matches`;
      const text2 = c.count === 1 ? '' : `×${c.count}`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      if (ctx.measureText(text1).width + 6 <= w) ctx.fillText(text1, x0 + w / 2, y + MATCH_H / 2);
      else if (text2 && ctx.measureText(text2).width + 4 <= w) ctx.fillText(text2, x0 + w / 2, y + MATCH_H / 2);
      out.push({
        x0,
        x1: x0 + w,
        y0: y,
        y1: y + MATCH_H,
        range: { start: c.start, end: c.end },
        lines: c.count === 1 ? matchLines(m) : [`${c.count} matches`, `${clock(c.start)}–${clock(c.end)}`],
      });
    }

    // ── the field: robots here, robots enabled ──
    y += MATCH_H + SECTION_GAP;
    label(y, FIELD_H, 'On field');
    const present = concurrency(data.robots);
    const enabled = concurrency(data.enables);
    const peak = Math.max(1, ...present.map(p => p[1]), ...enabled.map(p => p[1]));
    const steps = (series: [number, number][], color: string) => {
      ctx.fillStyle = color;
      for (let i = 0; i < series.length - 1; i++) {
        const [t, n] = series[i];
        if (n === 0 || !visible(t, series[i + 1][0])) continue;
        const x0 = clampX(xOf(t));
        const x1 = clampX(xOf(series[i + 1][0]));
        const h = (n / peak) * (FIELD_H - 2);
        ctx.fillRect(x0, y + FIELD_H - h, Math.max(0.75, x1 - x0), h);
      }
    };
    steps(present, C.robot);
    steps(enabled, C.enabled);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(GUTTER, y + FIELD_H + 0.5);
    ctx.lineTo(width, y + FIELD_H + 0.5);
    ctx.stroke();
    out.push({ x0: GUTTER, x1: width, y0: y, y1: y + FIELD_H, lines: [] }); // filled in on hover

    // ── one row per team ──
    y += FIELD_H + SECTION_GAP;
    lanes.forEach((lane, i) => {
      const ly = y + i * LANE_H;
      if (i % 2 === 1) {
        ctx.fillStyle = theme.palette.action.hover;
        ctx.fillRect(0, ly, width, LANE_H);
      }
      label(ly, LANE_H, String(lane.team), text);
      for (const c of clusterSpans(lane.robots, msPerPx, 2)) {
        if (!visible(c.start, c.end)) continue;
        const x0 = clampX(xOf(c.start));
        const x1 = clampX(xOf(c.end));
        ctx.fillStyle = C.robot;
        ctx.fillRect(x0, ly + 3, Math.max(1, x1 - x0), LANE_H - 6);
        out.push({
          x0,
          x1,
          y0: ly,
          y1: ly + LANE_H,
          range: { start: c.start, end: c.end },
          lines: [
            `${lane.team} on the field${c.items[0] ? ` (${c.items[0].station.replace('slot', 'slot ')})` : ''}`,
            `${clock(c.start)}–${clock(c.end)} (${duration(c.end - c.start)})`,
          ],
        });
      }
      for (const c of clusterSpans(lane.enables, msPerPx, 3)) {
        if (!visible(c.start, c.end)) continue;
        drawEnables(ctx, c, ly, xOf, clampX);
        out.push({
          x0: clampX(xOf(c.start)) - 1,
          x1: Math.max(clampX(xOf(c.end)), clampX(xOf(c.start)) + 2) + 1,
          y0: ly,
          y1: ly + LANE_H,
          range: { start: c.start, end: c.end },
          lines: enableLines(lane.team, c),
        });
      }
    });

    // Where the activity log hands over from older, coarser records.
    const since = data.activityLoggedSince;
    if (since !== undefined && visible(since, since) && since > data.from) {
      const x = Math.round(xOf(since)) + 0.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = muted;
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H + VIDEO_H);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
      out.push({
        x0: x - 3,
        x1: x + 3,
        y0: AXIS_H + VIDEO_H,
        y1: height,
        lines: ['The activity log starts here.', 'Before it, robots and enables are approximate.'],
      });
    }

    // Later entries win the hover (the enables drawn over the robot bars).
    hits.current = out.reverse();
  }, [data, view, width, height, plotW, lanes, theme, xOf, tOf, sheet, sheetTick]);

  // ── the playhead layer ─────────────────────────────────────────────

  const drawTop = useCallback(() => {
    const canvas = topRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const hx = hoverX.current;
    if (hx !== null && hx >= GUTTER) {
      ctx.strokeStyle = theme.palette.text.secondary;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, AXIS_H);
      ctx.lineTo(Math.round(hx) + 0.5, height);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const t = playhead.get();
    if (t >= view.start && t <= view.end) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = C.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H - 2);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = C.playhead;
      ctx.beginPath();
      ctx.moveTo(x - 6, AXIS_H - 10);
      ctx.lineTo(x + 6, AXIS_H - 10);
      ctx.lineTo(x, AXIS_H - 2);
      ctx.fill();
    }
  }, [width, height, view, xOf, playhead, theme]);

  useEffect(() => {
    drawTop();
    return playhead.subscribe(() => drawTop());
  }, [drawTop, playhead]);

  // ── hover preview ──────────────────────────────────────────────────

  const drawPreview = useCallback(
    (x: number | null) => {
      const canvas = previewRef.current;
      if (!canvas) return;
      if (x === null || x < GUTTER) {
        canvas.style.visibility = 'hidden';
        return;
      }
      const t = tOf(x);
      const i = segmentAt(data.segments, t);
      const seg = i >= 0 ? data.segments[i] : undefined;
      const tile = seg ? scrubTile(seg, t) : null;
      const img = tile ? sheet(tile.scrub.file) : null;
      const w = PREVIEW_W;
      const h = tile ? Math.round((w * tile.scrub.tileHeight) / tile.scrub.tileWidth) : 0;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round((h + 20) * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h + 20}px`;
      // Fixed to the viewport, above the timeline: the timeline scrolls, and
      // its scroll box would otherwise clip the picture.
      const r = wrapRef.current!.getBoundingClientRect();
      canvas.style.left = `${r.left + Math.max(0, Math.min(width - w, x - w / 2))}px`;
      canvas.style.top = `${Math.max(0, r.top - (h + 24))}px`;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(0, 0, w, h + 20);
      if (tile && img) {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, tile.sx, tile.sy, tile.scrub.tileWidth, tile.scrub.tileHeight, 0, 0, w, h);
      }
      ctx.fillStyle = '#fff';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(clock(t, true) + (seg ? '' : '  · no video'), w / 2, h + 10);
      canvas.style.visibility = 'visible';
    },
    [data.segments, tOf, sheet, width],
  );

  // ── pointer ────────────────────────────────────────────────────────

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const clampT = (t: number) => Math.max(bounds.start, Math.min(bounds.end, t));

  const hover = (x: number, y: number) => {
    hoverX.current = x;
    drawTop();
    drawPreview(drag.current?.kind === 'pan' ? null : x);
    const hit = hits.current.find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    if (!hit) {
      setTooltip(null);
      return;
    }
    let lines = hit.lines;
    if (lines.length === 0) {
      // The field row: how many were here and enabled at that moment.
      const t = tOf(x);
      const here = data.robots.filter(r => r.start <= t && r.end > t);
      const on = data.enables.filter(r => r.start <= t && r.end > t);
      lines = [
        clock(t, true),
        `${here.length} robot${here.length === 1 ? '' : 's'} on the field` +
          (here.length ? `: ${[...new Set(here.map(r => r.team))].join(', ')}` : ''),
        `${on.length} enabled` + (on.length ? `: ${[...new Set(on.map(r => r.team))].join(', ')}` : ''),
      ];
    }
    setTooltip(prev =>
      prev && prev.lines.join('\n') === lines.join('\n') && Math.abs(prev.x - x) < 40 ? prev : { x, y: hit.y1, lines },
    );
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = pos(e);
    if (x < GUTTER) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const kind = y < AXIS_H || e.shiftKey ? 'pan' : 'scrub';
    drag.current = { kind, x0: x, view0: view, moved: false };
    if (kind === 'scrub') onScrub(clampT(tOf(x)), 'start');
    setTooltip(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    const d = drag.current;
    if (d) {
      d.moved = true;
      if (d.kind === 'pan') {
        const shift = ((d.x0 - x) / plotW) * (d.view0.end - d.view0.start);
        onViewChange(clampView({ start: d.view0.start + shift, end: d.view0.end + shift }, bounds));
      } else {
        onScrub(clampT(tOf(x)), 'move');
      }
    }
    hover(x, y);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'scrub') onScrub(clampT(tOf(pos(e).x)), 'end');
  };

  const onPointerLeave = () => {
    if (drag.current) return;
    hoverX.current = null;
    drawTop();
    drawPreview(null);
    setTooltip(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = pos(e);
    const hit = hits.current.find(h => h.range && x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    if (!hit?.range) return;
    const pad = Math.max(30_000, (hit.range.end - hit.range.start) * 0.15);
    onViewChange(clampView({ start: hit.range.start - pad, end: hit.range.end + pad }, bounds));
  };

  // Wheel: zoom around the pointer; sideways (or with Shift) pans. Bound by
  // hand because React's wheel listener is passive and cannot stop the page
  // scrolling.
  const wheelState = useRef({ view, bounds, tOf, plotW, onViewChange });
  wheelState.current = { view, bounds, tOf, plotW, onViewChange };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = wheelState.current;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x < GUTTER) return;
      e.preventDefault();
      const span = s.view.end - s.view.start;
      const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (sideways) {
        const d = (e.shiftKey ? e.deltaY : e.deltaX) * (span / s.plotW);
        s.onViewChange(clampView({ start: s.view.start + d, end: s.view.end + d }, s.bounds));
        return;
      }
      const anchor = s.tOf(x);
      const factor = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      const next = Math.max(MIN_SPAN_MS, Math.min(s.bounds.end - s.bounds.start, span * factor));
      const f = (anchor - s.view.start) / span;
      s.onViewChange(clampView({ start: anchor - f * next, end: anchor - f * next + next }, s.bounds));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <Box
      ref={wrapRef}
      sx={{ position: 'relative', width: '100%', height, userSelect: 'none', touchAction: 'none', cursor: 'crosshair' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={baseRef} style={{ position: 'absolute', inset: 0, width: '100%', height }} />
      <canvas ref={topRef} style={{ position: 'absolute', inset: 0, width: '100%', height }} />
      <canvas
        ref={previewRef}
        style={{
          position: 'fixed',
          visibility: 'hidden',
          pointerEvents: 'none',
          borderRadius: 4,
          boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          zIndex: 2,
        }}
      />
      {tooltip && (
        <Paper
          elevation={6}
          sx={{
            position: 'absolute',
            left: Math.max(0, Math.min(width - 260, tooltip.x + 12)),
            top: tooltip.y + 4,
            px: 1,
            py: 0.5,
            pointerEvents: 'none',
            zIndex: 3,
            maxWidth: 260,
          }}
        >
          {tooltip.lines.map((line, i) => (
            <Typography key={i} variant="caption" component="div" sx={{ fontWeight: i === 0 ? 600 : 400 }}>
              {line}
            </Typography>
          ))}
        </Paper>
      )}
    </Box>
  );
}

/** Keep a view inside the day, sliding it rather than squashing it. */
export function clampView(v: View, bounds: View): View {
  const span = Math.min(v.end - v.start, bounds.end - bounds.start);
  let start = v.start;
  if (start < bounds.start) start = bounds.start;
  if (start + span > bounds.end) start = bounds.end - span;
  return { start, end: start + span };
}

function drawEnables(
  ctx: CanvasRenderingContext2D,
  c: Cluster<{ start: number; end: number }>,
  ly: number,
  xOf: (t: number) => number,
  clampX: (x: number) => number,
) {
  const x0 = clampX(xOf(c.start));
  const w = Math.max(2, clampX(xOf(c.end)) - x0);
  ctx.fillStyle = C.enabled;
  if (c.count === 1) {
    ctx.fillRect(x0, ly + 2, w, LANE_H - 4);
    return;
  }
  // A crowd: shaded by how much of it was enabled, edged so it reads as one
  // bar, and counted when there is room.
  ctx.globalAlpha = 0.3 + 0.7 * Math.min(1, c.busyMs / Math.max(1, c.end - c.start));
  ctx.fillRect(x0, ly + 2, w, LANE_H - 4);
  ctx.globalAlpha = 1;
  ctx.fillRect(x0, ly + 2, w, 1.5);
  ctx.fillRect(x0, ly + LANE_H - 3.5, w, 1.5);
  const label = `×${c.count}`;
  ctx.font = '10px system-ui, sans-serif';
  if (ctx.measureText(label).width + 6 <= w) {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(label, x0 + w / 2, ly + LANE_H / 2 + 0.5);
  }
  ctx.font = '11px system-ui, sans-serif';
}

function matchLines(m: TimelapseTimeline['matches'][number]): string[] {
  const side = (a: 'red' | 'blue') =>
    m.teams
      .filter(t => t.alliance === a)
      .map(t => t.team)
      .join(', ');
  const lines = [
    `${m.challenge ? 'Challenge run' : 'Match'} ${m.matchNumber}`,
    `${clock(m.start)}–${clock(m.end)} (${duration(m.end - m.start)})`,
  ];
  const red = side('red');
  const blue = side('blue');
  if (red) lines.push(`Red: ${red}${m.red !== undefined ? ` — ${m.red}` : ''}`);
  if (blue) lines.push(`Blue: ${blue}${m.blue !== undefined ? ` — ${m.blue}` : ''}`);
  lines.push('Double-click to zoom in');
  return lines;
}

function enableLines(team: number, c: Cluster<{ start: number; end: number }>): string[] {
  if (c.count === 1) {
    return [`${team} enabled`, `${clock(c.start, true)}–${clock(c.end, true)} (${duration(c.end - c.start)})`];
  }
  return [
    `${team}: ${c.count} enables`,
    `${duration(c.busyMs)} enabled between ${clock(c.start)} and ${clock(c.end)}`,
    'Double-click to zoom in',
  ];
}
