import type { TelemetryUpdate } from './types.js';

/**
 * Per-station coalescer for telemetry broadcasts.
 *
 * Robot packet capture emits an update per sniffed packet — ~40-50/s per
 * robot, 250+/s with six robots on the field — and broadcasting each one
 * floods every WebSocket client (measured 56 KB/s of a 58 KB/s scores
 * socket). On a slow display (a Chromecast on TV Wi-Fi) the backlog queues
 * ahead of score updates, making the scoreboard visibly lag reality.
 *
 * Steady-state updates are throttled to one per station per interval, latest
 * wins. Updates whose dsStatus changed (enable, e-stop, mode, comms) flush
 * immediately so control indicators stay snappy.
 */
export function createTelemetryCoalescer(
  send: (update: TelemetryUpdate) => void,
  intervalMs = 250,
): (update: TelemetryUpdate) => void {
  interface StationState {
    latest: TelemetryUpdate | null;
    lastSentAt: number;
    lastStatusKey: string;
    timer: ReturnType<typeof setTimeout> | null;
    /** Lowest voltage seen since the last flush — brief sags between flushes
     *  would otherwise be dropped by latest-wins coalescing, and the sag
     *  floor is the main thing the battery charts exist to show. */
    pendingMin: number;
    /** Highest, and the sum and count for the mean: with the lowest, what a
     *  chart needs to draw the window honestly from one sample of it. */
    pendingMax: number;
    pendingSum: number;
    pendingCount: number;
  }
  const stations = new Map<string, StationState>();

  const statusKey = (u: TelemetryUpdate) => (u.dsStatus ? JSON.stringify(u.dsStatus) : '');

  const flush = (st: StationState, update: TelemetryUpdate) => {
    st.latest = null;
    st.lastSentAt = Date.now();
    if (update.dsStatus !== undefined) st.lastStatusKey = statusKey(update);
    if (update.batteryVoltage !== undefined && st.pendingCount > 0) {
      const extra: Partial<TelemetryUpdate> = {};
      if (st.pendingMin < update.batteryVoltage) extra.batteryVoltageMin = st.pendingMin;
      if (st.pendingMax > update.batteryVoltage) extra.batteryVoltageMax = st.pendingMax;
      if (st.pendingCount > 1) extra.batteryVoltageAvg = Math.round((st.pendingSum / st.pendingCount) * 1000) / 1000;
      update = { ...update, ...extra };
    }
    st.pendingMin = NaN;
    st.pendingMax = NaN;
    st.pendingSum = 0;
    st.pendingCount = 0;
    send(update);
  };

  return update => {
    let st = stations.get(update.station);
    if (!st) {
      st = {
        latest: null,
        lastSentAt: 0,
        lastStatusKey: '',
        timer: null,
        pendingMin: NaN,
        pendingMax: NaN,
        pendingSum: 0,
        pendingCount: 0,
      };
      stations.set(update.station, st);
    }

    if (update.batteryVoltage !== undefined) {
      const v = update.batteryVoltage;
      if (st.pendingCount === 0 || v < st.pendingMin) st.pendingMin = v;
      if (st.pendingCount === 0 || v > st.pendingMax) st.pendingMax = v;
      st.pendingSum += v;
      st.pendingCount++;
    }

    const now = Date.now();
    const statusChanged = update.dsStatus !== undefined && statusKey(update) !== st.lastStatusKey;

    if (statusChanged || now - st.lastSentAt >= intervalMs) {
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      flush(st, update);
      return;
    }

    // Within the window — stash the latest and flush on the trailing edge
    st.latest = update;
    if (!st.timer) {
      st.timer = setTimeout(
        () => {
          st.timer = null;
          if (st.latest) flush(st, st.latest);
        },
        Math.max(0, intervalMs - (now - st.lastSentAt)),
      );
    }
  };
}
