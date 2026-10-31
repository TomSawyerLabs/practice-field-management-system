import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

const DEFAULT_FILE = 'admin-auth.json';

/** For a new passphrase. One already set keeps working, however short. */
export const MIN_PASSPHRASE_LENGTH = 12;

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** 128 MiB and about 300 ms per check. Stored with each hash, so raising this
 *  upgrades a passphrase the next time it logs in. */
const SCRYPT_COST: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };
const HASH_BYTES = 32;

/** Checks run one at a time, off the event loop. These are what may wait: past
 *  that a try is turned away, so a flood can't pile up memory on the field's
 *  server. Tries from strangers are limited long before this. */
const MAX_CHECKS_WAITING = 8;

function scryptHash(passphrase: string, salt: string, cost: ScryptCost, bytes: number): Promise<Buffer> {
  // maxmem has to clear scrypt's 128 * N * r exactly, and it defaults to 32 MiB.
  const options = { ...cost, maxmem: 256 * cost.N * cost.r };
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, bytes, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

interface StoredAuth {
  /** Hash of the passphrase, in hex. */
  passphraseHash: string;
  /** Random salt used for hashing. */
  salt: string;
  /** How `passphraseHash` was made. Missing means one round of SHA-256 over
   *  passphrase + salt, the original format, replaced at its next login. */
  scrypt?: ScryptCost;
  /** Valid session tokens (hashed). Each login creates one; we keep the last N. */
  tokenHashes: string[];
}

const MAX_TOKENS = 20;

/**
 * Manages admin authentication via a single shared passphrase.
 * Passphrase hash and salt are persisted to a JSON file.
 * Session tokens are generated on successful login and stored as hashes.
 */
export class AdminAuth {
  private passphraseHash: string | null = null;
  private salt: string | null = null;
  private storedCost: ScryptCost | null = null;
  private tokenHashes = new Set<string>();
  private filePath: string;
  /** Anything slow that reads or changes the passphrase takes its turn here. */
  private lastCheck: Promise<unknown> = Promise.resolve();
  private checksWaiting = 0;

  constructor(
    filePath?: string,
    private readonly cost: ScryptCost = SCRYPT_COST,
  ) {
    this.filePath = filePath ?? process.env.ADMIN_AUTH_FILE ?? DEFAULT_FILE;
    this.load();
  }

  /** Whether a passphrase has been configured. */
  isConfigured(): boolean {
    return this.passphraseHash !== null;
  }

  /**
   * Set the admin passphrase. Only works if no passphrase is currently set,
   * or if `force` is true (for changing the passphrase while authenticated).
   */
  setPassphrase(passphrase: string, force = false): Promise<boolean> {
    return this.inTurn(async () => {
      if (this.passphraseHash && !force) return false;
      if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) return false;

      await this.storeHash(passphrase);
      // Invalidate all existing tokens when passphrase changes
      this.tokenHashes.clear();
      this.persist();
      return true;
    });
  }

  /**
   * Validate a passphrase and return a session token on success.
   */
  async login(passphrase: string): Promise<string | null> {
    if (this.checksWaiting >= MAX_CHECKS_WAITING) return null;
    return this.inTurn(async () => {
      if (!(await this.matches(passphrase))) return null;
      await this.upgradeHash(passphrase);

      // Generate a session token
      const token = randomBytes(32).toString('hex');
      const tokenHash = this.hashToken(token);
      this.tokenHashes.add(tokenHash);

      // Prune old tokens if we have too many
      if (this.tokenHashes.size > MAX_TOKENS) {
        const arr = [...this.tokenHashes];
        this.tokenHashes = new Set(arr.slice(arr.length - MAX_TOKENS));
      }

      this.persist();
      return token;
    });
  }

  /**
   * Validate a session token.
   */
  validateToken(token: string): boolean {
    if (!token) return false;
    const tokenHash = this.hashToken(token);
    return this.tokenHashes.has(tokenHash);
  }

  private inTurn<T>(job: () => Promise<T>): Promise<T> {
    this.checksWaiting++;
    const turn = this.lastCheck.then(job).finally(() => this.checksWaiting--);
    this.lastCheck = turn.catch(() => {});
    return turn;
  }

  private async matches(passphrase: string): Promise<boolean> {
    if (!this.passphraseHash || !this.salt) return false;
    const expected = Buffer.from(this.passphraseHash, 'hex');
    try {
      const actual = this.storedCost
        ? await scryptHash(passphrase, this.salt, this.storedCost, expected.length)
        : createHash('sha256')
            .update(passphrase + this.salt)
            .digest();
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch (err) {
      console.error('Could not check the admin passphrase:', (err as Error).message);
      return false;
    }
  }

  private async storeHash(passphrase: string): Promise<void> {
    const salt = randomBytes(16).toString('hex');
    const hash = await scryptHash(passphrase, salt, this.cost, HASH_BYTES);
    this.salt = salt;
    this.passphraseHash = hash.toString('hex');
    this.storedCost = this.cost;
  }

  /** Move a passphrase that just proved itself to the current hash. A failure
   *  only means it stays as it was, so it never gets in the way of the login. */
  private async upgradeHash(passphrase: string): Promise<void> {
    const stored = this.storedCost;
    if (stored && stored.N >= this.cost.N && stored.r >= this.cost.r && stored.p >= this.cost.p) return;
    try {
      await this.storeHash(passphrase);
      console.log('Upgraded the stored admin passphrase hash');
    } catch (err) {
      console.error('Could not upgrade the admin passphrase hash:', (err as Error).message);
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed: StoredAuth = JSON.parse(raw);
      if (parsed.passphraseHash && parsed.salt) {
        this.passphraseHash = parsed.passphraseHash;
        this.salt = parsed.salt;
        this.storedCost = parsed.scrypt ?? null;
        this.tokenHashes = new Set(parsed.tokenHashes ?? []);
        console.log(`Loaded admin auth from ${this.filePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load admin auth from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      const data: StoredAuth = {
        passphraseHash: this.passphraseHash ?? '',
        salt: this.salt ?? '',
        scrypt: this.storedCost ?? undefined,
        tokenHashes: [...this.tokenHashes],
      };
      // Replaced whole: a torn file would read as a field nobody has claimed,
      // which anyone could then claim.
      const temp = `${this.filePath}.tmp`;
      writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(temp, this.filePath);
    } catch (err) {
      console.error(`Failed to save admin auth to ${this.filePath}:`, (err as Error).message);
    }
  }
}
