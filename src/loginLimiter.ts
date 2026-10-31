const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_ADDRESS = 5;
/** Catches guesses spread over many addresses. */
const MAX_ATTEMPTS_OVERALL = 30;

/** Limits typed logins, per client address and overall. */
export class LoginLimiter {
  private attempts = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Count an attempt. Returns how long to wait if it's over the limit, else null. */
  take(address: string): number | null {
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

  /** A login worked: this address starts afresh. */
  clear(address: string): void {
    this.attempts.delete(address);
  }
}
