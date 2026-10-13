/**
 * One wireless card pFMS runs: its own wpa_supplicant, one scan loop, and
 * the jobs that use it — the robot Wi-Fi scan and the 6 GHz watch, on one
 * card or on two. The card scans every band its jobs want (that it has) and
 * hands each scan to every job. A join — a passphrase check, a staff test
 * join — borrows the radio, and scans wait for it.
 *
 * Which bands a card has comes from its own wpa_supplicant
 * (`get_capability freq`) once pFMS runs it; it is remembered for the admin
 * page's card pickers. See plans/one-card-wifi-jobs.md.
 */
import {
  attemptJoin,
  parseScanResults,
  parseWpaEvent,
  testJoin,
  WpaSupplicantRunner,
  type JoinOutcome,
  type ScanRow,
  type WifiRunner,
  type WpaEvent,
} from './robotWifiScan.js';
import type { WifiBand, WifiSecurity, WifiTestJoinResult } from './types.js';

// ── Pure helpers ────────────────────────────────────────────────────

/** 6 GHz is 5925–7125 MHz; channel n is centred on 5950 + 5n MHz. */
export const isSixGhz = (mhz: number): boolean => mhz > 5925 && mhz <= 7125;

/** The band a frequency is in, or null for anything else. */
export function bandOf(mhz: number): WifiBand | null {
  if (mhz >= 2400 && mhz <= 2500) return '2.4';
  if (mhz >= 5150 && mhz <= 5925) return '5';
  if (isSixGhz(mhz)) return '6';
  return null;
}

/** Every frequency a card may use, from `wpa_cli get_capability freq`:
 *  `Mode[G] Channels:` / `Mode[A] Channels:` then lines like ` 1 = 5955 MHz`.
 *  wpa_supplicant leaves out disabled channels (so 6 GHz appears only once a
 *  country allows it) and keeps NO_IR ones — they can still be listened on. */
export function parseCapabilityFreqs(text: string): number[] {
  const freqs = new Set<number>();
  for (const m of text.matchAll(/^\s*\d+\s*=\s*(\d+)\s*MHz/gm)) {
    const mhz = Number(m[1]);
    if (bandOf(mhz)) freqs.add(mhz);
  }
  return [...freqs].sort((a, b) => a - b);
}

/** The bands among some frequencies, lowest first. */
export function bandsOfFreqs(freqs: readonly number[]): WifiBand[] {
  const order: WifiBand[] = ['2.4', '5', '6'];
  const have = new Set(freqs.map(bandOf));
  return order.filter(b => have.has(b));
}

/** How long a scan of this many channels takes to finish: a passive listen
 *  on each in turn (6 GHz and 5 GHz DFS channels can't be probed), with room
 *  to spare. wpa_supplicant only reports "done" on its control socket. */
export const scanSettleMs = (channels: number): number => Math.max(5_000, channels * 200);

// ── Bands seen per card ─────────────────────────────────────────────

/** What each card's wpa_supplicant offered, last time pFMS ran it. */
const knownBands = new Map<string, WifiBand[]>();

/** The bands a card is known to have, or undefined before pFMS has run it. */
export const bandsOfCard = (iface: string): WifiBand[] | undefined => knownBands.get(iface);

// ── The card ────────────────────────────────────────────────────────

/** Something using a card. */
export interface WifiCardJob {
  /** The bands it wants scanned, asked before every scan */
  bands(): readonly WifiBand[];
  /** Every scan, hidden networks included */
  onScan(rows: ScanRow[]): void;
  /** After every job has had the scan: work that wants the radio next */
  afterScan?(): Promise<void>;
  /** The card's status, error or channels changed */
  onCardChange(): void;
}

export type WifiCardStatus = 'off' | 'starting' | 'running' | 'error';

type TestResult = Omit<WifiTestJoinResult, 'id' | 'iface' | 'at'>;

export interface WifiCardOptions {
  iface: string;
  runner: WifiRunner;
  /** Regulatory country (the kernel keeps one for the whole host) */
  country: string;
  now?: () => number;
  /** Rest between one scan's results and the next scan */
  scanGapMs?: number;
  /** How long a scan of `channels` channels takes */
  settleMs?: (channels: number) => number;
}

export class WifiCard {
  private readonly o: Required<Omit<WifiCardOptions, 'country'>>;
  private _country: string;
  private _status: WifiCardStatus = 'off';
  private _error: string | undefined;
  private freqs: number[] = [];
  private freqsRead = false;
  private _lastScanAt: number | undefined;
  private readonly jobs = new Set<WifiCardJob>();
  private starting: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  private stopped = true;
  /** Join events go to whichever join holds the radio (one at a time). */
  private joinEvents: ((e: WpaEvent) => void) | null = null;
  private radio: Promise<unknown> = Promise.resolve();
  private radioUsers = 0;

  constructor(options: WifiCardOptions) {
    this.o = {
      now: Date.now,
      scanGapMs: 10_000,
      settleMs: scanSettleMs,
      ...options,
    };
    this._country = options.country;
  }

  get iface(): string {
    return this.o.iface;
  }
  get country(): string {
    return this._country;
  }
  get status(): WifiCardStatus {
    return this._status;
  }
  get error(): string | undefined {
    return this._error;
  }
  get lastScanAt(): number | undefined {
    return this._lastScanAt;
  }
  /** A join or scan holds the radio right now */
  get busy(): boolean {
    return this.radioUsers > 0;
  }
  get jobCount(): number {
    return this.jobs.size;
  }

  /** The bands this card offers, once its wpa_supplicant has said. */
  bands(): WifiBand[] | undefined {
    return this.freqsRead ? bandsOfFreqs(this.freqs) : undefined;
  }

  /** The channels it may use in one band. */
  freqsIn(band: WifiBand): number[] {
    return this.freqs.filter(f => bandOf(f) === band);
  }

  /** Start using the card for a job. Starts the card if this is the first
   *  (or the card stopped on an error); resolves once it is up or failed. */
  attach(job: WifiCardJob): Promise<void> {
    this.jobs.add(job);
    this.ensureStarted();
    job.onCardChange();
    return this.starting ?? Promise.resolve();
  }

  private ensureStarted() {
    if (this.starting || !this.jobs.size || (this._status !== 'off' && this._status !== 'error')) return;
    if (this._status === 'error') this.o.runner.stop();
    this.starting = this.start().finally(() => {
      this.starting = null;
      // Every job left while it started, and one came back since
      if (this._status === 'off') this.ensureStarted();
    });
  }

  /** Stop using the card for a job; the last one out stops the card. */
  detach(job: WifiCardJob): void {
    if (!this.jobs.delete(job)) return;
    if (!this.jobs.size) this.stop();
  }

  /** A new country: tell wpa_supplicant now (6 GHz channels follow). */
  setCountry(country: string): void {
    if (country === this._country) return;
    this._country = country;
    if (this._status === 'running') void this.applyCountry();
  }

  private async applyCountry() {
    // The config file sets it too; saying it again covers a wpa_supplicant
    // that only applies it on request, and a change while running.
    await this.o.runner.cli('set', 'country', this._country).catch(() => {});
  }

  private async start(): Promise<void> {
    this.stopped = false;
    this.setStatus('starting');
    try {
      await this.o.runner.start(
        line => {
          const e = parseWpaEvent(line);
          if (e) this.joinEvents?.(e);
        },
        why => {
          if (this.stopped) return;
          this._error = why;
          this.joinEvents?.({ type: 'authFailed', reason: why });
          this.clearTimer();
          this.setStatus('error');
        },
      );
    } catch (err) {
      if (this.stopped) return; // detached while starting
      this._error = err instanceof Error ? err.message : String(err);
      this.setStatus('error');
      return;
    }
    if (this.stopped) return;
    await this.applyCountry();
    this._error = undefined;
    this.setStatus('running');
    void this.tick();
  }

  private stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.o.runner.stop();
    this.freqs = [];
    this.freqsRead = false;
    this._error = undefined;
    this.setStatus('off');
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(status: WifiCardStatus) {
    this._status = status;
    this.notify();
  }

  private notify() {
    for (const job of [...this.jobs]) job.onCardChange();
  }

  /** One scan, then the next after a rest. */
  private async tick() {
    await this.scanOnce();
    if (this._status !== 'running' || this.stopped) return;
    this.clearTimer();
    this.timer = setTimeout(() => void this.tick(), this.o.scanGapMs);
  }

  /** Hold the radio for `fn`: one join or scan at a time. */
  withRadio<T>(fn: () => Promise<T>): Promise<T> {
    this.radioUsers++;
    const run = this.radio.then(
      () => fn(),
      () => fn(),
    );
    this.radio = run.catch(() => {});
    return run.finally(() => this.radioUsers--);
  }

  /** Which channels the card may use. Read every scan: cheap, and a country
   *  change reaches wpa_supplicant a moment after it starts. */
  private async loadFreqs(): Promise<void> {
    const freqs = parseCapabilityFreqs(await this.o.runner.cli('get_capability', 'freq'));
    const changed = !this.freqsRead || freqs.join() !== this.freqs.join();
    this.freqs = freqs;
    this.freqsRead = true;
    if (!changed) return;
    const bands = bandsOfFreqs(freqs);
    knownBands.set(this.o.iface, bands);
    const per = bands.map(b => `${b} GHz: ${this.freqsIn(b).length}`).join(', ');
    const n = `${freqs.length} channel${freqs.length === 1 ? '' : 's'}`;
    console.log(`Wi-Fi card ${this.o.iface}: ${n} (${per || 'none'}) at country ${this._country}`);
    this.notify();
  }

  /** The channels to scan: every band some job wants, that the card has. */
  private wantedFreqs(): number[] {
    const wanted = new Set<WifiBand>();
    for (const job of this.jobs) for (const b of job.bands()) wanted.add(b);
    return this.freqs.filter(f => wanted.has(bandOf(f)!));
  }

  /** One scan of every wanted channel; every job gets the results. */
  async scanOnce(): Promise<void> {
    if (this._status !== 'running' || this.scanning) return;
    this.scanning = true;
    try {
      const rows = await this.withRadio(async () => {
        await this.loadFreqs();
        const freqs = this.wantedFreqs();
        if (!freqs.length) return null;
        // non_coloc_6ghz: every 6 GHz channel, not only those a 2.4/5 GHz AP points to
        const six = freqs.some(isSixGhz) ? ['non_coloc_6ghz=1'] : [];
        await this.o.runner.cli('scan', ...six, `freq=${freqs.join(',')}`);
        await new Promise(r => setTimeout(r, this.o.settleMs(freqs.length)));
        if (this._status !== 'running') return null;
        return parseScanResults(await this.o.runner.cli('scan_results'), { keepHidden: true });
      });
      if (!rows) return;
      this._lastScanAt = this.o.now();
      const jobs = [...this.jobs];
      for (const job of jobs) job.onScan(rows);
      for (const job of jobs) await job.afterScan?.();
    } catch (err) {
      console.warn(`Wi-Fi scan on ${this.o.iface} failed:`, err instanceof Error ? err.message : err);
    } finally {
      this.scanning = false;
    }
  }

  /** Join a network once and leave (see attemptJoin), holding the radio. */
  join(target: { ssid: string; security: WifiSecurity; passphrase?: string }, timeoutMs: number): Promise<JoinOutcome> {
    return this.withRadio(() =>
      attemptJoin(this.cli, h => (this.joinEvents = h), target, timeoutMs).finally(() => (this.joinEvents = null)),
    );
  }

  /** A staff test join (see testJoin), holding the radio. */
  testJoin(request: { ssid: string; passphrase?: string }, opts: { settleMs: number; timeoutMs: number }) {
    if (this._status !== 'running') throw new Error(`${this.o.iface} is not running`);
    return this.withRadio(
      (): Promise<TestResult> =>
        testJoin(this.cli, h => (this.joinEvents = h), request, opts).finally(() => (this.joinEvents = null)),
    );
  }

  private readonly cli = (...args: string[]) => this.o.runner.cli(...args);
}

// ── Every card pFMS runs ────────────────────────────────────────────

/** One WifiCard per interface, shared by whichever jobs pick it. */
export class WifiCardPool {
  private readonly cards = new Map<string, WifiCard>();
  private country: string;

  constructor(
    country: string,
    private readonly makeCard: (iface: string, country: string) => WifiCard = (iface, c) =>
      new WifiCard({ iface, country: c, runner: new WpaSupplicantRunner(iface, { country: c }) }),
  ) {
    this.country = country;
  }

  get(iface: string): WifiCard {
    let card = this.cards.get(iface);
    if (!card) {
      card = this.makeCard(iface, this.country);
      this.cards.set(iface, card);
    }
    return card;
  }

  /** The cards some job is using. */
  inUse(): WifiCard[] {
    return [...this.cards.values()].filter(c => c.jobCount > 0);
  }

  setCountry(country: string): void {
    this.country = country;
    for (const card of this.cards.values()) card.setCountry(country);
  }
}
