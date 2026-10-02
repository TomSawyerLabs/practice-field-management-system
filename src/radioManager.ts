import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { configureNetwork, setInternetAccess } from './networkManager.js';
import { appError } from './appLogger.js';
import { teamOfSsid } from './utils.js';
import {
  AdditionalChannelStatistic,
  AllChannels,
  ChannelScanDetails,
  defaultRadioToSlot,
  defaultSlotToRadio,
  isReadyScanResults,
  isValidRawRadioUpdate,
  RadioStationName,
  RadioStationNameList,
  RadioUpdate,
  ReadyScanResults,
  ScanResults,
  StationName,
  StationNameList,
  Status,
  StatusEntry,
  translateRadioUpdate,
  StagedStationChange,
  PendingCommitState,
  RadioHoldReason,
  PendingChange,
  PendingChangeView,
  PendingReleaseReason,
  ConfigureResult,
  isPendingChange,
} from './types.js';
import { randomUUID } from 'node:crypto';

type StatusListener = (entry: StatusEntry) => void;

type StationConfig = { ssid: string; wpaKey: string; internetAccess?: boolean; connectedAt?: number };

function newChangeId(): string {
  return randomUUID().slice(0, 8);
}

function describeChange(c: PendingChange): string {
  if (c.kind === 'enable') return `enable ${c.ssid} (${c.station})`;
  return `release ${c.ssid}${c.reason === 'postMatch' ? ' (match over)' : ''}`;
}

/** Same robot, key and internet flag — what the radio would see as no change. */
function sameConfig(a: StationConfig | undefined, b: StationConfig | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.ssid === b.ssid && a.wpaKey === b.wpaKey && !!a.internetAccess === !!b.internetAccess;
}

// How long to wait for the radio to leave CONFIGURING after a POST. The
// practice firmware (VH-109_AP_PRACTICE_1.2.9) has been seen to take more
// than 45 s under a six-station change (2026-09-27); giving up early does not
// stop the radio, it just lets the sync check push again on top of it.
const ReconfigurationTimeout = 90; // seconds

class RadioManager {
  private updateInterval: NodeJS.Timeout | null = null;
  private connected: boolean = false;
  private configuring = false;
  private commitQueue: Promise<void> = Promise.resolve();
  private scanning: null | Promise<ReadyScanResults> = null;
  private readonly pollInterval = 100;
  private readonly timeout = this.pollInterval * 3;
  private readonly historyDuration = Number(process.env.RADIO_HISTORY_DURATION_MS) || 60000; // 60 seconds default
  private entries: StatusEntry[] = [];
  private updateListeners: StatusListener[] = [];
  private configChangeListeners: (() => void)[] = [];
  private commitCompleteListeners: (() => void)[] = [];
  /** Active station configs. `connectedAt` is pFMS bookkeeping, not part of
   *  the radio's config — see buildRadioStationConfig, which strips it. */
  private activeConfig = {} as Record<
    StationName,
    { ssid: string; wpaKey: string; internetAccess?: boolean; connectedAt?: number }
  >;
  private readonly activeConfigPath = process.env.ACTIVE_CONFIG_FILE ?? 'active-config.json';
  /** Changes waiting to reach the radio, in the order they were asked for.
   *  Not keyed by station: a robot is named by its SSID, and an enable's
   *  station is only a preference until the list is applied. Written on every
   *  change; reconciled against activeConfig by applyPendingChanges(). */
  private changes: PendingChange[] = [];
  private readonly stagedConfigPath = process.env.STAGED_CONFIG_FILE ?? 'staged-config.json';
  /** The hold reason clients were last told, so the per-tick retry only
   *  broadcasts when it changes. */
  private lastHoldBroadcast: RadioHoldReason | null = null;
  private lastBroadcastEntry: StatusEntry | null = null;
  private lastBroadcastTime: number = 0;
  private readonly maxBroadcastInterval = 15000;
  private shouldDefer?: () => boolean;
  /** Why team requests are being parked as staged changes instead of applied
   *  (a match exists, or an admin is holding them). Null = apply as they come. */
  private shouldHold?: () => RadioHoldReason | null;
  private _pendingCommit = false;
  /** True when an applied change's commit was deferred because shouldDefer() returned true. */
  private _deferredCommit = false;
  private pendingCommitListeners: ((pending: boolean) => void)[] = [];
  /** Per-station timestamp of last time a robot was linked (isLinked=true). */
  private lastLinked = new Map<StationName, number>();
  /** Previous isLinked state per station — used to detect transitions and avoid chatty broadcasts. */
  private wasLinked = new Map<StationName, boolean>();
  private lastLinkedListeners: ((timestamps: Partial<Record<StationName, number>>) => void)[] = [];

  constructor(
    private readonly apiBaseUrl: string,
    private readonly radioManagementInterface?: string,
    private firmwareMode?: string,
  ) {
    this.loadActiveConfig();
    this.loadStagedConfig();
    this.startPolling();
    if (this.radioManagementInterface) {
      console.log('Radio management interface:', this.radioManagementInterface);
    }
  }

  setFirmwareMode(mode: string): void {
    this.firmwareMode = mode;
    console.log(`Firmware mode updated: ${mode}`);
  }

  private saveStagedConfig(): void {
    try {
      // Only write while something waits; delete the file when nothing does
      if (this.changes.length > 0) {
        writeFileSync(this.stagedConfigPath, JSON.stringify({ changes: this.changes }, null, 2));
      } else if (existsSync(this.stagedConfigPath)) {
        rmSync(this.stagedConfigPath);
      }
    } catch (err) {
      console.error('Failed to persist pending Wi-Fi changes:', err);
    }
  }

  /** Runs after loadActiveConfig(): the old per-station file's releases
   *  become releases of whichever robot is active on that station. */
  private loadStagedConfig(): void {
    if (!existsSync(this.stagedConfigPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stagedConfigPath, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.changes)) {
        this.changes = raw.changes.filter(isPendingChange);
      } else if (raw && typeof raw === 'object') {
        // Pre-list format: one entry per station (slot or radio name),
        // null = release that station, object = put this config there.
        const validStations = new Set<string>(StationNameList);
        const radioNames = new Set<string>(RadioStationNameList);
        for (const [key, config] of Object.entries(raw)) {
          const station = validStations.has(key)
            ? (key as StationName)
            : radioNames.has(key)
              ? defaultRadioToSlot[key as RadioStationName]
              : undefined;
          if (!station) continue;
          if (config === null) {
            const ssid = this.activeConfig[station]?.ssid;
            if (ssid) this.changes.push({ id: newChangeId(), kind: 'release', ssid, reason: 'team' });
          } else if (config && typeof config === 'object' && typeof (config as any).ssid === 'string') {
            const { ssid, wpaKey, internetAccess } = config as {
              ssid: string;
              wpaKey?: unknown;
              internetAccess?: unknown;
            };
            this.changes.push({
              id: newChangeId(),
              kind: 'enable',
              ssid,
              wpaKey: typeof wpaKey === 'string' ? wpaKey : '',
              internetAccess: typeof internetAccess === 'boolean' ? internetAccess : undefined,
              station,
            });
          }
        }
        if (this.changes.length) {
          console.log('Migrated pending Wi-Fi changes from the per-station format');
          this.saveStagedConfig();
        }
      }
      if (this.changes.length) {
        console.log(
          `Restored ${this.changes.length} pending Wi-Fi change(s): ${this.changes.map(describeChange).join(', ')}`,
        );
        this.setPendingCommit(true);
      }
    } catch (err) {
      console.error('Failed to restore pending Wi-Fi changes:', err);
    }
  }

  /** Put a config on a station, stamping when the team took the slot. A team
   *  that is already there keeps its original timestamp — re-applying the same
   *  SSID (an internet-access toggle, a reconcile, a re-commit) must not look
   *  like a fresh connection, or the admin console's default ordering would
   *  shuffle for no reason. */
  private setActiveStationConfig(
    station: StationName,
    config: { ssid: string; wpaKey: string; internetAccess?: boolean },
  ): void {
    const existing = this.activeConfig[station];
    const connectedAt = existing?.ssid === config.ssid ? (existing.connectedAt ?? Date.now()) : Date.now();
    this.activeConfig[station] = { ...config, connectedAt };
  }

  /** Epoch ms when the station's current team took the slot (null if empty). */
  getConnectedAtForStation(station: StationName): number | null {
    return this.activeConfig[station]?.connectedAt ?? null;
  }

  private saveActiveConfig(): void {
    try {
      writeFileSync(this.activeConfigPath, JSON.stringify(this.activeConfig, null, 2));
    } catch (err) {
      console.error('Failed to persist active config:', err);
    }
  }

  private loadActiveConfig(): void {
    if (!existsSync(this.activeConfigPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.activeConfigPath, 'utf8'));
      const validStations = new Set<string>(StationNameList);
      const radioNames = new Set<string>(RadioStationNameList);
      let migrated = false;
      for (const [key, config] of Object.entries(raw)) {
        // Migrate old radio-keyed configs (red1-blue3) to slot names (slot1-slot6)
        let station = key;
        if (!validStations.has(station) && radioNames.has(station)) {
          station = defaultRadioToSlot[key as RadioStationName];
          migrated = true;
        }
        if (!validStations.has(station)) continue;
        if (
          config &&
          typeof config === 'object' &&
          typeof (config as any).ssid === 'string' &&
          typeof (config as any).wpaKey === 'string'
        ) {
          const { ssid, wpaKey, internetAccess, connectedAt } = config as {
            ssid: string;
            wpaKey: string;
            internetAccess?: boolean;
            connectedAt?: unknown;
          };
          this.activeConfig[station as StationName] = {
            ssid,
            wpaKey,
            internetAccess,
            // Configs written before pFMS tracked this have no timestamp;
            // leave it undefined rather than inventing "connected at restart".
            connectedAt: typeof connectedAt === 'number' ? connectedAt : undefined,
          };
        }
      }
      const stations = Object.keys(this.activeConfig);
      if (stations.length) console.log(`Restored active config for: ${stations.join(', ')}`);
      if (migrated) {
        console.log('Migrated active config from radio station names (red1-blue3) to slot names (slot1-slot6)');
        this.saveActiveConfig();
      }
    } catch (err) {
      console.error('Failed to restore active config:', err);
    }
  }

  private updateBusy: boolean = false;

  /** Number of commits queued or executing on commitQueue — used to skip redundant reconcile commits. */
  private queuedCommits = 0;

  /** When the radio's station config first disagreed with activeConfig (null = in sync). */
  private mismatchSince: number | null = null;
  private readonly reconcileDebounceMs = Number(process.env.RADIO_RECONCILE_DEBOUNCE_MS) || 15000;
  /** Self-repairs pushed since the radio last agreed with activeConfig.
   *  Each one lengthens the wait before the next (see reconcileWaitMs). */
  private reconcileAttempts = 0;
  /** Longest wait between repeated self-repairs. */
  private readonly reconcileMaxWaitMs = Number(process.env.RADIO_RECONCILE_MAX_WAIT_MS) || 10 * 60 * 1000;

  /**
   * How long a mismatch must persist before the next self-repair: the
   * debounce for the first one, then 1, 2, 4, 8… minutes, capped. Re-sending
   * a config the radio has already ignored costs every robot ~40 s of Wi-Fi
   * each time; on 2026-09-27 the radio kept reporting all six stations wrong
   * for ten minutes and pFMS pushed the same config six times, so every
   * screen showed "Reconfiguration in progress" every three minutes.
   */
  private reconcileWaitMs(): number {
    if (this.reconcileAttempts === 0) return this.reconcileDebounceMs;
    return Math.min(this.reconcileMaxWaitMs, 60_000 * 2 ** (this.reconcileAttempts - 1));
  }

  /**
   * Verify the radio's reported station config matches activeConfig, and
   * re-commit if they stay divergent. Runs on every successful status poll.
   * Divergence happens silently: a commit that runs while the radio is
   * unreachable skips the radio push (configureRadio bails when not
   * connected), a radio reboot or factory clear comes back empty, and a
   * syslog-only configuration POST used to wipe every station (2026-07-24
   * incident: kernel network configured for team 8048 but the radio empty).
   * The debounce rides out normal lag around reconfigures; the guards reset
   * it whenever a commit is queued or in flight. Repeats back off (see
   * reconcileWaitMs) until the radio agrees again.
   */
  private checkRadioConfigSync(update: RadioUpdate): void {
    if (update.status !== 'ACTIVE' || this.configuring || this.queuedCommits > 0) {
      this.mismatchSince = null; // status unsettled or a commit will push fresh config
      return;
    }
    const mismatched = StationNameList.filter(
      station => (this.activeConfig[station]?.ssid ?? null) !== (update.stationStatuses[station]?.ssid ?? null),
    );
    if (mismatched.length === 0) {
      if (this.reconcileAttempts > 0) {
        console.log(`Radio station config back in sync with active config after ${this.reconcileAttempts} re-apply(s)`);
      }
      this.mismatchSince = null;
      this.reconcileAttempts = 0;
      return;
    }
    if (this.mismatchSince === null) {
      this.mismatchSince = Date.now();
      return;
    }
    if (Date.now() - this.mismatchSince < this.reconcileWaitMs()) return;
    this.mismatchSince = null;
    this.reconcileAttempts++;
    // Name both sides so the log shows whether the radio is empty, stale, or
    // holding something pFMS never sent — the 2026-09-27 storm only logged
    // slot names, which left the radio's side a guess.
    const detail = mismatched
      .map(station => {
        const active = this.activeConfig[station]?.ssid ?? '(none)';
        const radio = update.stationStatuses[station]?.ssid ?? '(none)';
        return `${station}: pFMS ${active}, radio ${radio}`;
      })
      .join('; ');
    console.log(
      `Radio station config out of sync with active config (${mismatched.join(', ')}) — re-applying` +
        ` (attempt ${this.reconcileAttempts}; next no sooner than ${Math.round(this.reconcileWaitMs() / 1000)}s): ${detail}`,
    );
    this.commitConfiguration().catch(err => {
      appError(
        'Error re-applying configuration after radio config mismatch: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }

  private deepEqual(a: any, b: any): boolean {
    // Use JSON stringification for deep equality comparison
    // This works well for plain data objects without functions/symbols
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private shouldBroadcast(radioUpdate: RadioUpdate | undefined): boolean {
    const timeSinceLastBroadcast = Date.now() - this.lastBroadcastTime;

    // Always broadcast if max interval elapsed (heartbeat)
    if (timeSinceLastBroadcast >= this.maxBroadcastInterval) {
      console.log('Broadcasting: heartbeat interval reached');
      return true;
    }

    // Broadcast if data changed (including undefined transitions)
    if (!this.deepEqual(radioUpdate, this.lastBroadcastEntry?.radioUpdate)) {
      console.log('Broadcasting: radio status changed');
      return true;
    }

    return false;
  }

  private async updateStatus(): Promise<void> {
    if (this.updateBusy) {
      // console.log('Update already in progress');
      return;
    }

    this.updateBusy = true;
    const timestamp = Date.now();

    const submit = (radioUpdate?: RadioUpdate) => {
      const entry: StatusEntry = { timestamp, radioUpdate };

      // Only continue if data changed or max interval elapsed
      if (!this.shouldBroadcast(radioUpdate)) return;

      // Add to history and notify listeners
      this.entries.push(entry);

      // Remove old entries
      while (this.entries[0]?.timestamp < timestamp - this.historyDuration) {
        this.entries.shift();
      }

      // Update cache
      this.lastBroadcastEntry = entry;
      this.lastBroadcastTime = timestamp;

      // Notify listeners (broadcasts to WebSocket clients)
      this.notifyListeners(entry);
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/status`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      this.connected = true;

      const rawUpdate = await response.json();

      if (!isValidRawRadioUpdate(rawUpdate)) {
        appError('Invalid radio status: ' + JSON.stringify(rawUpdate));

        throw new Error('Invalid radio status');
      }

      // Translate radio-native station names (red1-blue3) to internal slot names (slot1-slot6)
      const radioUpdate: RadioUpdate = translateRadioUpdate(rawUpdate);

      // const lastStatus = this.entries[this.entries.length - 1]?.radioStatus.status;
      // if (lastStatus !== radioStatus.status) {
      //   this.lastStatusChangeTime = timestamp;
      // }

      // Track per-station lastLinked timestamps — only broadcast on transitions
      let linkTransition = false;
      for (const station of StationNameList) {
        const linked = radioUpdate.stationStatuses[station]?.isLinked ?? false;
        const prev = this.wasLinked.get(station) ?? false;
        this.wasLinked.set(station, linked);

        if (linked) {
          this.lastLinked.set(station, timestamp);
        }
        if (linked !== prev) {
          linkTransition = true;
        }
      }
      if (linkTransition) this.notifyLastLinkedListeners();

      this.checkRadioConfigSync(radioUpdate);

      submit(radioUpdate);
    } catch (error) {
      if (this.connected) {
        appError('Error fetching radio status: ' + (error instanceof Error ? error.message : String(error)));
        this.connected = false;
        submit();
      }
      throw error;
    } finally {
      this.updateBusy = false;
    }
  }

  private notifyListeners(entry: StatusEntry) {
    this.updateListeners.forEach(listener => {
      try {
        listener(entry);
      } catch (error) {
        console.error('Error in status listener:', error);
      }
    });
  }

  startPolling(interval = this.pollInterval) {
    this.stopPolling();

    this.updateInterval = setInterval(async () => {
      try {
        await this.updateStatus();
      } catch (error) {
        // console.error('Error in polling:', error);
      }
    }, interval);

    console.log(`RadioManager polling started with interval: ${interval}ms`);
  }

  stopPolling() {
    if (!this.updateInterval) return;

    clearInterval(this.updateInterval);
    this.updateInterval = null;

    console.log('RadioManager polling stopped');
  }

  /**
   * A team's (or staff's) request to put a robot on a station — or, with an
   * empty SSID, to release the robot there. The change goes on the pending
   * list (simplified against what is already waiting) and then:
   *
   * - **Waits** while shouldHold() says a match exists or an admin is
   *   holding changes, or while other changes are already waiting. Waiting
   *   changes reach the radio only when staff press "Apply now"
   *   (applyPendingChanges()).
   * - **Otherwise applied** to activeConfig and committed at once. The
   *   commit itself still waits while robots are enabled (see
   *   commitConfiguration / setShouldDefer) and runs as soon as they are all
   *   disabled.
   *
   * Commits are serialized on commitQueue, so a request that arrives while
   * the radio is mid-reconfigure simply queues behind it — never dropped.
   */
  async configure(
    stationId: StationName,
    { ssid, wpaKey, internetAccess }: { ssid: string; wpaKey: string; internetAccess?: boolean },
  ): Promise<ConfigureResult> {
    if (ssid) {
      return this.request({ id: newChangeId(), kind: 'enable', ssid, wpaKey, internetAccess, station: stationId });
    }
    // A release arrives per station (the team page's button is on a robot,
    // the message names its station): it means the robot active there. With
    // nothing active it only withdraws whatever was waiting for that station.
    const active = this.activeConfig[stationId]?.ssid;
    if (active) return this.request({ id: newChangeId(), kind: 'release', ssid: active, reason: 'team' });
    this.cancelStagedChange(stationId);
    return { result: 'noop' };
  }

  /** Why a new change waits instead of applying now: the hold (a match
   *  exists, or the admin switch), or other changes already waiting for
   *  staff — a new one joins that batch rather than reconfiguring the radio
   *  on its own. */
  private waitReason(exceptId?: string): RadioHoldReason | null {
    const hold = this.shouldHold?.() ?? null;
    if (hold) return hold;
    if (this.batching > 0) return 'pending';
    return this.changes.some(c => c.id !== exceptId) ? 'pending' : null;
  }

  /** > 0 while batch() is collecting requests. */
  private batching = 0;

  private async request(change: PendingChange): Promise<ConfigureResult> {
    const outcome = this.addChange(change);
    if (outcome !== 'added') {
      this.afterListChange();
      return { result: outcome };
    }
    const wait = this.waitReason(change.id);
    if (wait) {
      console.log(`Holding Wi-Fi change (${wait}): ${describeChange(change)}`);
      this.afterListChange();
      return { result: 'waiting', reason: wait };
    }
    await this.applyPendingChanges();
    return { result: 'applied' };
  }

  /**
   * Put a change on the list, simplified against what is already there and
   * against the active config. Anything earlier about the same robot is
   * overridden by the new change. A robot already on the field as asked is
   * left alone — and a release waiting for it is withdrawn, so removed and
   * added back is a no-op. A robot on the field never changes station: a
   * new key or internet flag is a change in place.
   */
  private addChange(change: PendingChange): 'added' | 'kept' | 'noop' {
    const overridden = this.changes.filter(c => c.ssid === change.ssid);
    this.changes = this.changes.filter(c => c.ssid !== change.ssid);
    const activeAt = this.stationOf(change.ssid);
    let outcome: 'added' | 'kept' | 'noop';
    if (change.kind === 'enable') {
      const active = activeAt ? this.activeConfig[activeAt] : undefined;
      if (active && active.wpaKey === change.wpaKey && !!active.internetAccess === !!change.internetAccess) {
        outcome = overridden.some(c => c.kind === 'release') ? 'kept' : 'noop';
      } else {
        if (activeAt) change = { ...change, station: activeAt };
        this.changes.push(change);
        outcome = 'added';
      }
    } else if (activeAt) {
      this.changes.push(change);
      outcome = 'added';
    } else {
      outcome = 'noop'; // not on the field: at most an enable was waiting, now withdrawn
    }
    if (overridden.length > 0) {
      console.log(
        `${describeChange(change)} overrides ${overridden.map(describeChange).join(', ')}` +
          (outcome === 'added' ? '' : ' — nothing left to do'),
      );
    }
    if (outcome === 'added' || overridden.length > 0) this.saveStagedConfig();
    return outcome;
  }

  /** Which station a robot is active on, if any. */
  private stationOf(ssid: string): StationName | undefined {
    return StationNameList.find(s => this.activeConfig[s]?.ssid === ssid);
  }

  /** Keep the pending flag and clients in step after the list changed. */
  private afterListChange(): void {
    if (this.changes.length > 0 || this._deferredCommit) {
      if (!this._pendingCommit) this.setPendingCommit(true);
      else this.broadcastPendingState();
    } else {
      this.setPendingCommit(false);
    }
  }

  /** Withdraw what is waiting for a station: an enable that would land
   *  there, or the release of the robot active there. */
  cancelStagedChange(stationId: StationName): void {
    const { resolved } = this.computeTarget();
    const active = this.activeConfig[stationId]?.ssid;
    const ids = this.changes
      .filter(c => (c.kind === 'enable' ? (resolved.get(c.id) ?? c.station) === stationId : c.ssid === active))
      .map(c => c.id);
    this.cancelPendingChanges(ids);
  }

  /** Withdraw one waiting change by id (staff, from the pending panel). */
  cancelPendingChange(id: string): boolean {
    return this.cancelPendingChanges([id]) > 0;
  }

  private cancelPendingChanges(ids: string[]): number {
    if (ids.length === 0) return 0;
    const dropped = this.changes.filter(c => ids.includes(c.id));
    if (dropped.length === 0) return 0;
    this.changes = this.changes.filter(c => !ids.includes(c.id));
    console.log(`Withdrew ${dropped.map(describeChange).join(', ')}`);
    this.saveStagedConfig();
    this.afterListChange();
    this.notifyConfigChange();
    return dropped.length;
  }

  /** A robot that is playing on — it joined the next match, or its team
   *  pressed Keep — stays: any release waiting for it is withdrawn. */
  keepRobot(ssid: string): boolean {
    const ids = this.changes.filter(c => c.kind === 'release' && c.ssid === ssid).map(c => c.id);
    return this.cancelPendingChanges(ids) > 0;
  }

  /** The match is over: every robot on the field is queued to leave unless
   *  it asks to stay before staff apply. A robot with a change already
   *  waiting is left to that change. */
  stageReleaseAll(reason: PendingReleaseReason): number {
    let added = 0;
    for (const station of StationNameList) {
      const ssid = this.activeConfig[station]?.ssid;
      if (!ssid || this.changes.some(c => c.ssid === ssid)) continue;
      this.changes.push({ id: newChangeId(), kind: 'release', ssid, reason });
      added++;
    }
    if (added > 0) {
      console.log(`Match over: ${added} robot(s) queued to leave the field unless they play on`);
      this.saveStagedConfig();
      this.afterListChange();
    }
    return added;
  }

  /**
   * The active config with the pending list applied in order — what the
   * field looks like once staff apply. A release removes its robot wherever
   * it is. An enable of a robot not on the field takes its preferred station
   * if that is free in the target, else the first free one; with none free
   * it is unresolved and keeps waiting. `resolved` maps each applied change
   * to the station it touches.
   */
  private computeTarget(changes: PendingChange[] = this.changes): {
    target: Partial<Record<StationName, StationConfig>>;
    resolved: Map<string, StationName>;
    unresolved: Set<string>;
  } {
    const target: Partial<Record<StationName, StationConfig>> = { ...this.activeConfig };
    const resolved = new Map<string, StationName>();
    const unresolved = new Set<string>();
    const where = (ssid: string) => StationNameList.find(s => target[s]?.ssid === ssid);
    for (const change of changes) {
      if (change.kind === 'release') {
        const station = where(change.ssid);
        if (station) {
          delete target[station];
          resolved.set(change.id, station);
        }
        continue;
      }
      const station =
        where(change.ssid) ?? (!target[change.station] ? change.station : StationNameList.find(s => !target[s]));
      if (!station) {
        unresolved.add(change.id);
        continue;
      }
      const previous = target[station];
      target[station] = {
        ssid: change.ssid,
        wpaKey: change.wpaKey,
        internetAccess: change.internetAccess,
        connectedAt: previous?.ssid === change.ssid ? previous.connectedAt : undefined,
      };
      resolved.set(change.id, station);
    }
    return { target, resolved, unresolved };
  }

  /** Whether there are config changes that haven't been committed to the radio yet. */
  get pendingCommit(): boolean {
    return this._pendingCommit;
  }

  private setPendingCommit(value: boolean) {
    if (this._pendingCommit === value) return;
    this._pendingCommit = value;
    this.notifyPendingCommitListeners();
  }

  /**
   * Broadcast pending commit state to all listeners unconditionally.
   * Use this when staged changes have been added/removed but the pending
   * boolean hasn't changed (e.g. staging a second release while already pending).
   */
  private broadcastPendingState() {
    this.notifyPendingCommitListeners();
  }

  private notifyPendingCommitListeners() {
    for (const listener of this.pendingCommitListeners) {
      try {
        listener(this._pendingCommit);
      } catch (err) {
        console.error('Error in pendingCommit listener:', err);
      }
    }
  }

  addPendingCommitListener(listener: (pending: boolean) => void): () => void {
    this.pendingCommitListeners.push(listener);
    return () => this.pendingCommitListeners.splice(this.pendingCommitListeners.indexOf(listener), 1);
  }

  /** Get all per-station lastLinked timestamps. */
  getLastLinkedTimestamps(): Partial<Record<StationName, number>> {
    return Object.fromEntries(this.lastLinked);
  }

  addLastLinkedListener(listener: (timestamps: Partial<Record<StationName, number>>) => void): () => void {
    this.lastLinkedListeners.push(listener);
    return () => this.lastLinkedListeners.splice(this.lastLinkedListeners.indexOf(listener), 1);
  }

  private notifyLastLinkedListeners() {
    const timestamps = this.getLastLinkedTimestamps();
    for (const listener of this.lastLinkedListeners) {
      try {
        listener(timestamps);
      } catch (err) {
        console.error('Error in lastLinked listener:', err);
      }
    }
  }

  /**
   * Set a callback that determines whether radio configuration should be deferred.
   * When the callback returns true, commitConfiguration() queues the commit instead
   * of executing it immediately. Call retryDeferredCommit() when conditions clear.
   */
  setShouldDefer(fn: () => boolean) {
    this.shouldDefer = fn;
  }

  /**
   * Set a callback that says whether (and why) requests should be held back
   * rather than applied: a match exists, or an admin is holding changes.
   * Waiting requests sit on the pending list until staff apply them with
   * applyPendingChanges().
   */
  setShouldHold(fn: () => RadioHoldReason | null) {
    this.shouldHold = fn;
  }

  /**
   * The hold inputs changed (match state, the admin switch). Waiting changes
   * never apply on their own — staff apply them — but the reason clients are
   * shown may have changed. Called on every match tick, so it only
   * broadcasts when the reason did change.
   */
  retryHeldChanges() {
    if (this.changes.length === 0) return;
    if (this.waitReason() === this.lastHoldBroadcast) return;
    this.broadcastPendingState();
  }

  /**
   * If an applied change's commit was deferred, retry it now (if no longer deferred).
   * Call this when the defer condition clears (e.g., match ends, robots disabled).
   *
   * Only retries commits of changes already in activeConfig. Held (staged)
   * changes are not touched — see retryHeldChanges().
   */
  retryDeferredCommit() {
    if (!this._deferredCommit) return;
    if (this.shouldDefer?.()) return; // Still deferred
    console.log('Defer condition cleared, committing queued radio configuration');
    // Clear deferred flag immediately so subsequent calls don't queue duplicates
    // while the commit is in progress (radio config takes ~30s).
    this._deferredCommit = false;
    this.commitConfiguration().catch(err => {
      appError('Error committing deferred configuration: ' + (err instanceof Error ? err.message : String(err)));
    });
  }

  /**
   * Reconcile the pending list against the active config and commit the
   * result to the radio in one change. This is the ONLY path that moves
   * changes into activeConfig: staff pressing "Apply now", or a request
   * with nothing in the way. It ignores the hold, but the commit still
   * waits while robots are enabled. Enables that find no free station stay
   * on the list.
   *
   * `only` narrows it to part of the list (see applyPendingJoins()); the
   * rest keeps waiting.
   */
  applyPendingChanges(only?: (change: PendingChange) => boolean): Promise<void> {
    const selected = only ? this.changes.filter(only) : this.changes;
    const { target, unresolved } = this.computeTarget(selected);
    // Nothing of the narrowed part can go through: leave the radio alone.
    if (only && selected.every(c => unresolved.has(c.id))) return Promise.resolve();
    const mutations: string[] = [];
    for (const station of StationNameList) {
      const before = this.activeConfig[station];
      const after = target[station];
      if (sameConfig(before, after)) continue;
      if (after) {
        this.setActiveStationConfig(station, {
          ssid: after.ssid,
          wpaKey: after.wpaKey,
          internetAccess: after.internetAccess,
        });
        mutations.push(before ? `${station}: ${before.ssid} → ${after.ssid}` : `${station}: + ${after.ssid}`);
      } else {
        mutations.push(`${station}: − ${before!.ssid}`);
        delete this.activeConfig[station];
        this.lastLinked.delete(station);
      }
    }
    const applied = selected.filter(c => !unresolved.has(c.id));
    this.changes = this.changes.filter(c => !applied.includes(c));
    if (applied.length > 0) {
      console.log(
        `Applying ${applied.length} pending Wi-Fi change(s) as ${mutations.length} station change(s)` +
          (mutations.length ? `: ${mutations.join(', ')}` : ' — nothing for the radio to do'),
      );
    }
    if (unresolved.size > 0) console.log(`${unresolved.size} enable(s) still waiting: the field is full`);
    this.saveStagedConfig();
    if (mutations.length > 0) {
      this.saveActiveConfig();
      this.notifyConfigChange();
      this.notifyLastLinkedListeners();
    }
    return this.commitConfiguration();
  }

  /**
   * Apply only the robots waiting to join; releases stay on the list for
   * staff. For when nobody is at the match page to press Apply now (a set-up
   * match was abandoned): a team that asked for Wi-Fi gets it, and no robot
   * leaves the field without staff saying so.
   */
  applyPendingJoins(): Promise<void> {
    return this.applyPendingChanges(c => c.kind === 'enable');
  }

  commitConfiguration(): Promise<void> {
    if (this.shouldDefer?.()) {
      if (!this._deferredCommit) {
        console.log('Radio configuration deferred: robots enabled or match active');
      }
      this._deferredCommit = true;
      // A deferred commit is pending work too — clients show "waiting for
      // robots to be disabled" off this.
      if (!this._pendingCommit) this.setPendingCommit(true);
      else this.broadcastPendingState();
      return Promise.resolve();
    }
    // DO NOT merge held changes here — that is applyPendingChanges()'s job.
    // This method only commits what is already in activeConfig.
    this._deferredCommit = false;
    const hasStagedChanges = this.changes.length > 0;
    if (hasStagedChanges) {
      this.broadcastPendingState(); // still pending due to staged changes
    } else {
      this.setPendingCommit(false);
    }
    // Serialize concurrent calls — each queues after the previous one so
    // previousStations in networkManager is never read mid-update. The
    // leading catch isolates each commit from its predecessors: without it,
    // one rejected commit poisons the queue and every later commit re-rejects
    // with the stale error without ever executing (2026-07-24 incident).
    this.queuedCommits++;
    this.commitQueue = this.commitQueue
      .catch(() => {})
      .then(() => this.doCommitConfiguration())
      .finally(() => {
        this.queuedCommits--;
      });
    return this.commitQueue;
  }

  /** activeConfig translated from internal slot names (slot1-slot6) to radio-native names (red1-blue3). */
  private buildRadioStationConfig(): Record<
    RadioStationName,
    { ssid: string; wpaKey: string; internetAccess?: boolean }
  > {
    const radioConfig = {} as Record<RadioStationName, { ssid: string; wpaKey: string; internetAccess?: boolean }>;
    for (const slot of StationNameList) {
      const config = this.activeConfig[slot];
      if (!config) continue;
      // Pick the radio's fields explicitly — activeConfig also carries pFMS
      // bookkeeping (connectedAt), and the radio applies /configuration as a
      // full replacement, so anything extra goes over the wire verbatim.
      const { ssid, wpaKey, internetAccess } = config;
      radioConfig[defaultSlotToRadio[slot]] = { ssid, wpaKey, internetAccess };
    }
    return radioConfig;
  }

  private async doCommitConfiguration(): Promise<void> {
    const config = { stationConfigurations: this.buildRadioStationConfig() };

    // Log the configuration to be sent for debugging
    const sanitizedConfig = JSON.parse(JSON.stringify(config)).stationConfigurations;
    for (const station in sanitizedConfig) if (sanitizedConfig[station]) sanitizedConfig[station].wpaKey &&= '***';
    console.log('Configuring stations:', sanitizedConfig);

    // Robots changing station in this one update — teams swapping or
    // rotating physical driver stations between matches. Named here so a
    // slow or failed reconfigure can be tied to it: on 2026-09-27 the one
    // update that overran the wait was a two-robot swap, and whether the
    // radio copes with an SSID moving station inside a single POST is not
    // proven either way.
    const onRadio = this.lastBroadcastEntry?.radioUpdate?.stationStatuses;
    if (onRadio) {
      const moves: string[] = [];
      for (const slot of StationNameList) {
        const ssid = this.activeConfig[slot]?.ssid;
        if (!ssid) continue;
        const from = StationNameList.find(s => s !== slot && onRadio[s]?.ssid === ssid);
        if (from) moves.push(`${ssid} ${defaultSlotToRadio[from]}→${defaultSlotToRadio[slot]}`);
      }
      if (moves.length) console.log(`This update moves ${moves.length} robot(s) between stations: ${moves.join(', ')}`);
    }

    const teamsConfig = {} as Record<StationName, number | undefined>;

    for (const station in this.activeConfig) {
      const { ssid } = this.activeConfig[station as StationName] ?? {};
      if (ssid) teamsConfig[station as StationName] = parseInt(ssid.split('-', 2)[0]) || undefined;
    }

    const jobs: Promise<void>[] = [];

    if (this.radioManagementInterface) {
      jobs.push(
        configureNetwork(teamsConfig, this.radioManagementInterface, this.firmwareMode === 'PRACTICE').then(
          async () => {
            // Apply internet access rules after network is configured
            for (const station in this.activeConfig) {
              const s = station as StationName;
              const team = teamsConfig[s];
              const ia = this.activeConfig[s]?.internetAccess;
              if (team && ia !== undefined) {
                await setInternetAccess(s, team, this.radioManagementInterface!, ia);
              }
            }
          },
        ),
      );
    }

    jobs.push(this.configureRadio(config));

    await Promise.all(jobs);
    // Re-check pending state — held changes may still exist even though this
    // commit is done (they are only merged by applyPendingChanges).
    const hasStagedChanges = this.changes.length > 0;
    if (hasStagedChanges || this._deferredCommit) {
      this.broadcastPendingState();
    } else {
      this.setPendingCommit(false);
    }
    this.notifyCommitComplete();
  }

  private async configureRadio(config: any): Promise<void> {
    if (!this.connected) {
      console.log('Radio not connected, skipping configuration');
      return;
    }

    // Patch over a "bug" in the radio that refuses to accept an empty configuration, but will accept a configuration with only the syslog IP address that does what we want
    const PatchBug = true;
    if (
      PatchBug &&
      'stationConfigurations' in config &&
      config.stationConfigurations &&
      Object.keys(config).length === 1 &&
      Object.keys(config.stationConfigurations).length === 0
    ) {
      console.log('No configurations are active, tricking radio to clear all configurations');
      // Direct syslog-only POST (not setSyslogIP, which refuses to wipe stations)
      return this.configureRadio({
        syslogIpAddress: this.entries[this.entries.length - 1]?.radioUpdate?.syslogIpAddress ?? '10.0.100.40',
      });
    }

    if (this.configuring) {
      console.log('Already configuring');
      return;
    }

    let isConfiguring: Promise<void> | undefined;
    try {
      this.configuring = true;

      const body = JSON.stringify(config);

      isConfiguring = this.untilStatusIs('CONFIGURING', 2);

      const response = await fetch(`${this.apiBaseUrl}/configuration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}. ${await response.text()}`);
      }

      await isConfiguring;

      await this.untilStatusIsNot('CONFIGURING', ReconfigurationTimeout);

      if (!this.isStatus('ACTIVE')) {
        throw new Error(`Radio status is not ACTIVE after configuration. Status: ${this.getStatus()}`);
      }

      // What the radio says it has the moment it is ACTIVE again, against
      // what was sent. On 2026-09-27 every station read as mismatched right
      // after ACTIVE, which looked like an empty or stale report; this
      // records it next time instead of leaving it a guess.
      const reported = this.entries[this.entries.length - 1]?.radioUpdate?.stationStatuses;
      const sent = config.stationConfigurations as Partial<Record<RadioStationName, { ssid: string }>> | undefined;
      if (reported && sent) {
        const summary = RadioStationNameList.map(radio => {
          const want = sent[radio]?.ssid ?? '(none)';
          const got = reported[defaultRadioToSlot[radio]]?.ssid ?? '(none)';
          return `${radio}: ${got}${got === want ? '' : ` (sent ${want})`}`;
        }).join(', ');
        console.log(`Radio ACTIVE after configure — reports ${summary}`);
      }
    } catch (err) {
      // Suppress the isConfiguring rejection if we're bailing out before awaiting it
      isConfiguring?.catch(() => {});
      throw err;
    } finally {
      this.configuring = false;
    }
  }

  async toggleInternetAccess(stationId: StationName, enabled: boolean): Promise<void> {
    const config = this.activeConfig[stationId];
    if (!config) {
      console.log(`No active config for ${stationId}, cannot toggle internet`);
      return;
    }

    if (!!config.internetAccess === enabled) return; // No change

    config.internetAccess = enabled;

    if (!this.radioManagementInterface) {
      this.saveActiveConfig();
      return;
    }

    const team = parseInt(config.ssid.split('-', 2)[0]) || undefined;
    if (!team) {
      console.log(`Cannot parse team number from SSID "${config.ssid}"`);
      return;
    }

    await setInternetAccess(stationId, team, this.radioManagementInterface, enabled);
    this.saveActiveConfig();
  }

  getTeamMappings(): Record<number, StationName> {
    const mappings: Record<number, StationName> = {};
    for (const station in this.activeConfig) {
      const { ssid } = this.activeConfig[station as StationName] ?? {};
      if (!ssid) continue;
      const team = parseInt(ssid.split('-', 2)[0]);
      if (team && !(team in mappings)) {
        mappings[team] = station as StationName;
      }
    }
    return mappings;
  }

  async clearAllConfigurations(stage = false): Promise<void> {
    console.log(`Starting to clear all active radio configurations${stage ? ' (staged)' : ''}`);

    if (this.configuring) {
      console.log('Already configuring, skipping clear operation');
      return;
    }

    try {
      // Waiting changes go too: a clear is a reset, not a step in a batch.
      if (this.changes.length > 0) {
        console.log(`Dropping ${this.changes.length} pending Wi-Fi change(s) with the clear`);
        this.changes = [];
        this.saveStagedConfig();
      }
      for (const stationId in this.activeConfig) delete this.activeConfig[stationId as StationName];
      this.saveActiveConfig();
      this.notifyConfigChange();

      if (stage) {
        this.setPendingCommit(true);
      } else {
        await this.commitConfiguration();
      }
      console.log(`Successfully cleared all radio configurations${stage ? ' (staged)' : ''}`);
    } catch (error) {
      console.error(`Error clearing configurations:`, error);
      console.warn('Configuration clear failed, radio state may be inconsistent');
    }
  }

  getStatus(): Status | undefined {
    return this.entries[this.entries.length - 1]?.radioUpdate?.status;
  }

  isStatus(status: Status): boolean {
    return this.getStatus() === status;
  }

  untilStatusIs(status: Status, timeout = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timeout waiting for status to be ${status}. Is ${this.getStatus()}`));
      }, timeout * 1000);

      const poll = async () => {
        while (!settled && !this.isStatus(status)) await delay(100);
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      };
      poll();
    });
  }

  untilStatusIsNot(status: Status, timeout = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timeout waiting for status to not be ${status}. Is ${this.getStatus()}`));
      }, timeout * 1000);

      const poll = async () => {
        while (!settled && this.isStatus(status)) await delay(100);
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      };
      poll();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatusHistory(): StatusEntry[] {
    return [...this.entries]; // Return a copy to prevent external modification
  }

  addStatusListener(listener: StatusListener): () => void {
    this.updateListeners.push(listener);
    return () => this.updateListeners.splice(this.updateListeners.indexOf(listener), 1);
  }

  addConfigChangeListener(listener: () => void): () => void {
    this.configChangeListeners.push(listener);
    return () => this.configChangeListeners.splice(this.configChangeListeners.indexOf(listener), 1);
  }

  /** Register a listener called after doCommitConfiguration completes (network interfaces are up). */
  addCommitCompleteListener(listener: () => void): () => void {
    this.commitCompleteListeners.push(listener);
    return () => this.commitCompleteListeners.splice(this.commitCompleteListeners.indexOf(listener), 1);
  }

  private notifyConfigChange() {
    for (const listener of this.configChangeListeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in config change listener:', err);
      }
    }
  }

  private notifyCommitComplete() {
    for (const listener of this.commitCompleteListeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in commit complete listener:', err);
      }
    }
  }

  getStationForTeam(teamNumber: number): StationName | undefined {
    for (const station in this.activeConfig) {
      const { ssid } = this.activeConfig[station as StationName] ?? {};
      if (ssid && parseInt(ssid.split('-', 2)[0]) === teamNumber) {
        return station as StationName;
      }
    }
    return undefined;
  }

  /** Returns true if the same team number is assigned to more than one station. */
  isTeamDuplicated(teamNumber: number): boolean {
    let count = 0;
    for (const station in this.activeConfig) {
      const { ssid } = this.activeConfig[station as StationName] ?? {};
      if (ssid && parseInt(ssid.split('-', 2)[0]) === teamNumber) {
        if (++count > 1) return true;
      }
    }
    return false;
  }

  /** Get the active config for a station, or null if unconfigured. */
  getStationConfig(station: StationName): { ssid: string; wpaKey: string; internetAccess?: boolean } | null {
    return this.activeConfig[station] ?? null;
  }

  /** What a station will hold once the list is applied, when that differs
   *  from now: a config, null for a release, undefined for no change. */
  getStagedConfig(station: StationName): { ssid: string; wpaKey: string; internetAccess?: boolean } | null | undefined {
    const after = this.computeTarget().target[station];
    if (sameConfig(this.activeConfig[station], after)) return undefined;
    return after ? { ssid: after.ssid, wpaKey: after.wpaKey, internetAccess: after.internetAccess } : null;
  }

  /** The pending list summarised per station for clients — what each
   *  affected station will hold once staff apply, null = it empties. SSID
   *  and internet flag only, never the WPA key. */
  getStagedChanges(): Record<string, StagedStationChange | null> {
    const { target } = this.computeTarget();
    const result: Record<string, StagedStationChange | null> = {};
    for (const station of StationNameList) {
      const after = target[station];
      if (sameConfig(this.activeConfig[station], after)) continue;
      result[station] = after
        ? { ssid: after.ssid, internetAccess: after.internetAccess, secured: after.wpaKey.length > 0 }
        : null;
    }
    return result;
  }

  /** The pending list for clients, in order, with where each change lands. */
  getPendingChanges(): PendingChangeView[] {
    const { resolved } = this.computeTarget();
    return this.changes.map(c =>
      c.kind === 'enable'
        ? {
            id: c.id,
            kind: 'enable',
            ssid: c.ssid,
            station: resolved.get(c.id) ?? null,
            internetAccess: c.internetAccess,
            secured: c.wpaKey.length > 0,
          }
        : { id: c.id, kind: 'release', ssid: c.ssid, station: resolved.get(c.id) ?? null, reason: c.reason },
    );
  }

  /** A commit was deferred (see setShouldDefer) and is still owed. */
  get deferredCommit(): boolean {
    return this._deferredCommit;
  }

  /** Everything clients need to show what is waiting and why. */
  getPendingState(): Omit<PendingCommitState, 'type'> {
    const changes = this.getPendingChanges();
    const stagedChanges = this.getStagedChanges();
    const hold = changes.length > 0 ? (this.waitReason() ?? undefined) : undefined;
    this.lastHoldBroadcast = hold ?? null;
    return {
      pending: this._pendingCommit,
      changes: changes.length > 0 ? changes : undefined,
      stagedChanges: Object.keys(stagedChanges).length > 0 ? stagedChanges : undefined,
      hold,
      deferred: this._deferredCommit || undefined,
      deferredChanges: this._deferredCommit ? this.getDeferredChanges() : undefined,
    };
  }

  /** Stations whose active config the radio does not have yet — what the
   *  deferred commit will change once robots are disabled. Compared against
   *  the last radio status seen; with no radio status, every station counts. */
  private getDeferredChanges(): Record<string, StagedStationChange | null> {
    const onRadio = this.lastBroadcastEntry?.radioUpdate?.stationStatuses;
    const result: Record<string, StagedStationChange | null> = {};
    for (const station of StationNameList) {
      const active = this.activeConfig[station];
      const radioSsid = onRadio?.[station]?.ssid || undefined;
      if ((active?.ssid ?? undefined) === radioSsid) continue;
      result[station] = active
        ? { ssid: active.ssid, internetAccess: active.internetAccess, secured: active.wpaKey.length > 0 }
        : null;
    }
    return result;
  }

  getTeamForStation(station: StationName): number | null {
    return teamOfSsid(this.activeConfig[station]?.ssid);
  }

  /** The team a station is, or is about to be, configured for: a held
   *  request for the station wins over the active config. (A deferred change
   *  is already in the active config.) This is the view the team page uses
   *  to offer a robot its Join button while a match holds Wi-Fi changes, so
   *  the match roster uses it to name the robot that joined. */
  getProjectedTeamForStation(station: StationName): number | null {
    return teamOfSsid(this.computeTarget().target[station]?.ssid);
  }

  /** Where a team's robot is, or will be once the pending list is applied. */
  getProjectedStationForTeam(team: number): StationName | null {
    const { target } = this.computeTarget();
    return StationNameList.find(s => teamOfSsid(target[s]?.ssid) === team) ?? null;
  }

  /** The first station that is free once the pending list is applied. */
  getFreeProjectedStation(): StationName | null {
    const { target } = this.computeTarget();
    return StationNameList.find(s => !target[s]) ?? null;
  }

  /** Run `fn` with every request parked on the pending list, so a set of
   *  requests can be applied afterwards as one radio update. */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.batching++;
    try {
      return await fn();
    } finally {
      this.batching--;
    }
  }

  /** Look up the WPA key for a team number from the active station configurations. */
  getWpaKeyForTeam(team: number): string | null {
    for (const config of Object.values(this.activeConfig)) {
      if (!config?.ssid) continue;
      if (teamOfSsid(config.ssid) === team && config.wpaKey) return config.wpaKey;
    }
    return null;
  }

  async setSyslogIP(ip: string): Promise<void> {
    // The radio applies every /configuration POST as a FULL replacement, so a
    // syslog-only body wipes all station configs (2026-07-24: the startup
    // setSyslogIP call kicked configured teams off the radio on every deploy).
    // Wait briefly for the first status poll, skip when the IP is already set
    // (the normal case — no radio reconfigure at all), and include the active
    // stations when a push is actually needed.
    const deadline = Date.now() + 10_000;
    while (this.entries.length === 0 && Date.now() < deadline) await delay(200);
    const current = this.entries[this.entries.length - 1]?.radioUpdate?.syslogIpAddress;
    if (current === ip) {
      console.log(`Radio syslog IP already ${ip} — skipping configuration push`);
      return;
    }
    const stationConfigurations = this.buildRadioStationConfig();
    const config: { syslogIpAddress: string; stationConfigurations?: typeof stationConfigurations } = {
      syslogIpAddress: ip,
    };
    // Omit stationConfigurations entirely when empty — the radio rejects an
    // empty map, and the bare-syslog form is the sanctioned "clear" shape.
    if (Object.keys(stationConfigurations).length > 0) config.stationConfigurations = stationConfigurations;
    return this.configureRadio(config);
  }

  private static parseShorthand(shorthand: string): string {
    const table = {
      SC: 'Secondary Channel',
      WR: 'Weather Radar',
      DFS: 'DFS Channel',
      HN: 'High Noise',
      RS: 'Low RSSI',
      CL: 'High Channel Load',
      RP: 'Regulatory Power',
      N2G: 'Not selected 2G',
      P80X: 'Primary 80X80',
      NS80X: 'Only for primary 80X80',
      NP80X: 'Only for Secondary 80X80',
      SR: 'Spacial reuse',
      NF: 'Run-time average NF_dBr',
    } as Record<string, string>;
    if (shorthand in table) {
      return shorthand + ': ' + table[shorthand];
    }

    return shorthand;
  }

  private static parseScanResults(response: string): ScanResults {
    const lines = response
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const channels: ChannelScanDetails[] = [];
    const additionalStatistics: AdditionalChannelStatistic[] = [];

    let parsingChannels = false;
    let parsingAdditionalStats = false;

    let progressDots = 0;

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('-')) continue;
      if (line.startsWith('The number of channels scanned for scan report is:')) {
        const match = line.match(/^The number of channels scanned for scan report is:\s*(\d+)$/);
        if (match) {
          const numChannels = parseInt(match[1], 10);
          if (numChannels > 0) {
            console.log(`Number of channels scanned: ${numChannels}`);
          }
        }
        continue;
      }

      if (line === '.') {
        progressDots++;
        continue;
      }

      if (line.startsWith('Channel |')) {
        parsingChannels = true;
        parsingAdditionalStats = false;
        continue;
      }

      if (line.startsWith('Index |')) {
        parsingChannels = false;
        parsingAdditionalStats = true;
        continue;
      }

      if (parsingChannels) {
        // cSpell:ignore avil spect
        const regex =
          /^(?<channelFrequency>\d+)\(\s*(?<channel>\d+)\)\s+(?<bss>\d+)\s+(?<minRssi>\d+)\s+(?<maxRssi>\d+)\s+(?<nf>-\d+)\s+(?<chLoad>\d+)\s+(?<spectLoad>\d+)\s+(?<secChan>\d+)\s+(?<srBss>\d+)\s+(?<srLoad>\d+)\s+(?<chAvil>\d+)\s+(?<chanEff>\d+)\s+(?<nearBss>\d+)\s+(?<medBss>\d+)\s+(?<farBss>\d+)\s+(?<effBss>\d+)\s+(?<grade>\d+)\s+(?<rank>\d+)\s+\((?<unused>[^\)]*)\)\s+(?<radar>\d+)$/;

        const groups = line.match(regex)?.groups;
        if (!groups) continue;

        channels.push({
          channel: parseInt(groups.channel, 10) as AllChannels,
          channelFrequency: parseInt(groups.channelFrequency, 10),
          bss: parseInt(groups.bss, 10),
          minRssi: parseInt(groups.minRssi, 10),
          maxRssi: parseInt(groups.maxRssi, 10),
          nf: parseInt(groups.nf, 10),
          channelLoad: parseInt(groups.chLoad, 10),
          spectralLoad: parseInt(groups.spectLoad, 10),
          secondaryChannel: parseInt(groups.secChan, 10),
          spatialReuseBss: parseInt(groups.srBss, 10),
          spatialReuseLoad: parseInt(groups.srLoad, 10),
          channelAvailability: parseInt(groups.chAvil, 10),
          channelEfficiency: parseInt(groups.chanEff, 10),
          nearBss: parseInt(groups.nearBss, 10),
          mediumBss: parseInt(groups.medBss, 10),
          farBss: parseInt(groups.farBss, 10),
          effectiveBss: parseInt(groups.effBss, 10),
          grade: parseInt(groups.grade, 10),
          rank: parseInt(groups.rank, 10),
          unused: groups.unused.split(' ').map(RadioManager.parseShorthand),
          radar: parseInt(groups.radar, 10),
        });
      }

      if (parsingAdditionalStats) {
        const regex =
          /^(?<index>\d+)\s+(?<channel>\d+)\s+(?<nbss>\d+)\s+(?<ssid>\S.*?)\s+(?<bssid>[^\s]+)\s+(?<rssi>-?\d+)\s+(?<phyMode>\d+)$/;

        const groups = line.match(regex)?.groups;
        if (!groups) continue;

        additionalStatistics.push({
          index: parseInt(groups.index, 10),
          channel: parseInt(groups.channel, 10) as AllChannels,
          nbss: parseInt(groups.nbss, 10),
          ssid: groups.ssid,
          bssid: groups.bssid,
          rssi: parseInt(groups.rssi, 10),
          phyMode: parseInt(groups.phyMode, 10),
        });
      }
    }

    if (!channels.length) {
      return { progressDots };
    }

    return { channels, additionalStatistics };
  }

  async scan(): Promise<ReadyScanResults> {
    return (this.scanning ??= this.doScan().finally(() => (this.scanning = null)));
  }

  private async doScan(): Promise<ReadyScanResults> {
    // Start the scan
    const startResponse = await fetch(`${this.apiBaseUrl}/scan/start`, {
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!startResponse.ok) {
      throw new Error(`Failed to start scan: ${startResponse.statusText}`);
    }

    // Poll for scan results
    while (true) {
      const resultResponse = await fetch(`${this.apiBaseUrl}/scan/result`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!resultResponse.ok) {
        throw new Error(`Failed to fetch scan results: ${resultResponse.statusText}`);
      }

      const responseText = await resultResponse.text();
      const scanResults = RadioManager.parseScanResults(responseText);

      if (isReadyScanResults(scanResults)) {
        return scanResults;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, this.pollInterval));
    }
  }
}

export default RadioManager;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
