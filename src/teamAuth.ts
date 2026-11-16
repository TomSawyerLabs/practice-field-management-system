import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { LoginLimiter } from './loginLimiter.js';

const DEFAULT_FILE = 'team-auth.json';

/** Typed on a page strangers on guest Wi-Fi can reach. */
export const MIN_TEAM_PASSWORD_LENGTH = 8;

/** A device that hasn't been back for this long is forgotten. Every visit
 *  starts the year again. */
export const TEAM_DEVICE_TTL_MS = 365 * 24 * 60 * 60_000;

const MAX_DEVICES_PER_TEAM = 50;

/** lastSeenAt is written to disk at most this often per device, so a page
 *  that reconnects a lot doesn't rewrite the file each time. */
const SEEN_PERSIST_INTERVAL_MS = 60_000;

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

/** A browser logged in as a team, as pages and /admin see it. */
export interface TeamDevice {
  id: string;
  /** What the browser called itself ("Chrome on Windows"), for the list. */
  name: string;
  createdAt: number;
  lastSeenAt: number;
  /** The address this device was last seen at, while its network binding
   *  lasts. Only meaningful when the team's lock is on. */
  address?: string;
  /** When traffic from `address` (or a visit from it) was last seen. */
  addressSeenAt?: number;
}

interface StoredDevice extends TeamDevice {
  /** SHA-256 of the device's token. Tokens are random, so no salt. */
  tokenHash: string;
}

interface StoredTeam {
  passwordHash: string;
  salt: string;
  passwordSetAt: number;
  /** Only this team's logged-in devices may reach its robots. */
  lock: boolean;
  devices: StoredDevice[];
}

interface StoredFile {
  teams: Record<string, StoredTeam>;
}

/** What anyone may know about a team's login: no secrets. */
export interface TeamAuthStatus {
  passwordSet: boolean;
  lock: boolean;
  /** How many devices are logged in. */
  devices: number;
}

export type TeamLogin =
  | { ok: true; token: string; device: TeamDevice }
  | { ok: false; reason: 'noPassword' | 'wrong' | 'busy'; retryAfterMs?: number };

export type TeamAuthChange = { team: number; network: boolean };

/**
 * Optional per-team passwords. A team with none works exactly as it always
 * has. A team that sets one gets:
 *
 * - logged-in devices, each with its own token, remembered for a year from
 *   its last visit (so a laptop that comes back within 12 months is still
 *   logged in);
 * - the team's own settings gated behind a login (see TEAM_GATED in
 *   src/wsAccess.ts); stops are never gated;
 * - optionally, a network lock: only the addresses of its logged-in devices
 *   reach its robots (src/teamLock.ts).
 *
 * Admin resetting a team removes all of it: password, devices and lock.
 */
export class TeamAuth {
  private teams = new Map<number, StoredTeam>();
  private attempts: LoginLimiter;
  private filePath: string;
  private lastPersisted = new Map<string, number>();
  private listeners: ((change: TeamAuthChange) => void)[] = [];

  constructor(
    filePath?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.attempts = new LoginLimiter(now);
    this.filePath = filePath ?? process.env.TEAM_AUTH_FILE ?? DEFAULT_FILE;
    this.load();
  }

  /** Called after any change. `network` is set when the team's allowed
   *  addresses or lock may have changed, so the firewall needs a look. */
  onChange(listener: (change: TeamAuthChange) => void): void {
    this.listeners.push(listener);
  }

  private changed(team: number, network: boolean): void {
    this.persist();
    for (const l of this.listeners) l({ team, network });
  }

  hasPassword(team: number): boolean {
    return this.teams.has(team);
  }

  status(team: number): TeamAuthStatus {
    const t = this.teams.get(team);
    return { passwordSet: !!t, lock: !!t?.lock, devices: t?.devices.length ?? 0 };
  }

  /** Every team with a password. */
  allStatus(): Record<number, TeamAuthStatus> {
    const out: Record<number, TeamAuthStatus> = {};
    for (const team of this.teams.keys()) out[team] = this.status(team);
    return out;
  }

  listDevices(team: number): TeamDevice[] {
    return (this.teams.get(team)?.devices ?? []).map(visible);
  }

  /** Teams whose lock is on. */
  lockedTeams(): number[] {
    return [...this.teams].filter(([, t]) => t.lock).map(([team]) => team);
  }

  isLocked(team: number): boolean {
    return !!this.teams.get(team)?.lock;
  }

  /**
   * Set a team's password. Whoever calls this has already decided the caller
   * may: anyone for a team with none yet, else a device of the team or admin.
   * Changing it signs out every device but `keepDeviceId` (the one that
   * changed it). Returns a token when it logs the caller in: always for a
   * new password, so setting one never locks its own setter out.
   */
  async setPassword(
    team: number,
    password: string,
    { keepDeviceId, deviceName }: { keepDeviceId?: string; deviceName?: string } = {},
  ): Promise<{ token: string; device: TeamDevice } | { kept: TeamDevice } | null> {
    if (password.length < MIN_TEAM_PASSWORD_LENGTH) return null;
    const salt = randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, 32)).toString('hex');

    const existing = this.teams.get(team);
    const kept = existing?.devices.find(d => d.id === keepDeviceId);
    this.teams.set(team, {
      passwordHash: hash,
      salt,
      passwordSetAt: this.now(),
      lock: existing?.lock ?? false,
      devices: kept ? [kept] : [],
    });
    if (kept) {
      this.changed(team, true);
      return { kept: visible(kept) };
    }
    return this.addDevice(team, deviceName ?? 'Browser');
  }

  /**
   * Check a typed password. `address` is the client's, for the rate limit;
   * an attempt counts before the slow hash, so a burst can't all get through.
   */
  async login(team: number, password: string, name: string, address: string): Promise<TeamLogin> {
    const retryAfterMs = this.attempts.take(address);
    if (retryAfterMs !== null) return { ok: false, reason: 'busy', retryAfterMs };
    const t = this.teams.get(team);
    if (!t) return { ok: false, reason: 'noPassword' };

    const expected = Buffer.from(t.passwordHash, 'hex');
    const actual = await scryptAsync(password, t.salt, expected.length);
    if (!timingSafeEqual(actual, expected)) return { ok: false, reason: 'wrong' };
    // The password may have changed while we hashed.
    if (this.teams.get(team) !== t) return { ok: false, reason: 'wrong' };

    this.attempts.clear(address);
    return { ok: true, ...this.addDevice(team, name) };
  }

  /** The device behind a token, or null. A valid token starts its year again. */
  validate(team: number, token: string | undefined): TeamDevice | null {
    if (!token) return null;
    const t = this.teams.get(team);
    if (!t) return null;
    const tokenHash = hashToken(token);
    const device = t.devices.find(d => d.tokenHash === tokenHash);
    if (!device) return null;
    const now = this.now();
    if (now - device.lastSeenAt > TEAM_DEVICE_TTL_MS) {
      this.removeDevice(team, device.id);
      return null;
    }
    device.lastSeenAt = now;
    const key = `${team}/${device.id}`;
    if (now - (this.lastPersisted.get(key) ?? 0) >= SEEN_PERSIST_INTERVAL_MS) {
      this.lastPersisted.set(key, now);
      this.persist();
    }
    return visible(device);
  }

  /** Sign a device out. */
  removeDevice(team: number, deviceId: string): boolean {
    const t = this.teams.get(team);
    if (!t) return false;
    const before = t.devices.length;
    t.devices = t.devices.filter(d => d.id !== deviceId);
    if (t.devices.length === before) return false;
    this.changed(team, true);
    return true;
  }

  /** Admin: forget the team's password, devices and lock. */
  reset(team: number): boolean {
    if (!this.teams.delete(team)) return false;
    this.changed(team, true);
    return true;
  }

  setLock(team: number, lock: boolean): boolean {
    const t = this.teams.get(team);
    if (!t) return false;
    if (t.lock === lock) return true;
    t.lock = lock;
    this.changed(team, true);
    return true;
  }

  /**
   * A device of `team` was just seen at `address`: that is now its address,
   * and nobody else's. An address belongs to one device at a time, so a
   * device of any team that had it loses it. Returns whether anything moved.
   */
  bindAddress(team: number, deviceId: string, address: string): boolean {
    const device = this.teams.get(team)?.devices.find(d => d.id === deviceId);
    if (!device) return false;
    const now = this.now();
    const moved = device.address !== address;
    for (const [otherTeam, t] of this.teams) {
      for (const d of t.devices) {
        if (d === device || d.address !== address) continue;
        d.address = undefined;
        d.addressSeenAt = undefined;
        if (otherTeam !== team) this.changed(otherTeam, true);
      }
    }
    device.address = address;
    device.addressSeenAt = now;
    if (moved) this.changed(team, true);
    return moved;
  }

  /** Addresses that may reach the team's robots while its lock is on. */
  allowedAddresses(team: number): string[] {
    const t = this.teams.get(team);
    if (!t) return [];
    return [...new Set(t.devices.flatMap(d => (d.address ? [d.address] : [])))];
  }

  /** Traffic from these addresses was seen: their bindings live on. */
  sawTraffic(team: number, addresses: Iterable<string>): void {
    const t = this.teams.get(team);
    if (!t) return;
    const seen = new Set(addresses);
    const now = this.now();
    for (const d of t.devices) if (d.address && seen.has(d.address)) d.addressSeenAt = now;
  }

  /**
   * End bindings with no traffic for `idleMs`. Returns the teams that lost
   * one. Written to disk with the next change; a restart that reads an older
   * addressSeenAt only ends a binding sooner.
   */
  expireBindings(idleMs: number): number[] {
    const now = this.now();
    const teams: number[] = [];
    for (const [team, t] of this.teams) {
      let lost = false;
      for (const d of t.devices) {
        if (d.address && now - (d.addressSeenAt ?? 0) > idleMs) {
          d.address = undefined;
          d.addressSeenAt = undefined;
          lost = true;
        }
      }
      if (lost) teams.push(team);
    }
    for (const team of teams) this.changed(team, true);
    return teams;
  }

  /** Forget devices that haven't been back for a year. */
  pruneDevices(): void {
    const now = this.now();
    for (const [team, t] of this.teams) {
      const before = t.devices.length;
      t.devices = t.devices.filter(d => now - d.lastSeenAt <= TEAM_DEVICE_TTL_MS);
      if (t.devices.length !== before) this.changed(team, true);
    }
  }

  private addDevice(team: number, name: string): { token: string; device: TeamDevice } {
    const t = this.teams.get(team)!;
    const token = randomBytes(32).toString('hex');
    const now = this.now();
    const device: StoredDevice = {
      id: randomBytes(8).toString('hex'),
      name: name.trim().slice(0, 60) || 'Browser',
      createdAt: now,
      lastSeenAt: now,
      tokenHash: hashToken(token),
    };
    t.devices.push(device);
    if (t.devices.length > MAX_DEVICES_PER_TEAM) {
      t.devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      t.devices.length = MAX_DEVICES_PER_TEAM;
    }
    this.changed(team, false);
    return { token, device: visible(device) };
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed: StoredFile = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      for (const [team, t] of Object.entries(parsed.teams ?? {})) {
        const n = Number(team);
        if (Number.isInteger(n) && n > 0 && t?.passwordHash && t.salt) {
          this.teams.set(n, { ...t, lock: !!t.lock, devices: t.devices ?? [] });
        }
      }
      console.log(`Loaded team logins from ${this.filePath}`);
    } catch (err) {
      console.warn(`Failed to load team logins from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      const data: StoredFile = { teams: Object.fromEntries(this.teams) };
      // Replaced whole, so a crash mid-write can't leave a team unlocked.
      const temp = `${this.filePath}.tmp`;
      writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(temp, this.filePath);
    } catch (err) {
      console.error(`Failed to save team logins to ${this.filePath}:`, (err as Error).message);
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function visible({ tokenHash: _, ...device }: StoredDevice): TeamDevice {
  return { ...device };
}
