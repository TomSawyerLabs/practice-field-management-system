import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { ExternalAccessState, ExternalAccessTokenSummary } from './types.js';

const DEFAULT_FILE = 'external-access.json';
const TOKEN_LENGTH = 32; // 32 bytes = 64 hex chars

interface StoredToken {
  /** SHA-256 hash of the token value. */
  tokenHash: string;
  /** Human-readable label (e.g. "Cameron's laptop"). */
  label: string;
  /** When the token was created (epoch ms). */
  createdAt: number;
  /** When the token was last used to authenticate (epoch ms). */
  lastUsedAt?: number;
}

/**
 * Manages external access tokens for granting remote users access to the
 * internal UI. Tokens are stored as SHA-256 hashes with metadata.
 *
 * Flow:
 * - Admin creates a token → gets a shareable URL with the raw token
 * - User visits /admin/auth/<token> → backend validates, sets cookie, redirects
 * - On subsequent requests, Caddy asks /api/auth/check → backend validates cookie
 * - Cookie value is the raw token; backend hashes it and checks the store
 */
export class ExternalAccessStore {
  private tokens = new Map<string, StoredToken>();
  private filePath: string;
  private listeners: ((state: ExternalAccessState) => void)[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.EXTERNAL_ACCESS_FILE ?? DEFAULT_FILE;
    this.load();
  }

  // ── Token Management ─────────────────────────────────────────────────

  /** Create a new external access token. Returns the raw token (shown once). */
  createToken(label: string): { token: string; id: string } {
    const token = randomBytes(TOKEN_LENGTH).toString('hex');
    const tokenHash = this.hashToken(token);
    const id = tokenHash.slice(0, 12);

    this.tokens.set(id, {
      tokenHash,
      label,
      createdAt: Date.now(),
    });

    this.persist();
    this.notifyListeners();
    return { token, id };
  }

  /** Revoke (delete) an external access token by ID. */
  revokeToken(id: string): boolean {
    if (!this.tokens.has(id)) return false;
    this.tokens.delete(id);
    this.persist();
    this.notifyListeners();
    return true;
  }

  // ── Validation ───────────────────────────────────────────────────────

  /**
   * Validate a raw token (from cookie or URL). Returns true if the token
   * matches any stored hash. Updates lastUsedAt on success.
   */
  validateToken(token: string): boolean {
    if (!token) return false;
    const hash = this.hashToken(token);
    for (const [, stored] of this.tokens) {
      if (stored.tokenHash === hash) {
        stored.lastUsedAt = Date.now();
        this.persist();
        return true;
      }
    }
    return false;
  }

  /** validateToken without recording a use, for a check on every message. */
  isValid(token: string): boolean {
    const hash = this.hashToken(token);
    return [...this.tokens.values()].some(stored => stored.tokenHash === hash);
  }

  /** Whether any tokens exist. */
  hasTokens(): boolean {
    return this.tokens.size > 0;
  }

  // ── State & Listeners ────────────────────────────────────────────────

  /** Get the broadcast-safe state (no raw tokens or hashes). */
  getState(): ExternalAccessState {
    const tokens: ExternalAccessTokenSummary[] = [...this.tokens.entries()]
      .map(([id, t]) => ({
        id,
        label: t.label,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      }))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

    return {
      type: 'externalAccessState',
      tokens,
    };
  }

  /** Register a listener for state changes. Returns an unsubscribe function. */
  addListener(fn: (state: ExternalAccessState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error in ExternalAccessStore listener:', err);
      }
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry?.tokenHash === 'string' && typeof entry?.label === 'string') {
            const id = entry.id ?? entry.tokenHash.slice(0, 12);
            this.tokens.set(id, {
              tokenHash: entry.tokenHash,
              label: entry.label,
              createdAt: entry.createdAt ?? Date.now(),
              lastUsedAt: entry.lastUsedAt,
            });
          }
        }
        if (this.tokens.size > 0) {
          console.log(`Loaded ${this.tokens.size} external access token(s) from ${this.filePath}`);
        }
      }
    } catch (err) {
      console.warn(`Failed to load external access tokens from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      const data = [...this.tokens.entries()].map(([id, t]) => ({ id, ...t }));
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save external access tokens to ${this.filePath}:`, (err as Error).message);
    }
  }
}
