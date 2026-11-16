import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PushDevice } from './teamPrefsStore.js';
import { isPushSubscriptionInput, type PushSubscriptionInput } from './types.js';

const MAX_DEVICES = 20;

/**
 * Devices field admins subscribed on /admin for web push: where a team's
 * "Forgot password" goes, besides the Slack support channel. Persisted in
 * admin-push.json. The endpoints only let this server send to those devices.
 */
export class AdminPushStore {
  private devices: PushDevice[] = [];

  constructor(private readonly filePath = process.env.ADMIN_PUSH_FILE ?? 'admin-push.json') {
    this.load();
  }

  list(): PushDevice[] {
    return this.devices.map(d => ({ ...d, keys: { ...d.keys } }));
  }

  add(subscription: PushSubscriptionInput, label?: string): void {
    this.devices = this.devices.filter(d => d.endpoint !== subscription.endpoint);
    this.devices.push({ endpoint: subscription.endpoint, keys: { ...subscription.keys }, addedAt: Date.now(), label });
    if (this.devices.length > MAX_DEVICES) this.devices = this.devices.slice(-MAX_DEVICES);
    this.persist();
  }

  remove(endpoint: string): void {
    const before = this.devices.length;
    this.devices = this.devices.filter(d => d.endpoint !== endpoint);
    if (this.devices.length !== before) this.persist();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(raw)) return;
      this.devices = (raw.filter(isPushSubscriptionInput) as Partial<PushDevice>[] as PushDevice[]).map(d => ({
        endpoint: d.endpoint,
        keys: { ...d.keys },
        addedAt: typeof d.addedAt === 'number' ? d.addedAt : Date.now(),
        label: typeof d.label === 'string' ? d.label : undefined,
      }));
    } catch (err) {
      console.error(`Failed to load admin push devices from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      const temp = `${this.filePath}.tmp`;
      writeFileSync(temp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
      renameSync(temp, this.filePath);
    } catch (err) {
      console.error(`Failed to save admin push devices to ${this.filePath}:`, (err as Error).message);
    }
  }
}
