import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { OperatorDevice } from './types.js';

const DEFAULT_FILE = 'operator-auth.json';

/** The code is typed on a socket strangers can reach, so a short PIN won't do. */
export const MIN_CODE_LENGTH = 8;

const MAX_DEVICES = 200;
const PAIRING_TTL_MS = 5 * 60_000;
const MAX_LIVE_PAIRINGS = 20;

const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_ADDRESS = 5;
/** Catches guesses spread over many addresses. Only ever costs a typed code:
 *  remembered devices and stops don't come through here. */
const MAX_ATTEMPTS_OVERALL = 30;

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

interface StoredDevice extends OperatorDevice {
  /** SHA-256 of the device's token. Tokens are random, so this needs no salt. */
  tokenHash: string;
}

interface StoredAuth {
  codeHash?: string;
  salt?: string;
  devices: StoredDevice[];
}

export type OperatorLogin = { ok: true; token: string; device: OperatorDevice } | { ok: false; retryAfterMs?: number };

/**
 * Who may run the field. Operator pages unlock with one shared code, or by
 * pairing a device from one already logged in. Either way the result is a
 * remembered device with its own token, so /admin can list and revoke them, and
 * changing the code signs out the devices that used it but not paired ones.
 * The code is the one switch: with none set there are no logins and no devices,
 * so a field can't quietly unlock when its last device logs out.
 *
 * Nothing here ever gets in the way of a stop: stops are `anyone` in
 * src/wsAccess.ts and never reach this class.
 */
export class OperatorAuth {
  private codeHash: string | null = null;
  private salt: string | null = null;
  private devices = new Map<string, StoredDevice>();
  private pairings = new Map<string, { expiresAt: number; name?: string; pairedBy: string }>();
  private attempts = new Map<string, number[]>();
  private filePath: string;

  constructor(
    filePath?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.filePath = filePath ?? process.env.OPERATOR_AUTH_FILE ?? DEFAULT_FILE;
    this.load();
  }

  /** Whether operator actions need a login. Off until a field sets a code. */
  isRequired(): boolean {
    return this.codeHash !== null;
  }

  listDevices(): OperatorDevice[] {
    return [...this.devices.values()].map(({ tokenHash: _, ...device }) => device);
  }

  hasDevice(id: string): boolean {
    return this.devices.has(id);
  }

  /** Set or change the code. Devices that typed the old one are signed out. */
  async setCode(code: string): Promise<boolean> {
    if (code.length < MIN_CODE_LENGTH) return false;
    const salt = randomBytes(16).toString('hex');
    const hash = await scryptAsync(code, salt, 32);
    this.salt = salt;
    this.codeHash = hash.toString('hex');
    this.signOutCodeDevices();
    this.persist();
    return true;
  }

  /** Turn operator logins off: no code, no devices, no pairings. */
  clearCode(): void {
    this.salt = null;
    this.codeHash = null;
    this.devices.clear();
    this.pairings.clear();
    this.persist();
  }

  private signOutCodeDevices(): void {
    for (const [id, device] of this.devices) if (device.via === 'code') this.devices.delete(id);
  }

  /**
   * Check a typed code. `address` is the client's, for the rate limit. An
   * attempt counts before the slow hash, so a burst can't all get through while
   * the first is still being checked.
   */
  async login(code: string, name: string, address: string): Promise<OperatorLogin> {
    const retryAfterMs = this.takeAttempt(address);
    if (retryAfterMs !== null) return { ok: false, retryAfterMs };
    if (!this.codeHash || !this.salt) return { ok: false };

    const salt = this.salt;
    const expected = Buffer.from(this.codeHash, 'hex');
    const actual = await scryptAsync(code, salt, expected.length);
    if (!timingSafeEqual(actual, expected)) return { ok: false };

    this.attempts.delete(address);
    return { ok: true, ...this.addDevice({ name, via: 'code' }) };
  }

  /** Check a remembered device's token. */
  validateToken(token: string): OperatorDevice | null {
    if (!token) return null;
    const tokenHash = this.hashToken(token);
    for (const device of this.devices.values()) {
      if (device.tokenHash !== tokenHash) continue;
      device.lastSeenAt = this.now();
      this.persist();
      const { tokenHash: _, ...visible } = device;
      return visible;
    }
    return null;
  }

  /** A one-time secret for a new device's QR code. Kept in memory only: a
   *  restart just means showing a fresh code. */
  startPairing(pairedBy: string, name?: string): { secret: string; expiresAt: number } {
    const now = this.now();
    for (const [hash, p] of this.pairings) if (p.expiresAt <= now) this.pairings.delete(hash);
    while (this.pairings.size >= MAX_LIVE_PAIRINGS) this.pairings.delete(this.pairings.keys().next().value!);

    const secret = randomBytes(32).toString('base64url');
    const expiresAt = now + PAIRING_TTL_MS;
    this.pairings.set(this.hashToken(secret), { expiresAt, name, pairedBy });
    return { secret, expiresAt };
  }

  /** Spend a pairing secret. It works once, whatever the outcome. */
  redeemPairing(secret: string, name: string): { token: string; device: OperatorDevice } | null {
    const hash = this.hashToken(secret);
    const pairing = this.pairings.get(hash);
    if (!pairing) return null;
    this.pairings.delete(hash);
    if (pairing.expiresAt <= this.now()) return null;
    return this.addDevice({ name: pairing.name || name, via: 'pairing', pairedBy: pairing.pairedBy });
  }

  revokeDevice(id: string): boolean {
    if (!this.devices.delete(id)) return false;
    this.persist();
    return true;
  }

  revokeAllDevices(): void {
    this.devices.clear();
    this.pairings.clear();
    this.persist();
  }

  private addDevice(fields: Pick<OperatorDevice, 'name' | 'via' | 'pairedBy'>) {
    const token = randomBytes(32).toString('hex');
    const now = this.now();
    const device: OperatorDevice = {
      id: randomBytes(8).toString('hex'),
      ...fields,
      createdAt: now,
      lastSeenAt: now,
    };
    this.devices.set(device.id, { ...device, tokenHash: this.hashToken(token) });

    if (this.devices.size > MAX_DEVICES) {
      const oldest = [...this.devices.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (oldest) this.devices.delete(oldest.id);
    }

    this.persist();
    return { token, device };
  }

  /** Count an attempt. Returns how long to wait if it's over the limit, else null. */
  private takeAttempt(address: string): number | null {
    const now = this.now();
    const recent = (key: string) => (this.attempts.get(key) ?? []).filter(t => t > now - ATTEMPT_WINDOW_MS);
    const mine = recent(address);
    const overall = recent('*');

    const full =
      mine.length >= MAX_ATTEMPTS_PER_ADDRESS ? mine : overall.length >= MAX_ATTEMPTS_OVERALL ? overall : null;
    if (full) return full[0]! + ATTEMPT_WINDOW_MS - now;

    if (this.attempts.size > 1000) this.attempts.clear();
    this.attempts.set(address, [...mine, now]);
    this.attempts.set('*', [...overall, now]);
    return null;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed: StoredAuth = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      this.codeHash = parsed.codeHash ?? null;
      this.salt = parsed.salt ?? null;
      for (const device of parsed.devices ?? []) this.devices.set(device.id, device);
      console.log(`Loaded operator auth from ${this.filePath}`);
    } catch (err) {
      console.warn(`Failed to load operator auth from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      const data: StoredAuth = {
        codeHash: this.codeHash ?? undefined,
        salt: this.salt ?? undefined,
        devices: [...this.devices.values()],
      };
      // Replaced whole, so a crash mid-write can't leave the field unlocked.
      const temp = `${this.filePath}.tmp`;
      writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(temp, this.filePath);
    } catch (err) {
      console.error(`Failed to save operator auth to ${this.filePath}:`, (err as Error).message);
    }
  }
}
