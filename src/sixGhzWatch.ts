/**
 * 6 GHz watch: listen on 6 GHz for access points using a team's network
 * name other than the field's own — usually a team's backup AP left on. It
 * advertises the same SSID (and passphrase) as the field, so the robot radio
 * joins whichever it finds first, and the field may never see the robot.
 *
 * Robots join the field only on 6 GHz, and the field AP announces team
 * networks only there, so this needs a 6 GHz-capable card (the robot scan's
 * card may not be one). pFMS runs its own wpa_supplicant on the card and only
 * ever scans with it — it never joins anything. See
 * plans/competing-ap-6ghz-watch.md.
 */
import { parseScanResults, type ScanRow, type WifiRunner } from './robotWifiScan.js';
import type { SixGhzClash, SixGhzNetwork, SixGhzWatchState, StationName } from './types.js';
import { teamOfSsid } from './utils.js';

// ── Pure helpers ────────────────────────────────────────────────────

/** 6 GHz is 5925–7125 MHz; channel n is centred on 5950 + 5n MHz. */
export const isSixGhz = (mhz: number): boolean => mhz > 5925 && mhz <= 7125;

/** 5955 → 1, 6015 → 13. */
export const sixGhzChannel = (mhz: number): number => (mhz - 5950) / 5;

/** Whether a 6 GHz access point on `mhz` sits inside the field's channel:
 *  its 20 MHz primary channel, widened to `bandwidthMHz` the standard way
 *  (channels 1, 5, 9, … grouped in twos for 40 MHz, fours for 80, …). */
export function inFieldChannel(mhz: number, field: { channel: number; bandwidthMHz: number }): boolean {
  const width = Math.max(1, Math.round(field.bandwidthMHz / 20));
  const block = (channel: number) => Math.floor((channel - 1) / 4 / width);
  return isSixGhz(mhz) && block(sixGhzChannel(mhz)) === block(field.channel);
}

/** The 6 GHz frequencies a card may use, from `wpa_cli get_capability freq`:
 *  `Mode[A] Channels:` then lines like ` 1 = 5955 MHz` (disabled channels
 *  are left out by wpa_supplicant; NO_IR ones are kept — they can still be
 *  listened on). */
export function parseSixGhzFreqs(text: string): number[] {
  const freqs = new Set<number>();
  for (const m of text.matchAll(/^\s*\d+\s*=\s*(\d+)\s*MHz/gm)) {
    const mhz = Number(m[1]);
    if (isSixGhz(mhz)) freqs.add(mhz);
  }
  return [...freqs].sort((a, b) => a - b);
}

/** What the field AP is doing on 6 GHz, from its own status. */
export interface FieldRadio {
  channel: number;
  bandwidthMHz: number;
  /** The network names it is serving, and for which station */
  serving: { ssid: string; station: StationName }[];
}

export type HeardBss = Omit<SixGhzNetwork, 'kind'>;

const KIND_ORDER: Record<SixGhzNetwork['kind'], number> = { competing: 0, teamAp: 1, field: 2, other: 3 };

/** Sort out what was heard. Names match exactly — a robot radio only joins
 *  the exact SSID, capitals included.
 *  - A name the field serves: its access points outside the field's channel
 *    are competing. Inside it, the strongest is taken to be the field and
 *    any more are competing (the field has one per name).
 *  - A team's saved robot name the field isn't serving: a team AP.
 *  Without the field's status nothing counts as a clash: a name the field
 *  is serving would look like a team AP. */
export function classifySixGhz(
  heard: HeardBss[],
  field: FieldRadio | null,
  savedSsids: readonly string[],
): { networks: SixGhzNetwork[]; clashes: SixGhzClash[] } {
  const kinds = new Map<string, SixGhzNetwork['kind']>(); // by bssid
  const clashes: SixGhzClash[] = [];
  const byName = new Map<string, HeardBss[]>();
  for (const h of heard) if (h.ssid) byName.set(h.ssid, [...(byName.get(h.ssid) ?? []), h]);

  if (field) {
    const saved = new Set(savedSsids);
    for (const [ssid, all] of byName) {
      const strongest = [...all].sort((a, b) => b.signal - a.signal);
      const served = field.serving.find(s => s.ssid === ssid);
      let others: HeardBss[];
      if (served) {
        const fieldAp = strongest.find(h => inFieldChannel(h.frequency, field));
        if (fieldAp) kinds.set(fieldAp.bssid, 'field');
        others = strongest.filter(h => h !== fieldAp);
      } else if (saved.has(ssid)) {
        others = strongest;
      } else {
        continue;
      }
      if (!others.length) continue;
      const kind = served ? 'competing' : 'teamAp';
      for (const h of others) kinds.set(h.bssid, kind);
      clashes.push({
        ssid,
        team: teamOfSsid(ssid) ?? 0,
        kind,
        ...(served && { station: served.station }),
        others: others.map(({ bssid, frequency, signal }) => ({ bssid, frequency, signal })),
      });
    }
  }

  const networks = heard
    .map(h => ({ ...h, kind: kinds.get(h.bssid) ?? ('other' as const) }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.signal - a.signal);
  clashes.sort((a, b) => (a.kind === b.kind ? a.team - b.team : a.kind === 'competing' ? -1 : 1));
  return { networks, clashes };
}

// ── The watch ───────────────────────────────────────────────────────

export interface SixGhzWatchOptions {
  iface: string;
  runner: WifiRunner;
  /** Regulatory country, also written into the runner's config */
  country: string;
  /** The field AP's channel and the names it serves; null if unknown */
  field: () => FieldRadio | null;
  /** SSIDs of the robots teams have saved */
  savedSsids: () => string[];
  onChange: (state: SixGhzWatchState) => void;
  now?: () => number;
  scanIntervalMs?: number;
  /** How long after asking for a scan to read its results. Every 6 GHz
   *  channel, listened to in turn, takes several seconds. */
  scanSettleMs?: number;
  /** An access point not heard for this long drops off the list. */
  expireMs?: number;
}

/** Everything else heard is shown on the admin page; keep that list short. */
const MAX_OTHERS = 40;

export class SixGhzWatch {
  private readonly o: Required<Omit<SixGhzWatchOptions, 'now'>> & { now: () => number };
  private status: SixGhzWatchState['status'] = 'off';
  private error: string | undefined;
  private freqs: number[] = [];
  private freqsAsked = false;
  private lastScanAt: number | undefined;
  private seen = new Map<string, HeardBss>(); // by bssid
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private stopped = false;

  get iface(): string {
    return this.o.iface;
  }

  get country(): string {
    return this.o.country;
  }

  constructor(options: SixGhzWatchOptions) {
    this.o = {
      now: Date.now,
      scanIntervalMs: 30_000,
      scanSettleMs: 12_000,
      expireMs: 120_000,
      ...options,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus('starting');
    try {
      await this.o.runner.start(
        () => {},
        why => {
          if (this.stopped) return;
          this.error = why;
          this.setStatus('error');
          this.clearTimer();
        },
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.setStatus('error');
      return;
    }
    if (this.stopped) return;
    // The config file sets it too; saying it again costs nothing and covers a
    // wpa_supplicant that only applies it on request.
    await this.o.runner.cli('set', 'country', this.o.country).catch(() => {});
    this.error = undefined;
    this.setStatus('running');
    void this.scanOnce();
    this.timer = setInterval(() => void this.scanOnce(), this.o.scanIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.o.runner.stop();
    this.seen.clear();
    this.setStatus('off');
  }

  private clearTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setStatus(status: SixGhzWatchState['status']) {
    this.status = status;
    this.emit();
  }

  private emit() {
    this.o.onChange(this.getState());
  }

  /** Which 6 GHz channels the card may use. Asked until there are some: a
   *  country change reaches wpa_supplicant a moment after it starts. */
  private async loadFreqs(): Promise<void> {
    const before = this.freqs.length;
    this.freqs = parseSixGhzFreqs(await this.o.runner.cli('get_capability', 'freq'));
    this.freqsAsked = true;
    if (this.freqs.length !== before)
      console.log(
        `6 GHz watch on ${this.o.iface}: ${this.freqs.length} channel${this.freqs.length === 1 ? '' : 's'} at country ${this.o.country}`,
      );
  }

  /** One scan of every 6 GHz channel, then fold in what was heard. */
  async scanOnce(): Promise<void> {
    if (this.status !== 'running' || this.scanning) return;
    this.scanning = true;
    try {
      if (!this.freqs.length) await this.loadFreqs();
      if (!this.freqs.length) {
        this.emit(); // shows the problem
        return;
      }
      // non_coloc_6ghz: every channel, not only those a 2.4/5 GHz AP points to
      await this.o.runner.cli('scan', 'non_coloc_6ghz=1', `freq=${this.freqs.join(',')}`);
      await new Promise(r => setTimeout(r, this.o.scanSettleMs));
      if (this.status !== 'running') return;
      this.ingest(parseScanResults(await this.o.runner.cli('scan_results'), { keepHidden: true }));
    } catch (err) {
      console.warn('6 GHz watch scan failed:', err instanceof Error ? err.message : err);
    } finally {
      this.scanning = false;
    }
  }

  /** Fold a scan into what has been heard, dropping access points gone quiet. */
  ingest(rows: ScanRow[]): void {
    const now = this.o.now();
    this.lastScanAt = now;
    const before = new Set(this.clashKeys());
    for (const r of rows) {
      if (!isSixGhz(r.frequency)) continue;
      this.seen.set(r.bssid, { ssid: r.ssid, bssid: r.bssid, frequency: r.frequency, signal: r.signal, lastSeen: now });
    }
    for (const [bssid, s] of this.seen) if (now - s.lastSeen > this.o.expireMs) this.seen.delete(bssid);
    for (const key of this.clashKeys())
      if (!before.has(key)) console.log(`6 GHz watch: ${key.replace('\n', ' ')} on the air`);
    this.emit();
  }

  private clashKeys(): string[] {
    return this.classify().clashes.flatMap(c =>
      c.others.map(o => `${c.kind === 'competing' ? 'competing AP' : 'team AP'} "${c.ssid}"\n${o.bssid}`),
    );
  }

  private classify() {
    return classifySixGhz([...this.seen.values()], this.o.field(), this.o.savedSsids());
  }

  getState(): SixGhzWatchState {
    const field = this.o.field();
    const { networks, clashes } = this.classify();
    const others = networks.filter(n => n.kind === 'other').slice(0, MAX_OTHERS);
    const problem =
      this.status === 'running' && this.freqsAsked && !this.freqs.length
        ? `${this.o.iface} offers no 6 GHz channels — the card may not do 6 GHz, or country ${this.o.country} doesn't allow it`
        : undefined;
    return {
      type: 'sixGhzWatch',
      status: this.status,
      iface: this.o.iface,
      ...(this.error && { error: this.error }),
      ...(problem && { problem }),
      country: this.o.country,
      channels: this.freqs.length,
      ...(this.lastScanAt !== undefined && { lastScanAt: this.lastScanAt }),
      ...(field && { field: { channel: field.channel, bandwidthMHz: field.bandwidthMHz } }),
      networks: [...networks.filter(n => n.kind !== 'other'), ...others],
      clashes,
    };
  }
}
