import { createHash, randomBytes } from 'node:crypto';

/** How long a request waits for an admin, and an approval for its browser. */
export const REQUEST_TTL_MS = 30 * 60_000;
/** A team counts as "here now" for this long after anyone asks about its login. */
export const HERE_NOW_MS = 3 * 3600_000;

const MAX_PER_TEAM = 5;
const MAX_TOTAL = 50;

export type TeamAccessRequestState = 'pending' | 'approved' | 'denied';

/** "Let this device in": a browser that doesn't know its team's password
 *  asks a field admin, who approves or denies it on /admin. */
export interface TeamAccessRequest {
  id: string;
  team: number;
  /** What the browser called itself ("Chrome on Windows"). */
  deviceName: string;
  address: string;
  /** Who is asking, in the team's words ("Alex, programming lead"). */
  note?: string;
  createdAt: number;
  state: TeamAccessRequestState;
  decidedAt?: number;
}

interface Stored extends TeamAccessRequest {
  /** SHA-256 of the secret only the asking browser holds (a cookie), so only
   *  that browser collects the login an approval grants. */
  secretHash: string;
}

/**
 * Requests to let a device in, and which teams are at the field trying to log
 * in. Kept in memory only: a request outlives neither a restart nor half an
 * hour, and the team just asks again.
 */
export class TeamAccessRequests {
  private requests = new Map<string, Stored>();
  private activity = new Map<number, number>();
  private listeners: (() => void)[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** Someone asked about the team's login (a page, a login, a request). */
  noteActivity(team: number): void {
    this.activity.set(team, this.now());
  }

  /** Teams someone asked about recently, newest first. */
  recentTeams(withinMs = HERE_NOW_MS): number[] {
    const since = this.now() - withinMs;
    return [...this.activity]
      .filter(([, at]) => at >= since)
      .sort((a, b) => b[1] - a[1])
      .map(([team]) => team);
  }

  /**
   * A browser asks to be let in. The same browser asking again (same secret)
   * replaces its earlier request instead of adding another. Returns the
   * secret to keep in the browser, or null when the team has too many open.
   */
  create(
    team: number,
    deviceName: string,
    address: string,
    note: string | undefined,
    previousSecret?: string,
  ): { request: TeamAccessRequest; secret: string } | null {
    this.expire();
    const previous = previousSecret ? this.find(team, previousSecret) : undefined;
    if (previous) this.requests.delete(previous.id);
    const open = [...this.requests.values()].filter(r => r.team === team && r.state === 'pending');
    if (open.length >= MAX_PER_TEAM || this.requests.size >= MAX_TOTAL) {
      if (previous) this.requests.set(previous.id, previous);
      return null;
    }
    const secret = randomBytes(24).toString('hex');
    const request: Stored = {
      id: randomBytes(8).toString('hex'),
      team,
      deviceName: deviceName.trim().slice(0, 60) || 'Browser',
      address,
      note: note?.trim().slice(0, 120) || undefined,
      createdAt: this.now(),
      state: 'pending',
      secretHash: hashSecret(secret),
    };
    this.requests.set(request.id, request);
    this.noteActivity(team);
    this.changed();
    return { request: visible(request), secret };
  }

  /** The request this browser holds, if it is still around. */
  get(team: number, secret: string | undefined): TeamAccessRequest | undefined {
    this.expire();
    const r = secret ? this.find(team, secret) : undefined;
    return r && visible(r);
  }

  /** An admin's answer. Returns the request, or undefined if it's gone or
   *  already answered. */
  decide(id: string, approve: boolean): TeamAccessRequest | undefined {
    this.expire();
    const r = this.requests.get(id);
    if (!r || r.state !== 'pending') return undefined;
    r.state = approve ? 'approved' : 'denied';
    r.decidedAt = this.now();
    this.changed();
    return visible(r);
  }

  /** The asking browser picks up its approval: the request is done. Returns
   *  the approved request once, so it grants exactly one login. */
  collect(team: number, secret: string | undefined): TeamAccessRequest | undefined {
    this.expire();
    const r = secret ? this.find(team, secret) : undefined;
    if (!r || r.state !== 'approved') return undefined;
    this.requests.delete(r.id);
    this.changed();
    return visible(r);
  }

  /** Requests waiting for an admin, oldest first. */
  pending(): TeamAccessRequest[] {
    this.expire();
    return [...this.requests.values()]
      .filter(r => r.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(visible);
  }

  /** Forget a team's requests (its password was reset or removed). */
  clearTeam(team: number): void {
    let any = false;
    for (const [id, r] of this.requests) {
      if (r.team === team) {
        this.requests.delete(id);
        any = true;
      }
    }
    if (any) this.changed();
  }

  private find(team: number, secret: string): Stored | undefined {
    const hash = hashSecret(secret);
    for (const r of this.requests.values()) if (r.team === team && r.secretHash === hash) return r;
    return undefined;
  }

  private expire(): void {
    const cutoff = this.now() - REQUEST_TTL_MS;
    let any = false;
    for (const [id, r] of this.requests) {
      if ((r.decidedAt ?? r.createdAt) < cutoff) {
        this.requests.delete(id);
        any = true;
      }
    }
    for (const [team, at] of this.activity) if (at < this.now() - HERE_NOW_MS) this.activity.delete(team);
    if (any) this.changed();
  }
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function visible({ secretHash: _, ...r }: Stored): TeamAccessRequest {
  return { ...r };
}
