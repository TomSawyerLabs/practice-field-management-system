import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { configureNetwork, setInternetAccess } from './networkManager.js';
import { appError } from './appLogger.js';
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
} from './types.js';

type StatusListener = (entry: StatusEntry) => void;

const ReconfigurationTimeout = 45; // seconds

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
  /** Staged changes — written on stage, merged into activeConfig on commit. */
  private stagedChanges = {} as Record<StationName, { ssid: string; wpaKey: string; internetAccess?: boolean } | null>;
  private readonly stagedConfigPath = process.env.STAGED_CONFIG_FILE ?? 'staged-config.json';
  private lastBroadcastEntry: StatusEntry | null = null;
  private lastBroadcastTime: number = 0;
  private readonly maxBroadcastInterval = 15000;
  private shouldDefer?: () => boolean;
  private _pendingCommit = false;
  /** True when a non-staged (immediate) commit was deferred because shouldDefer() returned true. */
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
      // Only write if there are staged changes; delete the file if empty
      const hasStaged = Object.values(this.stagedChanges).some(v => v !== undefined);
      if (hasStaged) {
        writeFileSync(this.stagedConfigPath, JSON.stringify(this.stagedChanges, null, 2));
      } else if (existsSync(this.stagedConfigPath)) {
        rmSync(this.stagedConfigPath);
      }
    } catch (err) {
      console.error('Failed to persist staged config:', err);
    }
  }

  private loadStagedConfig(): void {
    if (!existsSync(this.stagedConfigPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stagedConfigPath, 'utf8'));
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
        if (config === null) {
          // Staged clear
          this.stagedChanges[station as StationName] = null;
        } else if (config && typeof config === 'object' && typeof (config as any).ssid === 'string') {
          this.stagedChanges[station as StationName] = config as {
            ssid: string;
            wpaKey: string;
            internetAccess?: boolean;
          };
        }
      }
      const stations = Object.keys(this.stagedChanges).filter(s => this.stagedChanges[s as StationName] !== undefined);
      if (stations.length) {
        console.log(`Restored staged changes for: ${stations.join(', ')}`);
        this.setPendingCommit(true);
      }
      if (migrated) {
        console.log('Migrated staged config from radio station names (red1-blue3) to slot names (slot1-slot6)');
        this.saveStagedConfig();
      }
    } catch (err) {
      console.error('Failed to restore staged config:', err);
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

  /**
   * Verify the radio's reported station config matches activeConfig, and
   * re-commit if they stay divergent. Runs on every successful status poll.
   * Divergence happens silently: a commit that runs while the radio is
   * unreachable skips the radio push (configureRadio bails when not
   * connected), a radio reboot or factory clear comes back empty, and a
   * syslog-only configuration POST used to wipe every station (2026-07-24
   * incident: kernel network configured for team 8048 but the radio empty).
   * The debounce rides out normal lag around reconfigures; the guards reset
   * it whenever a commit is queued or in flight.
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
      this.mismatchSince = null;
      return;
    }
    if (this.mismatchSince === null) {
      this.mismatchSince = Date.now();
      return;
    }
    if (Date.now() - this.mismatchSince < this.reconcileDebounceMs) return;
    this.mismatchSince = null;
    console.log(`Radio station config out of sync with active config (${mismatched.join(', ')}) — re-applying`);
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

  async configure(
    stationId: StationName,
    {
      ssid,
      wpaKey,
      stage,
      internetAccess,
    }: { ssid: string; wpaKey: string; stage?: boolean; internetAccess?: boolean },
  ): Promise<void> {
    if (this.configuring) {
      console.log('Already configuring');
      return;
    }

    const config = ssid ? { ssid, wpaKey, internetAccess } : null;

    // Prevent duplicate SSIDs across stations.  If this SSID is already active
    // (or staged) on a *different* station, clear the old one first so we never
    // end up with the same SSID on two radios simultaneously.
    if (ssid) {
      for (const other of StationNameList) {
        if (other === stationId) continue;
        if (this.activeConfig[other]?.ssid === ssid) {
          console.log(`Duplicate SSID "${ssid}": clearing ${other} (was active) before configuring ${stationId}`);
          delete this.activeConfig[other];
          this.lastLinked.delete(other);
        }
        if (this.stagedChanges[other]?.ssid === ssid) {
          console.log(`Duplicate SSID "${ssid}": clearing staged config on ${other} before configuring ${stationId}`);
          delete this.stagedChanges[other];
        }
      }
    }

    if (stage) {
      // Stage: store in stagedChanges, don't touch activeConfig
      // null means "clear this station" when committed
      this.stagedChanges[stationId] = config ?? null;
      this.saveStagedConfig();
      if (!this._pendingCommit) {
        this.setPendingCommit(true); // transition false → true (broadcasts)
      } else {
        this.broadcastPendingState(); // already pending, but staged changes updated
      }
    } else {
      // Immediate: apply to activeConfig and commit
      if (config) this.setActiveStationConfig(stationId, config);
      else {
        delete this.activeConfig[stationId];
        this.lastLinked.delete(stationId);
      }

      // Clear any stale staged change for this station — the direct apply
      // supersedes whatever was staged, so keeping it around would leave
      // the "pending changes" banner stuck.
      if (this.stagedChanges[stationId] !== undefined) {
        delete this.stagedChanges[stationId];
        this.saveStagedConfig();
        const hasStagedChanges = StationNameList.some(s => this.stagedChanges[s] !== undefined);
        if (!hasStagedChanges && !this._deferredCommit) {
          this.setPendingCommit(false);
        }
      }

      this.saveActiveConfig();
      this.notifyConfigChange();
      await this.commitConfiguration();
    }
  }

  /** Cancel a staged change for a station, leaving activeConfig untouched. */
  cancelStagedChange(stationId: StationName): void {
    if (this.stagedChanges[stationId] === undefined) return;
    delete this.stagedChanges[stationId];
    this.saveStagedConfig();
    // If no staged changes remain (and no deferred commit), clear the pending flag
    const hasStagedChanges = StationNameList.some(s => this.stagedChanges[s] !== undefined);
    if (!hasStagedChanges && !this._deferredCommit) {
      this.setPendingCommit(false);
    } else {
      this.broadcastPendingState(); // staged changes updated
    }
    this.notifyConfigChange();
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
   * If a non-staged commit was deferred, retry it now (if no longer deferred).
   * Call this when the defer condition clears (e.g., match ends, robots disabled).
   *
   * Only retries commits that were originally requested as immediate (stage=false)
   * but got deferred because shouldDefer() was true. User-staged changes (stage=true)
   * are never auto-applied — they wait for an explicit "Apply" action.
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
   * Apply user-staged changes and commit the resulting configuration to the radio.
   * This is the ONLY path that merges stagedChanges into activeConfig — call it
   * when the user explicitly clicks "Apply pending changes."
   */
  applyPendingChanges(): Promise<void> {
    this.applyStagedChanges();
    return this.commitConfiguration();
  }

  commitConfiguration(): Promise<void> {
    if (this.shouldDefer?.()) {
      if (!this._deferredCommit) {
        console.log('Radio configuration deferred: robots enabled or match active');
      }
      this._deferredCommit = true;
      this.broadcastPendingState();
      return Promise.resolve();
    }
    // DO NOT merge staged changes here — they require an explicit "Apply" action
    // via applyPendingChanges(). This method only commits what is already in activeConfig.
    this._deferredCommit = false;
    const hasStagedChanges = StationNameList.some(s => this.stagedChanges[s] !== undefined);
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

  /** Merge stagedChanges into activeConfig and clear them. */
  private applyStagedChanges(): void {
    let changed = false;
    for (const station of StationNameList) {
      const staged = this.stagedChanges[station];
      if (staged === undefined) continue; // No staged change for this station
      if (staged === null) {
        // Staged clear
        if (this.activeConfig[station]) {
          delete this.activeConfig[station];
          this.lastLinked.delete(station);
          changed = true;
        }
      } else {
        this.setActiveStationConfig(station, staged);
        changed = true;
      }
      delete this.stagedChanges[station];
    }
    if (changed) {
      this.saveActiveConfig();
      this.saveStagedConfig();
      this.notifyConfigChange();
      this.notifyLastLinkedListeners();
    }
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
    // Re-check pending state — staged changes may still exist even though this
    // commit is done (staged changes are only merged by explicit "Apply" action).
    const hasStagedChanges = StationNameList.some(s => this.stagedChanges[s] !== undefined);
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

  /** Get staged (not yet committed) config for a station. null = staged clear, undefined = no staged change. */
  getStagedConfig(station: StationName): { ssid: string; wpaKey: string; internetAccess?: boolean } | null | undefined {
    return this.stagedChanges[station];
  }

  /** Get all staged changes. */
  /** Staged changes for clients — SSID and internet flag only, never the WPA key. */
  getStagedChanges(): Record<string, StagedStationChange | null> {
    const result: Record<string, StagedStationChange | null> = {};
    for (const station of StationNameList) {
      const staged = this.stagedChanges[station];
      if (staged === undefined) continue;
      result[station] = staged
        ? { ssid: staged.ssid, internetAccess: staged.internetAccess, secured: staged.wpaKey.length > 0 }
        : null;
    }
    return result;
  }

  /** An immediate commit was deferred (see setShouldDefer) and is still owed. */
  get deferredCommit(): boolean {
    return this._deferredCommit;
  }

  getTeamForStation(station: StationName): number | null {
    const { ssid } = this.activeConfig[station] ?? {};
    if (!ssid) return null;
    const num = parseInt(ssid.split('-', 2)[0]);
    return isNaN(num) ? null : num;
  }

  /** Look up the WPA key for a team number from the active station configurations. */
  getWpaKeyForTeam(team: number): string | null {
    for (const config of Object.values(this.activeConfig)) {
      if (!config?.ssid) continue;
      const num = parseInt(config.ssid.split('-', 2)[0]);
      if (num === team && config.wpaKey) return config.wpaKey;
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
