import { useEffect, useRef } from 'react';
import type { StationName } from '../../../src/types';
import { getServerTime } from '../hooks/useBackend';
import { liveTimeline, startLiveTimeline } from '../timeline/live';
import { drawSparkline } from '../timeline/render';

/** How far back a battery sparkline reaches. */
export const BATTERY_SPARK_MS = 40_000;
/** The same scale on every card, so one glance compares robots. */
const MIN_V = 5;
const MAX_V = 14;

/** The lowest battery reading the sparkline is showing right now, sags
 *  between broadcasts included (undefined with no readings in view). */
export function lowestBatteryInView(station: StationName): number | undefined {
  const now = getServerTime();
  return liveTimeline.stations[station].numeric.battery.range(now - BATTERY_SPARK_MS, now)?.min;
}

/**
 * A robot's battery over the last 40 seconds: the line is the average of each
 * quarter second, the red band behind it runs from the lowest reading to the
 * highest, so a sag shows as a red notch even when the line barely moves.
 * No axes or labels; the card it sits in carries the numbers.
 */
export function BatterySparkline({ station, color, height }: { station: StationName; color: string; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(startLiveTimeline, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let width = canvas.clientWidth;
    const ro = new ResizeObserver(() => {
      width = canvas.clientWidth;
    });
    ro.observe(canvas);

    let raf = 0;
    let last = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (width <= 0) return;
      // The line moves a pixel every (span / width): no need to draw faster.
      if (ts - last < Math.min(500, Math.max(66, BATTERY_SPARK_MS / width / 2))) return;
      last = ts;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const now = getServerTime();
      drawSparkline(ctx, liveTimeline.stations[station].numeric.battery, {
        width,
        height,
        t0: now - BATTERY_SPARK_MS,
        t1: now,
        now,
        min: MIN_V,
        max: MAX_V,
        color,
        bandColor: 'rgba(244, 67, 54, 0.45)',
        gridColor: 'rgba(255,255,255,0.05)',
      });
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [station, color, height]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="Battery voltage over the last 40 seconds"
      style={{ display: 'block', width: '100%', height }}
    />
  );
}
