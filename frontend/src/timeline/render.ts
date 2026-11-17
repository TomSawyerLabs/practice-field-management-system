/**
 * Draws the station timeline on a 2D canvas: stacked lanes on one time axis.
 * Numeric lanes draw lines (with a band down to the lowest reading where the
 * source reports one), state lanes draw labelled bands, and events are flags
 * along the top with a rule through every lane for the ones that matter
 * everywhere (an enable, a field Wi-Fi update).
 *
 * No React, no DOM beyond the context it is handed. All coordinates are CSS
 * pixels; the caller scales the context for the device pixel ratio.
 */
import {
  bucketize,
  endOf,
  type EventSeries,
  type NumericSeries,
  type TimelineEvent,
} from '../../../src/timeline/series';
import type { Lane, NumericLane, StateLane, Tone } from './lanes';
import type { NumericKey, StationTracks } from '../../../src/timeline/store';

// ── Palette ─────────────────────────────────────────────────────────

export interface ChartPalette {
  /** What the chart sits on, for the gaps and rings that separate marks. */
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  /** A lane's first and second measure, and the team's other robot. */
  a: string;
  b: string;
  compare: string;
  good: string;
  warning: string;
  serious: string;
  critical: string;
}

/** Line colours are slots 1–3 of the dataviz palette, which hold apart for
 *  colour-blind readers in every pairing; states use the status colours. */
export function paletteFor(mode: 'light' | 'dark', surface: string): ChartPalette {
  const status = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
  return mode === 'dark'
    ? {
        surface,
        ink: '#f0efec',
        ink2: '#c3c2b7',
        muted: '#898781',
        grid: 'rgba(255,255,255,0.08)',
        axis: 'rgba(255,255,255,0.18)',
        a: '#3987e5',
        b: '#d95926',
        compare: '#199e70',
        ...status,
      }
    : {
        surface,
        ink: '#0b0b0b',
        ink2: '#52514e',
        muted: '#898781',
        grid: 'rgba(11,11,11,0.08)',
        axis: 'rgba(11,11,11,0.22)',
        a: '#2a78d6',
        b: '#eb6834',
        compare: '#1baf7a',
        ...status,
      };
}

// ── Layout ──────────────────────────────────────────────────────────

/** Left gutter: lane names and scale labels. */
export const GUTTER = 58;
const PAD_RIGHT = 8;
/** Top strip: event flags and the crosshair's time. */
const FLAGS_H = 22;
const AXIS_H = 22;
const LANE_GAP = 8;
const STATE_H = 16;
const STATE_BAND = 14;
/** The other robot's state, a thin strip under the band. */
const COMPARE_STRIP = 5;
const NUM_HEADER = 16;
const NUM_PLOT = 56;

export interface LaneBox {
  lane: Lane;
  /** Top of the lane, and its full height. */
  y: number;
  h: number;
  /** Where its marks are drawn. */
  plotY: number;
  plotH: number;
}

export interface Layout {
  lanes: LaneBox[];
  height: number;
  /** Top and bottom of the area the lanes cover (rules span this). */
  top: number;
  bottom: number;
}

export function layoutLanes(lanes: readonly Lane[], hasCompare: boolean): Layout {
  const boxes: LaneBox[] = [];
  let y = FLAGS_H;
  for (const lane of lanes) {
    if (lane.kind === 'state') {
      const h = STATE_H + (hasCompare ? COMPARE_STRIP + 2 : 0);
      boxes.push({ lane, y, h, plotY: y + 1, plotH: STATE_BAND });
      y += h + LANE_GAP;
    } else {
      const h = NUM_HEADER + NUM_PLOT;
      boxes.push({ lane, y, h, plotY: y + NUM_HEADER, plotH: NUM_PLOT });
      y += h + LANE_GAP;
    }
  }
  const bottom = Math.max(FLAGS_H, y - LANE_GAP);
  return { lanes: boxes, height: bottom + AXIS_H, top: FLAGS_H, bottom };
}

// ── Scene ───────────────────────────────────────────────────────────

export interface Scene {
  width: number;
  layout: Layout;
  /** The time range on screen and the present moment, server epoch ms. */
  t0: number;
  t1: number;
  now: number;
  /** Following the present: the axis counts back from "now". */
  live: boolean;
  primary: StationTracks;
  /** What the team calls the robot ("Elsa"), for the readings at the pointer. */
  primaryName: string;
  compare: { tracks: StationTracks; name: string } | null;
  field: EventSeries;
  /** The crosshair, if the pointer is over the chart, and how far down the
   *  chart the pointer is (which lane, and which line in it, it is on). */
  hoverT: number | null;
  hoverY: number | null;
  palette: ChartPalette;
  fontFamily: string;
}

const TONE_RANK: Record<string, number> = { critical: 4, serious: 3, warning: 2, good: 1, neutral: 0 };

export function drawTimeline(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { width, layout, t0, t1, now, palette: p } = scene;
  const plotX = GUTTER;
  const plotW = Math.max(1, width - GUTTER - PAD_RIGHT);
  const xOf = (t: number) => plotX + ((t - t0) / (t1 - t0)) * plotW;
  const font = (size: number, weight = 400) => `${weight} ${size}px ${scene.fontFamily}`;

  ctx.clearRect(0, 0, width, layout.height);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const events = [...scene.field.inRange(t0, t1, now), ...scene.primary.events.inRange(t0, t1, now)];
  const readT = scene.hoverT ?? now;
  const scales = new Map<string, Scale>();
  for (const box of layout.lanes) if (box.lane.kind === 'numeric') scales.set(box.lane.id, scaleFor(box.lane, scene));

  // Field-wide spans (a Wi-Fi update) wash every lane, behind the data.
  for (const e of events) {
    if (!e.rule || (e.end === undefined && !e.open)) continue;
    const x0 = Math.max(plotX, xOf(e.t));
    const x1 = Math.min(plotX + plotW, xOf(endOf(e, now)));
    if (x1 <= x0) continue;
    ctx.fillStyle = withAlpha(toneColor(p, e.tone), 0.1);
    ctx.fillRect(x0, layout.top, x1 - x0, layout.bottom - layout.top);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, 0, plotW, layout.height);
  ctx.clip();
  for (const box of layout.lanes) {
    if (box.lane.kind === 'numeric') {
      drawNumericLane(ctx, scene, box, box.lane, scales.get(box.lane.id)!, xOf, plotX, plotW);
    } else drawStateLane(ctx, scene, box, box.lane, xOf, plotX, plotW, events, font);
  }
  ctx.restore();

  for (const box of layout.lanes) {
    if (box.lane.kind === 'numeric') {
      drawNumericChrome(ctx, scene, box, box.lane, scales.get(box.lane.id)!, plotX, plotW, readT, font);
    } else drawStateChrome(ctx, scene, box, box.lane, font);
  }

  drawRulesAndFlags(ctx, scene, events, xOf, plotX, plotW, font);
  drawAxis(ctx, scene, xOf, plotX, plotW, font);
  if (scene.hoverT !== null) drawCrosshair(ctx, scene, events, scales, xOf, plotX, plotW, font);
}

// ── Numeric lanes ───────────────────────────────────────────────────

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

function scaleFor(lane: NumericLane, scene: Scene): Scale {
  let min = Infinity;
  let max = -Infinity;
  const note = (series: NumericSeries) => {
    const r = series.range(scene.t0, scene.t1);
    if (!r) return;
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
  };
  for (const s of lane.series) {
    note(scene.primary.numeric[s.key]);
    if (s.compare && scene.compare) note(scene.compare.tracks.numeric[s.key]);
  }
  if (lane.softMin !== undefined) min = Math.min(min, lane.softMin);
  if (lane.softMax !== undefined) max = Math.max(max, lane.softMax);
  if (lane.reference) max = Math.max(max, lane.reference.value);
  if (lane.min !== undefined) min = lane.min;
  if (lane.max !== undefined) max = lane.max;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = lane.min ?? 0;
    max = lane.max ?? 1;
  }
  if (max <= min) max = min + 1;

  // Snap outward to round numbers, so the scale holds still while the data
  // wanders inside it.
  const step = niceStep((max - min) / 3);
  if (lane.min === undefined) min = Math.floor(min / step) * step;
  if (lane.max === undefined) max = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(v);
  return { min, max, ticks };
}

/** A round number near `rough`: 1, 2 or 5 times a power of ten. */
export function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const f = rough / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

function drawNumericLane(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  box: LaneBox,
  lane: NumericLane,
  scale: Scale,
  xOf: (t: number) => number,
  plotX: number,
  plotW: number,
): void {
  const p = scene.palette;
  // A little air above and below, so a line at the limit isn't on the edge.
  const yOf = (v: number) => box.plotY + 3 + (1 - (v - scale.min) / (scale.max - scale.min)) * (box.plotH - 6);

  ctx.lineWidth = 1;
  ctx.strokeStyle = p.grid;
  ctx.beginPath();
  for (const tick of scale.ticks) {
    const y = Math.round(yOf(tick)) + 0.5;
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
  }
  ctx.stroke();

  if (lane.shade) {
    const series = lane.shade.series(scene.primary);
    for (const seg of series.segments(scene.t0, scene.t1, scene.now)) {
      if (!seg.value) continue;
      const x0 = Math.max(plotX, xOf(seg.start));
      const x1 = Math.max(x0 + 2, Math.min(plotX + plotW, xOf(seg.end)));
      ctx.fillStyle = withAlpha(p.warning, 0.22);
      ctx.fillRect(x0, box.plotY, x1 - x0, box.plotH);
      ctx.fillStyle = p.warning;
      ctx.fillRect(x0, box.plotY, x1 - x0, 2);
    }
  }

  if (lane.reference) {
    const y = Math.round(yOf(lane.reference.value)) + 0.5;
    ctx.strokeStyle = withAlpha(p.critical, 0.7);
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, box.plotY, plotW, box.plotH);
  ctx.clip();
  const bottom = box.plotY + box.plotH;
  // The other robot first, so the selected one draws over it.
  if (scene.compare) {
    for (const s of lane.series) {
      if (s.compare)
        drawSeries(ctx, scene, scene.compare.tracks.numeric[s.key], p.compare, 1.5, false, bottom, xOf, yOf, plotW);
    }
  }
  // Second measure under the first.
  for (const s of [...lane.series].reverse()) {
    drawSeries(ctx, scene, scene.primary.numeric[s.key], p[s.color], 2, !!s.fillBelow, bottom, xOf, yOf, plotW);
  }
  ctx.restore();
}

/** The stretch of time being drawn, and the present. */
interface TimeWindow {
  t0: number;
  t1: number;
  now: number;
}

function drawSeries(
  ctx: CanvasRenderingContext2D,
  window: TimeWindow,
  series: NumericSeries,
  color: string,
  lineWidth: number,
  fillBelow: boolean,
  /** Where a fill below the line stops. */
  bottom: number,
  xOf: (t: number) => number,
  yOf: (v: number) => number,
  plotW: number,
  bandColor = withAlpha(color, 0.28),
): void {
  if (series.length === 0) return;
  const { t0, t1, now } = window;

  /** One unbroken stretch: the line, and the lowest and highest readings
   *  either side of it. */
  let top: number[] = [];
  let low: number[] = [];
  let high: number[] = [];
  const flush = () => {
    if (top.length >= 2) {
      if (fillBelow) {
        ctx.beginPath();
        ctx.moveTo(top[0], bottom);
        for (let i = 0; i < top.length; i += 2) ctx.lineTo(top[i], top[i + 1]);
        ctx.lineTo(top[top.length - 2], bottom);
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.14);
        ctx.fill();
      }
      if (low.length > 0) {
        ctx.beginPath();
        ctx.moveTo(high[0], high[1]);
        for (let i = 2; i < high.length; i += 2) ctx.lineTo(high[i], high[i + 1]);
        for (let i = low.length - 2; i >= 0; i -= 2) ctx.lineTo(low[i], low[i + 1]);
        ctx.closePath();
        ctx.fillStyle = bandColor;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      for (let i = 2; i < top.length; i += 2) ctx.lineTo(top[i], top[i + 1]);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
    if (top.length === 2) {
      // A lone reading: a dot, since there is nothing to join it to.
      ctx.beginPath();
      ctx.arc(top[0], top[1], lineWidth, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    top = [];
    low = [];
    high = [];
  };

  if (series.mode === 'hold') {
    const from = Math.max(0, series.lowerBound(t0) - 1);
    for (let i = from; i < series.length; i++) {
      const t = series.timeAt(i);
      if (t > t1) break;
      const v = series.valueAt(i);
      if (Number.isNaN(v)) {
        flush();
        continue;
      }
      const isLast = i === series.length - 1;
      const until = isLast ? Math.min(now, series.seenAt + series.staleAfterMs) : series.timeAt(i + 1);
      const y = yOf(v);
      top.push(xOf(t), y, xOf(Math.max(t, until)), y);
    }
    flush();
    return;
  }

  let lastT = -Infinity;
  // The band around the line is only drawn where some reading strayed from it.
  let anySpread = false;
  const end = () => {
    if (!anySpread) low = [];
    flush();
    anySpread = false;
  };
  bucketize(series, t0, t1, Math.ceil(plotW), (b, firstT, lastBucketT) => {
    const isGap = Number.isNaN(b.first);
    if (isGap || firstT - lastT > series.staleAfterMs) end();
    if (isGap) return;
    const xFirst = xOf(firstT);
    const xLast = xOf(lastBucketT);
    top.push(xFirst, yOf(b.first));
    if (firstT !== lastBucketT) {
      // Several readings in one pixel column: draw its full height.
      const xMid = (xFirst + xLast) / 2;
      top.push(xMid, yOf(b.max), xMid, yOf(b.min), xLast, yOf(b.last));
    }
    low.push((xFirst + xLast) / 2, yOf(b.lo));
    high.push((xFirst + xLast) / 2, yOf(b.hi));
    if (b.hi - b.lo > b.max - b.min + 1e-3) anySpread = true;
    lastT = lastBucketT;
  });
  end();
}

function drawNumericChrome(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  box: LaneBox,
  lane: NumericLane,
  scale: Scale,
  plotX: number,
  plotW: number,
  readT: number,
  font: (size: number, weight?: number) => string,
): void {
  const p = scene.palette;
  const yOf = (v: number) => box.plotY + 3 + (1 - (v - scale.min) / (scale.max - scale.min)) * (box.plotH - 6);

  // Scale labels in the gutter: the top and bottom of the scale.
  ctx.font = font(10);
  ctx.fillStyle = p.muted;
  ctx.textAlign = 'right';
  const labelled = [scale.ticks[0], scale.ticks[scale.ticks.length - 1]];
  for (const tick of new Set(labelled)) {
    if (tick === undefined) continue;
    ctx.fillText(formatTick(tick, tickDecimals(scale)), plotX - 6, yOf(tick));
  }

  if (lane.reference) {
    ctx.font = font(10);
    ctx.textAlign = 'left';
    ctx.fillStyle = p.critical;
    ctx.fillText(lane.reference.label, plotX + 4, yOf(lane.reference.value) - 7);
  }

  // Header: the lane's name, then each series' key and reading. When that
  // doesn't fit (a phone), the series names go and the unit moves up beside
  // the lane's name.
  const y = box.y + NUM_HEADER / 2;
  const values: Partial<Record<NumericKey, number>> = {};
  interface Entry {
    color?: string;
    label: string;
    /** Kept when space is short: without it the entry can't be told apart. */
    keepLabel?: boolean;
    value: number | undefined;
    unit: string;
  }
  const entries: Entry[] = [];
  for (const s of lane.series) {
    const sample = scene.primary.numeric[s.key].sampleAt(readT);
    if (sample) values[s.key] = sample.v;
    const label = s.label || (scene.compare ? scene.primaryName : '');
    entries.push({ color: p[s.color], label, value: sample?.v, unit: lane.unit });
  }
  if (lane.derived) {
    const value = lane.derived.from(values);
    entries.push({ label: lane.derived.label, keepLabel: true, value, unit: lane.derived.unit });
  }
  const compared = scene.compare && lane.series.find(s => s.compare);
  if (scene.compare && compared) {
    const sample = scene.compare.tracks.numeric[compared.key].sampleAt(readT);
    entries.push({ color: p.compare, label: scene.compare.name, value: sample?.v, unit: lane.unit });
  }

  const textOf = (e: Entry, compact: boolean) =>
    e.value === undefined ? '\u2014' : `${formatValue(e.value, lane.decimals)}${compact ? '' : ` ${e.unit}`}`;
  const widthOf = (compact: boolean) => {
    ctx.font = font(11, 600);
    let w = ctx.measureText(compact ? `${lane.title} ${lane.unit}` : lane.title).width + 10;
    for (const e of entries) {
      if (e.color) w += 14;
      const label = compact && !e.keepLabel ? '' : e.label;
      ctx.font = font(11);
      if (label) w += ctx.measureText(label).width + 4;
      ctx.font = font(11, 600);
      w += ctx.measureText(textOf(e, compact)).width + 12;
    }
    return w;
  };
  const compact = widthOf(false) > plotW;

  ctx.textAlign = 'left';
  ctx.font = font(11, 600);
  ctx.fillStyle = p.ink2;
  ctx.fillText(lane.title, plotX, y);
  let x = plotX + ctx.measureText(lane.title).width;
  if (compact) {
    ctx.font = font(11);
    ctx.fillStyle = p.muted;
    ctx.fillText(` ${lane.unit}`, x, y);
    x += ctx.measureText(` ${lane.unit}`).width;
  }
  x += 10;
  for (const e of entries) {
    if (e.color) {
      ctx.fillStyle = e.color;
      ctx.fillRect(x, y - 1, 10, 2);
      x += 14;
    }
    const label = compact && !e.keepLabel ? '' : e.label;
    if (label) {
      ctx.font = font(11);
      ctx.fillStyle = p.muted;
      ctx.fillText(label, x, y);
      x += ctx.measureText(label).width + 4;
    }
    const text = textOf(e, compact);
    ctx.font = font(11, 600);
    ctx.fillStyle = e.value === undefined ? p.muted : p.ink;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width + 12;
  }

  // The crosshair's readings, marked on the lines.
  if (scene.hoverT !== null) {
    const hx = plotX + ((scene.hoverT - scene.t0) / (scene.t1 - scene.t0)) * plotW;
    const dot = (series: NumericSeries, color: string) => {
      const sample = series.sampleAt(scene.hoverT!);
      if (!sample) return;
      const dy = yOf(sample.v);
      if (dy < box.plotY || dy > box.plotY + box.plotH) return;
      ctx.beginPath();
      ctx.arc(hx, dy, 6, 0, Math.PI * 2);
      ctx.fillStyle = p.surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx, dy, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    if (scene.compare) {
      const s = lane.series.find(s => s.compare);
      if (s) dot(scene.compare.tracks.numeric[s.key], p.compare);
    }
    for (const s of [...lane.series].reverse()) dot(scene.primary.numeric[s.key], p[s.color]);
  }
}

function tickDecimals(scale: Scale): number {
  const step = scale.ticks.length > 1 ? scale.ticks[1] - scale.ticks[0] : 1;
  return step < 0.1 ? 2 : step < 1 ? 1 : 0;
}

/** A scale label: short enough for the gutter however big the number. */
export function formatTick(v: number, decimals: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${formatValue(v / 1e6, abs % 1e6 === 0 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${formatValue(v / 1e3, abs % 1e3 === 0 ? 0 : 1)}k`;
  return formatValue(v, decimals);
}

/** A number with a real minus sign and thin-space thousands. */
export function formatValue(v: number, decimals: number): string {
  const fixed = Math.abs(v).toFixed(decimals);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const negative = v < 0 && Number(fixed) !== 0;
  return `${negative ? '−' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/**
 * One series on its own, edge to edge: no axes, no labels. For a reading
 * that sits beside its own number (the scoreboard's battery cards).
 */
export function drawSparkline(
  ctx: CanvasRenderingContext2D,
  series: NumericSeries,
  o: TimeWindow & {
    width: number;
    height: number;
    /** The scale, fixed, so every card reads the same. */
    min: number;
    max: number;
    color: string;
    /** The band between the lowest and highest readings. */
    bandColor: string;
    /** A faint line across the middle. */
    gridColor?: string;
  },
): void {
  ctx.clearRect(0, 0, o.width, o.height);
  if (o.gridColor) {
    ctx.fillStyle = o.gridColor;
    ctx.fillRect(0, Math.round(o.height / 2), o.width, 1);
  }
  ctx.lineJoin = 'round';
  const xOf = (t: number) => ((t - o.t0) / (o.t1 - o.t0)) * o.width;
  const yOf = (v: number) => 2 + (1 - (v - o.min) / (o.max - o.min)) * (o.height - 4);
  drawSeries(ctx, o, series, o.color, 1.5, false, o.height, xOf, yOf, o.width, o.bandColor);
}

// ── State lanes ─────────────────────────────────────────────────────

function drawStateLane(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  box: LaneBox,
  lane: StateLane,
  xOf: (t: number) => number,
  plotX: number,
  plotW: number,
  events: TimelineEvent[],
  font: (size: number, weight?: number) => string,
): void {
  const p = scene.palette;
  const right = plotX + plotW;
  const y = box.plotY;
  const h = box.plotH;

  const bands = (tracks: StationTracks, top: number, height: number, labels: boolean) => {
    for (const seg of lane.series(tracks).segments(scene.t0, scene.t1, scene.now)) {
      const style = lane.values[String(seg.value)];
      if (!style) continue;
      const x0 = Math.max(plotX, xOf(seg.start));
      // A sliver of surface between one state and the next.
      const x1 = Math.min(right, xOf(seg.end) - (seg.open ? 0 : 1.5));
      const w = Math.max(1, x1 - x0);
      if (x0 >= right) continue;

      if (style.tone === 'off') {
        ctx.fillStyle = p.axis;
        ctx.fillRect(x0, Math.round(top + height / 2), w, 1);
      } else if (style.tone === 'hollow') {
        ctx.strokeStyle = p.muted;
        ctx.lineWidth = 1;
        if (w > 2) {
          roundRect(ctx, x0 + 0.5, top + 0.5, w - 1, height - 1, 3);
        } else {
          ctx.beginPath();
          ctx.moveTo(x0 + 0.5, top);
          ctx.lineTo(x0 + 0.5, top + height);
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = p[style.tone];
        roundRect(ctx, x0, top, w, height, Math.min(3, w / 2));
        ctx.fill();
      }

      if (!labels) continue;
      ctx.font = font(10, 600);
      const textW = ctx.measureText(style.label).width;
      if (textW + 8 > w) continue;
      ctx.textAlign = 'left';
      ctx.fillStyle = textOn(p, style.tone);
      ctx.fillText(style.label, x0 + 5, top + height / 2 + 0.5);
    }
  };

  bands(scene.primary, y, h, true);
  if (scene.compare) bands(scene.compare.tracks, y + h + 2, COMPARE_STRIP, false);

  // Spans that belong to this lane (a dropout, on Comms) sit on the band.
  for (const e of events) {
    if (e.lane !== lane.id || e.end === undefined) continue;
    const x0 = Math.max(plotX, xOf(e.t));
    const x1 = Math.min(right, Math.max(x0 + 3, xOf(e.end)));
    if (x1 <= plotX || x0 >= right) continue;
    ctx.fillStyle = p.surface;
    ctx.fillRect(x0 - 1.5, y, x1 - x0 + 3, h);
    ctx.fillStyle = toneColor(p, e.tone);
    roundRect(ctx, x0, y, x1 - x0, h, Math.min(3, (x1 - x0) / 2));
    ctx.fill();
  }
}

function drawStateChrome(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  box: LaneBox,
  lane: StateLane,
  font: (size: number, weight?: number) => string,
): void {
  const p = scene.palette;
  ctx.font = font(11, 600);
  ctx.fillStyle = p.ink2;
  ctx.textAlign = 'right';
  ctx.fillText(lane.title, GUTTER - 6, box.plotY + box.plotH / 2 + 0.5);
  if (scene.compare) {
    // Which robot the thin strip belongs to: its colour, as in the legend.
    ctx.fillStyle = p.compare;
    ctx.fillRect(GUTTER - 12, box.plotY + box.plotH + 2 + COMPARE_STRIP / 2 - 1, 6, 2);
  }
}

function textOn(p: ChartPalette, tone: Tone): string {
  if (tone === 'hollow' || tone === 'off') return p.ink2;
  // Amber is too light for white text in either theme.
  return tone === 'warning' ? '#0b0b0b' : '#ffffff';
}

// ── Events ──────────────────────────────────────────────────────────

function toneColor(p: ChartPalette, tone: string): string {
  if (tone === 'good') return p.good;
  if (tone === 'warning') return p.warning;
  if (tone === 'serious') return p.serious;
  if (tone === 'critical') return p.critical;
  return p.ink2;
}

/** Where a line through the lanes is drawn: across the marks, but not
 *  through the numeric lanes' headers, where it would cross out the readings. */
function ruleSpans(layout: Layout): [number, number][] {
  const spans: [number, number][] = [];
  for (const box of layout.lanes) {
    const numeric = box.lane.kind === 'numeric';
    const y0 = numeric ? box.plotY : box.y - LANE_GAP / 2;
    const y1 = numeric ? box.plotY + box.plotH : box.y + box.h + LANE_GAP / 2;
    const last = spans[spans.length - 1];
    if (last && y0 <= last[1] + 0.5) last[1] = y1;
    else spans.push([y0, y1]);
  }
  return spans;
}

function strokeRule(ctx: CanvasRenderingContext2D, x: number, spans: [number, number][]): void {
  ctx.beginPath();
  for (const [y0, y1] of spans) {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  }
  ctx.stroke();
}

function drawRulesAndFlags(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  events: TimelineEvent[],
  xOf: (t: number) => number,
  plotX: number,
  plotW: number,
  font: (size: number, weight?: number) => string,
): void {
  const { layout, palette: p, now } = scene;
  const right = plotX + plotW;
  const flagY = FLAGS_H / 2;
  const spans = ruleSpans(layout);

  // Rules: a line through every lane at the moment it happened.
  ctx.lineWidth = 1;
  for (const e of events) {
    if (!e.rule) continue;
    const edges = e.end !== undefined || e.open ? [e.t, ...(e.open ? [] : [endOf(e, now)])] : [e.t];
    for (const t of edges) {
      const x = Math.round(xOf(t)) + 0.5;
      if (x < plotX || x > right) continue;
      ctx.strokeStyle = withAlpha(toneColor(p, e.tone), 0.75);
      strokeRule(ctx, x, spans);
    }
  }

  // Flags. Things that happened together (a match starting and the robot
  // enabling) share one marker and one label.
  interface Flag {
    x: number;
    labels: string[];
    tone: string;
    rule: boolean;
  }
  const flags: Flag[] = [];
  for (const e of events) {
    if (e.lane !== undefined) continue;
    if (xOf(endOf(e, now)) < plotX) continue;
    const x = Math.max(plotX, xOf(e.t));
    if (x > right) continue;
    const near = flags.find(f => Math.abs(f.x - x) <= 5);
    if (!near) {
      flags.push({ x, labels: [e.label], tone: e.tone, rule: !!e.rule });
      continue;
    }
    if (!near.labels.includes(e.label)) near.labels.push(e.label);
    if (TONE_RANK[e.tone] > TONE_RANK[near.tone]) near.tone = e.tone;
    near.rule ||= !!e.rule;
  }
  for (const f of flags) {
    ctx.fillStyle = toneColor(p, f.tone);
    ctx.beginPath();
    ctx.moveTo(f.x - 4, flagY - 4);
    ctx.lineTo(f.x + 4, flagY - 4);
    ctx.lineTo(f.x, flagY + 4);
    ctx.closePath();
    ctx.fill();
  }

  // A label goes beside its marker (after it, or before it when that side is
  // taken) only where it covers nothing else. The loudest are placed first;
  // the rest are left to the crosshair.
  const taken: [number, number][] = flags.map(f => [f.x - 5, f.x + 5]);
  ctx.font = font(10, 600);
  ctx.fillStyle = p.ink2;
  ctx.textAlign = 'left';
  const byLoudness = [...flags].sort(
    (a, b) => Number(b.rule) - Number(a.rule) || TONE_RANK[b.tone] - TONE_RANK[a.tone] || b.x - a.x,
  );
  for (const f of byLoudness) {
    // All of a shared flag's labels if they fit, else the first and a count.
    const texts = [f.labels.join(' \u00b7 ')];
    if (f.labels.length > 1) texts.push(`${f.labels[0]} +${f.labels.length - 1}`);
    for (const text of texts) {
      const textW = ctx.measureText(text).width;
      const free = (from: number) =>
        from >= 2 &&
        from + textW <= right + PAD_RIGHT &&
        !taken.some(([a, b]) => from < b + 4 && from + textW > a - 4 && a !== f.x - 5);
      const after = f.x + 8;
      const before = f.x - 8 - textW;
      const from = free(after) ? after : free(before) ? before : null;
      if (from === null) continue;
      taken.push([from, from + textW]);
      ctx.fillText(text, from, flagY + 0.5);
      break;
    }
  }
}

// ── Time axis ───────────────────────────────────────────────────────

const TICK_STEPS_MS = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

function drawAxis(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  xOf: (t: number) => number,
  plotX: number,
  plotW: number,
  font: (size: number, weight?: number) => string,
): void {
  const { layout, palette: p, t0, t1, now, live } = scene;
  const y = layout.bottom + 0.5;
  const span = t1 - t0;
  // Relative labels are short; clock times need more room.
  const minPx = live ? 56 : 84;
  const step = TICK_STEPS_MS.find(s => (s / span) * plotW >= minPx) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];

  ctx.strokeStyle = p.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, y);
  ctx.lineTo(plotX + plotW, y);
  ctx.stroke();

  ctx.font = font(10);
  ctx.fillStyle = p.muted;
  const labelY = layout.bottom + AXIS_H / 2 + 1;

  if (live) {
    // Count back from the right edge, which is now.
    ctx.textAlign = 'right';
    ctx.fillText('now', plotX + plotW, labelY);
    ctx.textAlign = 'center';
    for (let ago = step; ago < span; ago += step) {
      const x = xOf(t1 - ago);
      if (x < plotX + 14) break;
      ctx.fillRect(Math.round(x), layout.bottom, 1, 4);
      ctx.fillText(`−${formatSpan(ago)}`, x, labelY);
    }
    return;
  }

  ctx.textAlign = 'center';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = xOf(t);
    if (x < plotX + 30 || x > plotX + plotW - 30) continue;
    ctx.fillRect(Math.round(x), layout.bottom, 1, 4);
    ctx.fillText(formatClock(t, false), x, labelY);
  }
  // How far back the view is, since the clock alone doesn't say.
  ctx.textAlign = 'right';
  ctx.fillText(`${formatSpan(now - t1)} ago`, plotX + plotW, labelY);
}

/** "8 s", "1:30", "10 min". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const clockFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const clockZoneFormat = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/** The viewer's local time, 12-hour: "3:41:07 PM", with the zone on request. */
export function formatClock(t: number, zone: boolean): string {
  return (zone ? clockZoneFormat : clockFormat).format(new Date(t));
}

// ── Crosshair ───────────────────────────────────────────────────────

/** One line of the box at the crosshair. */
interface DetailRow {
  /** The time, at the top. */
  heading?: boolean;
  /** What marks this reading on the chart: its line, or its band. */
  key?: { color: string; shape: 'line' | 'block' | 'hollow' | 'dot' };
  /** The reading itself, which leads; who and what it is follows in `text`. */
  strong?: string;
  text: string;
  /** The one the pointer is on. */
  pointed?: boolean;
}

/** Where a value sits in a numeric lane. */
function laneY(box: LaneBox, scale: Scale, v: number): number {
  return box.plotY + 3 + (1 - (v - scale.min) / (scale.max - scale.min)) * (box.plotH - 6);
}

/**
 * The readings in the lane under the pointer, each named for its robot, and
 * a ring on the line the pointer is nearest. Hovering the other robot's line
 * (or its thin state strip) says so by name.
 */
function laneDetail(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  box: LaneBox,
  scales: Map<string, Scale>,
  x: number,
): DetailRow[] {
  const p = scene.palette;
  const t = scene.hoverT!;
  const y = scene.hoverY!;
  const lane = box.lane;
  const rows: DetailRow[] = [];

  if (lane.kind === 'state') {
    const onStrip = !!scene.compare && y > box.plotY + box.plotH + 1;
    const row = (tracks: StationTracks, name: string, pointed: boolean) => {
      const seg = lane.series(tracks).segments(t, t + 1, scene.now)[0];
      const style = seg && seg.start <= t ? lane.values[String(seg.value)] : undefined;
      if (!seg || !style) {
        rows.push({ strong: 'Unknown', text: `${name} \u00b7 ${lane.title}: nothing heard`, pointed });
        return;
      }
      const solid = style.tone !== 'hollow' && style.tone !== 'off';
      rows.push({
        key: { color: solid ? p[style.tone as 'good'] : p.muted, shape: solid ? 'block' : 'hollow' },
        strong: style.label,
        text: `${name} \u00b7 ${lane.title}, for ${formatSpan(seg.end - seg.start)}${seg.open ? ' so far' : ''}`,
        pointed,
      });
    };
    row(scene.primary, scene.primaryName, !onStrip);
    if (scene.compare) row(scene.compare.tracks, scene.compare.name, onStrip);
    return rows;
  }

  const scale = scales.get(lane.id)!;
  const marks: { row: DetailRow; y: number; color: string }[] = [];
  const values: Partial<Record<NumericKey, number>> = {};
  const reading = (series: NumericSeries, color: string, name: string, label: string) => {
    const sample = series.sampleAt(t);
    const row: DetailRow = { key: { color, shape: 'line' }, text: `${name} \u00b7 ${label}` };
    if (!sample) {
      row.strong = '\u2014';
      row.text += ': no reading';
    } else {
      row.strong = `${formatValue(sample.v, lane.decimals)} ${lane.unit}`;
      const spread = Math.pow(10, -lane.decimals) / 2;
      if (sample.hi - sample.lo > spread) {
        const lo = formatValue(sample.lo, lane.decimals);
        const hi = formatValue(sample.hi, lane.decimals);
        row.text += `, ranged ${lo} to ${hi} ${lane.unit}`;
      }
      marks.push({ row, y: laneY(box, scale, sample.v), color });
    }
    rows.push(row);
    return sample?.v;
  };
  for (const s of lane.series) {
    const v = reading(scene.primary.numeric[s.key], p[s.color], scene.primaryName, s.label || lane.title);
    if (v !== undefined) values[s.key] = v;
  }
  if (lane.derived) {
    const v = lane.derived.from(values);
    if (v !== undefined) {
      rows.push({
        strong: `${formatValue(v, lane.decimals)} ${lane.derived.unit}`,
        text: `${scene.primaryName} \u00b7 ${lane.derived.label}`,
      });
    }
  }
  const compared = scene.compare && lane.series.find(s => s.compare);
  if (scene.compare && compared) {
    reading(scene.compare.tracks.numeric[compared.key], p.compare, scene.compare.name, compared.label || lane.title);
  }

  // The line the pointer is nearest, if it is near one at all.
  let nearest: (typeof marks)[number] | undefined;
  for (const m of marks) if (!nearest || Math.abs(m.y - y) < Math.abs(nearest.y - y)) nearest = m;
  if (nearest && (marks.length === 1 || Math.abs(nearest.y - y) <= 14)) {
    nearest.row.pointed = true;
    ctx.strokeStyle = nearest.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, nearest.y, 7.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  return rows;
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  events: TimelineEvent[],
  scales: Map<string, Scale>,
  xOf: (t: number) => number,
  plotX: number,
  plotW: number,
  font: (size: number, weight?: number) => string,
): void {
  const { layout, palette: p, now, width } = scene;
  const t = scene.hoverT!;
  const x = Math.round(xOf(t)) + 0.5;
  const right = plotX + plotW;
  if (x < plotX || x > right) return;

  ctx.strokeStyle = withAlpha(p.ink2, 0.55);
  ctx.lineWidth = 1;
  strokeRule(ctx, x, ruleSpans(layout));

  const ago = now - t;
  const rows: DetailRow[] = [
    { heading: true, text: `${formatClock(t, true)}  \u00b7  ${ago < 950 ? 'now' : `${formatSpan(ago)} ago`}` },
  ];

  // The lane the pointer is in (the gap under a lane counts as that lane).
  const hy = scene.hoverY;
  const box =
    hy === null ? undefined : layout.lanes.find(b => hy >= b.y - LANE_GAP / 2 && hy < b.y + b.h + LANE_GAP / 2);
  if (box) rows.push(...laneDetail(ctx, scene, box, scales, x));

  // What happened here: anything within a few pixels of the line. The other
  // robot's events have no flags of their own, so they are named.
  const reachMs = (6 / plotW) * (scene.t1 - scene.t0);
  const within = (e: TimelineEvent) => e.t - reachMs <= t && endOf(e, now) + reachMs >= t;
  const near: { e: TimelineEvent; who?: string }[] = events.filter(within).map(e => ({ e }));
  if (scene.compare) {
    const who = scene.compare.name;
    for (const e of scene.compare.tracks.events.inRange(scene.t0, scene.t1, now)) if (within(e)) near.push({ e, who });
  }
  const MAX_EVENTS = 3;
  // A match phase and the robot's mode can share a name: say it once.
  const said = new Set<string>();
  const happened: DetailRow[] = [];
  for (const { e, who } of near) {
    const length = e.end !== undefined && e.end > e.t ? ` (${formatSpan(e.end - e.t)})` : e.open ? ' (so far)' : '';
    const text = `${who ? `${who}: ` : ''}${e.label}${e.detail ? `: ${e.detail}` : ''}${length}`;
    if (said.has(text)) continue;
    said.add(text);
    happened.push({ key: { color: toneColor(p, e.tone), shape: 'dot' }, text });
  }
  rows.push(...happened.slice(0, MAX_EVENTS));
  if (happened.length > MAX_EVENTS) {
    rows.push({ text: `and ${happened.length - MAX_EVENTS} more: zoom in to tell them apart` });
  }

  // Lay the rows out, wrapping to the chart's width so a long one is not
  // cut off on a phone.
  const padX = 8;
  const KEY_W = 14;
  const lineH = 16;
  const maxW = Math.max(120, width - 4 - padX * 2);
  const strongFont = font(11, 600);
  const textFont = (row: DetailRow) => font(11, row.heading || row.pointed ? 600 : 400);
  interface Line {
    row: DetailRow;
    /** Later lines of a wrapped row carry only text. */
    first: boolean;
    text: string;
    textX: number;
  }
  const lines: Line[] = [];
  let boxW = 0;
  for (const row of rows) {
    let lead = row.key ? KEY_W : 0;
    if (row.strong) {
      ctx.font = strongFont;
      lead += ctx.measureText(row.strong).width + 6;
    }
    ctx.font = textFont(row);
    let current = '';
    let first = true;
    const flushLine = () => {
      const textX = first ? lead : row.key ? KEY_W : 0;
      lines.push({ row, first, text: current, textX });
      boxW = Math.max(boxW, textX + ctx.measureText(current).width);
      first = false;
    };
    for (const word of row.text.split(' ')) {
      const trial = current ? `${current} ${word}` : word;
      const room = maxW - (first ? lead : row.key ? KEY_W : 0);
      if (current && ctx.measureText(trial).width > room) {
        flushLine();
        current = word;
      } else current = trial;
    }
    flushLine();
  }
  boxW = Math.min(maxW, boxW) + padX * 2;
  const boxH = lines.length * lineH + 6;

  // Beside the line, on whichever side has room; above the lane the pointer
  // is in (below it, when there is no room above), so it covers neither the
  // reading nor a finger.
  let boxX = x + 10;
  if (boxX + boxW > width - 2) boxX = x - 10 - boxW;
  boxX = Math.max(2, Math.min(boxX, width - 2 - boxW));
  let boxY = 1;
  if (box) {
    boxY = box.y - 6 - boxH;
    if (boxY < 1) boxY = Math.min(box.y + box.h + 6, layout.height - boxH - 1);
    boxY = Math.max(1, boxY);
  }

  ctx.fillStyle = p.surface;
  roundRect(ctx, boxX, boxY, boxW, boxH, 4);
  ctx.fill();
  ctx.strokeStyle = p.axis;
  ctx.lineWidth = 1;
  roundRect(ctx, boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1, 4);
  ctx.stroke();

  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    const { row } = line;
    const y = boxY + 3 + lineH * i + lineH / 2;
    const left = boxX + padX;
    if (line.first && row.key) {
      const { color, shape } = row.key;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (shape === 'line') ctx.fillRect(left, y - 1, 10, 2);
      else if (shape === 'block') {
        roundRect(ctx, left, y - 4, 10, 8, 2);
        ctx.fill();
      } else if (shape === 'hollow') {
        ctx.lineWidth = 1;
        roundRect(ctx, left + 0.5, y - 3.5, 9, 7, 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(left + 4, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (line.first && row.strong) {
      ctx.font = strongFont;
      ctx.fillStyle = p.ink;
      ctx.fillText(row.strong, left + (row.key ? KEY_W : 0), y);
    }
    ctx.font = textFont(row);
    ctx.fillStyle = row.heading || row.pointed ? p.ink : p.ink2;
    ctx.fillText(line.text, left + line.textX, y);
  });
}

// ── helpers ─────────────────────────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** A `#rrggbb` colour at an opacity. Anything else is returned as it came. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
