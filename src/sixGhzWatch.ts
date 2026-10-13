/**
 * 6 GHz watch: listen on 6 GHz for access points using a team's network
 * name other than the field's own — usually a team's backup AP left on. It
 * advertises the same SSID (and passphrase) as the field, so the robot radio
 * joins whichever it finds first, and the field may never see the robot.
 *
 * Robots join the field only on 6 GHz, and the field AP announces team
 * networks only there, so this needs a 6 GHz-capable card. It runs as a job
 * on a card pFMS drives (see wifiCard.ts), which may also run the robot scan;
 * the watch itself only listens — it never joins anything. See
 * plans/competing-ap-6ghz-watch.md and plans/one-card-wifi-jobs.md.
 */
import type { ScanRow } from './robotWifiScan.js';
import type { SixGhzClash, SixGhzNetwork, SixGhzWatchState, StationName } from './types.js';
import { teamOfSsid } from './utils.js';
import { isSixGhz, type WifiCard, type WifiCardJob } from './wifiCard.js';

export { isSixGhz };

// ── Pure helpers ────────────────────────────────────────────────────

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

/** What the field AP is doing on 6 GHz, from its own status. */
export interface FieldRadio {
  channel: number;
  bandwidthMHz: number;
  /** The network names it is serving, and for which station */
  serving: { ssid: string; station: StationName }[];
}

export type HeardBss = Omit<SixGhzNetwork, 'kind'>;

const KIND_ORDER: Record<SixGhzNetwork['kind'], number> = { competing: 0, teamAp: 1, field: 2, other: 3 };

/** What the field AP broadcasts on a station slot with no team: `no-team-1`
 *  … `no-team-6` (VH-109 AP PRACTICE firmware, heard 2026-10-05). */
const FIELD_PLACEHOLDER = /^no-team-\d+$/;

/** The field AP's access points differ only in the last byte — one per
 *  station slot (`4a:da:35:b1:24:00`–`0f` on steamboat's field). */
export const bssidFamily = (bssid: string): string => bssid.toLowerCase().slice(0, 14);

/** The field AP's address families, learned from its `no-team-<n>`
 *  placeholders on the field's channel. */
export function fieldFamiliesHeard(heard: readonly HeardBss[], field: FieldRadio | null): Set<string> {
  const families = new Set<string>();
  if (!field) return families;
  for (const h of heard)
    if (FIELD_PLACEHOLDER.test(h.ssid) && inFieldChannel(h.frequency, field)) families.add(bssidFamily(h.bssid));
  return families;
}

/** Sort out what was heard. Names match exactly — a robot radio only joins
 *  the exact SSID, capitals included.
 *  - The field AP is known by its address family, learned from its
 *    `no-team-<n>` placeholders (`knownFieldFamilies` carries what was
 *    learned before, for when every slot has a team).
 *  - A name the field serves, from any access point that isn't the field, is
 *    competing. Before the field's addresses are known: off the field's
 *    channel is competing; on it, the strongest is taken to be the field and
 *    any more compete (the field has one per name).
 *  - A team's saved robot name the field isn't serving: a team AP.
 *  Without the field's status nothing counts as a clash: a name the field
 *  is serving would look like a team AP. */
export function classifySixGhz(
  heard: HeardBss[],
  field: FieldRadio | null,
  savedSsids: readonly string[],
  knownFieldFamilies: ReadonlySet<string> = new Set(),
): { networks: SixGhzNetwork[]; clashes: SixGhzClash[] } {
  const kinds = new Map<string, SixGhzNetwork['kind']>(); // by bssid
  const clashes: SixGhzClash[] = [];
  const byName = new Map<string, HeardBss[]>();
  for (const h of heard) if (h.ssid) byName.set(h.ssid, [...(byName.get(h.ssid) ?? []), h]);

  if (field) {
    const saved = new Set(savedSsids);
    const families = new Set([...knownFieldFamilies, ...fieldFamiliesHeard(heard, field)]);
    const isField = (h: HeardBss) => inFieldChannel(h.frequency, field) && families.has(bssidFamily(h.bssid));
    for (const h of heard) if (isField(h)) kinds.set(h.bssid, 'field');
    for (const [ssid, all] of byName) {
      const strongest = [...all].sort((a, b) => b.signal - a.signal);
      const served = field.serving.find(s => s.ssid === ssid);
      let others: HeardBss[];
      if (served) {
        if (families.size) {
          others = strongest.filter(h => !isField(h));
        } else {
          const fieldAp = strongest.find(h => inFieldChannel(h.frequency, field));
          if (fieldAp) kinds.set(fieldAp.bssid, 'field');
          others = strongest.filter(h => h !== fieldAp);
        }
      } else if (saved.has(ssid)) {
        // The field itself, a moment ahead of its status (a station just set up)
        others = strongest.filter(h => !isField(h));
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
  /** The card it listens on, maybe shared with the robot scan */
  card: WifiCard;
  /** The field AP's channel and the names it serves; null if unknown */
  field: () => FieldRadio | null;
  /** SSIDs of the robots teams have saved */
  savedSsids: () => string[];
  onChange: (state: SixGhzWatchState) => void;
  now?: () => number;
  /** An access point not heard for this long drops off the list. */
  expireMs?: number;
}

/** Everything else heard is shown on the admin page; keep that list short. */
const MAX_OTHERS = 40;

export class SixGhzWatch {
  private readonly o: Required<Omit<SixGhzWatchOptions, 'now'>> & { now: () => number };
  private attached = false;
  private lastScanAt: number | undefined;
  private seen = new Map<string, HeardBss>(); // by bssid
  /** The field AP's address families, kept once learned: when every station
   *  slot has a team there are no placeholders left to learn them from. */
  private fieldFamilies = new Set<string>();
  /** What it is to the card: wants 6 GHz, reads every scan. */
  private readonly job: WifiCardJob = {
    bands: () => ['6'],
    onScan: rows => this.ingest(rows),
    onCardChange: () => this.emit(),
  };

  get iface(): string {
    return this.o.card.iface;
  }

  constructor(options: SixGhzWatchOptions) {
    this.o = {
      now: Date.now,
      expireMs: 120_000,
      ...options,
    };
  }

  /** Start listening; resolves once the card is up (or failed). */
  async start(): Promise<void> {
    this.attached = true;
    await this.o.card.attach(this.job);
  }

  stop(): void {
    this.attached = false;
    this.o.card.detach(this.job);
    this.seen.clear();
    this.emit();
  }

  private get status(): SixGhzWatchState['status'] {
    return this.attached ? this.o.card.status : 'off';
  }

  private emit() {
    this.o.onChange(this.getState());
  }

  /** One scan on the card (it scans by itself; tests drive it by hand). */
  scanOnce(): Promise<void> {
    return this.o.card.scanOnce();
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
    for (const family of fieldFamiliesHeard([...this.seen.values()], this.o.field()))
      if (!this.fieldFamilies.has(family)) {
        this.fieldFamilies.add(family);
        console.log(`6 GHz watch: the field AP's access points are ${family}:xx`);
      }
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
    return classifySixGhz([...this.seen.values()], this.o.field(), this.o.savedSsids(), this.fieldFamilies);
  }

  getState(): SixGhzWatchState {
    const field = this.o.field();
    const { networks, clashes } = this.classify();
    const others = networks.filter(n => n.kind === 'other').slice(0, MAX_OTHERS);
    const { card } = this.o;
    const channels = card.freqsIn('6').length;
    const problem =
      this.status === 'running' && card.bands() && !channels
        ? `${card.iface} offers no 6 GHz channels — the card may not do 6 GHz, or country ${card.country} doesn't allow it`
        : undefined;
    const error = this.status === 'error' ? card.error : undefined;
    return {
      type: 'sixGhzWatch',
      status: this.status,
      iface: card.iface,
      ...(error && { error }),
      ...(problem && { problem }),
      country: card.country,
      channels,
      ...(this.lastScanAt !== undefined && { lastScanAt: this.lastScanAt }),
      ...(field && { field: { channel: field.channel, bandwidthMHz: field.bandwidthMHz } }),
      networks: [...networks.filter(n => n.kind !== 'other'), ...others],
      clashes,
    };
  }
}
