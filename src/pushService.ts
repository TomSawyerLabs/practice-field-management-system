import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';
import type { PushSubscriptionInput } from './types.js';

export type PushPayload = { title: string; body: string; url?: string; tag?: string };

export type PushOutcome = 'ok' | 'gone' | 'failed';

/**
 * Web push for the team pages. VAPID keys are generated once and kept in
 * push-keys.json: a browser's subscription is bound to the public key, so
 * regenerating it would orphan every device. The subject is what push
 * services may contact if we misbehave — the field's public https address
 * when it has one, else a placeholder mailto.
 */
export class PushService {
  private keys: { publicKey: string; privateKey: string } | null = null;

  constructor(
    private readonly keysPath = process.env.PUSH_KEYS_FILE ?? 'push-keys.json',
    private readonly subject: () => string | undefined = () => undefined,
  ) {
    this.load();
  }

  isAvailable(): boolean {
    return this.keys !== null;
  }

  get publicKey(): string | null {
    return this.keys?.publicKey ?? null;
  }

  async send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushOutcome> {
    if (!this.keys) return 'failed';
    const subject = this.subject();
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: {
          subject: subject && /^https:\/\//.test(subject) ? subject : 'mailto:pfms@localhost',
          publicKey: this.keys.publicKey,
          privateKey: this.keys.privateKey,
        },
        TTL: 10 * 60,
      });
      return 'ok';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      console.error('Push failed:', err instanceof Error ? err.message : err);
      return 'failed';
    }
  }

  private load(): void {
    try {
      if (existsSync(this.keysPath)) {
        const raw = JSON.parse(readFileSync(this.keysPath, 'utf8'));
        if (typeof raw?.publicKey === 'string' && typeof raw?.privateKey === 'string') {
          this.keys = { publicKey: raw.publicKey, privateKey: raw.privateKey };
          return;
        }
      }
      this.keys = webpush.generateVAPIDKeys();
      writeFileSync(this.keysPath, JSON.stringify(this.keys, null, 2), { mode: 0o600 });
      console.log(`Generated web push (VAPID) keys in ${this.keysPath}`);
    } catch (err) {
      console.error('Web push unavailable — could not load or create VAPID keys:', err);
      this.keys = null;
    }
  }
}
