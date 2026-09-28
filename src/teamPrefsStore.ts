import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { NudgeChannels, PushSubscriptionInput } from './types.js';
import { isPushSubscriptionInput } from './types.js';

export type PushDevice = PushSubscriptionInput & { addedAt: number; label?: string };

export type TeamPrefs = { nudge: NudgeChannels; push: PushDevice[] };

const DEFAULT_NUDGE: NudgeChannels = { banner: true, slack: false, push: false };

/**
 * Per-team preferences: how a team wants to be nudged about the match
 * queue (page banner, Slack DM, web push) and the devices it subscribed for
 * push. Persisted in team-prefs.json. Nothing here is secret beyond the
 * push endpoints, which only let this server send to those devices.
 */
export class TeamPrefsStore {
  private teams = new Map<number, TeamPrefs>();

  constructor(private readonly filePath = process.env.TEAM_PREFS_FILE ?? 'team-prefs.json') {
    this.load();
  }

  get(team: number): TeamPrefs {
    const t = this.teams.get(team);
    return t
      ? { nudge: { ...t.nudge }, push: t.push.map(d => ({ ...d, keys: { ...d.keys } })) }
      : { nudge: { ...DEFAULT_NUDGE }, push: [] };
  }

  private edit(team: number): TeamPrefs {
    let t = this.teams.get(team);
    if (!t) {
      t = { nudge: { ...DEFAULT_NUDGE }, push: [] };
      this.teams.set(team, t);
    }
    return t;
  }

  setNudge(team: number, patch: Partial<NudgeChannels>): TeamPrefs {
    const t = this.edit(team);
    if (patch.slack !== undefined) t.nudge.slack = patch.slack;
    if (patch.push !== undefined) t.nudge.push = patch.push;
    // The banner cannot be turned off: it is the page itself.
    t.nudge.banner = true;
    this.persist();
    return this.get(team);
  }

  /** Register (or refresh) a device. Subscribing is also opting in to push. */
  addPushDevice(team: number, subscription: PushSubscriptionInput, label?: string): TeamPrefs {
    const t = this.edit(team);
    t.push = t.push.filter(d => d.endpoint !== subscription.endpoint);
    t.push.push({ endpoint: subscription.endpoint, keys: { ...subscription.keys }, addedAt: Date.now(), label });
    t.nudge.push = true;
    this.persist();
    return this.get(team);
  }

  /** Forget a device (the team unsubscribed, or the push service said it is
   *  gone). With no devices left, push is off. */
  removePushDevice(team: number, endpoint: string): TeamPrefs {
    const t = this.teams.get(team);
    if (!t) return this.get(team);
    t.push = t.push.filter(d => d.endpoint !== endpoint);
    if (t.push.length === 0) t.nudge.push = false;
    this.persist();
    return this.get(team);
  }

  pushDevices(team: number): PushDevice[] {
    return this.get(team).push;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof raw !== 'object' || !raw) return;
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const team = Number(key);
        if (!Number.isInteger(team) || team <= 0 || typeof value !== 'object' || !value) continue;
        const v = value as Partial<TeamPrefs>;
        const nudge = { ...DEFAULT_NUDGE };
        if (v.nudge) {
          if (typeof v.nudge.slack === 'boolean') nudge.slack = v.nudge.slack;
          if (typeof v.nudge.push === 'boolean') nudge.push = v.nudge.push;
        }
        const push = Array.isArray(v.push)
          ? v.push.filter(isPushSubscriptionInput).map(d => ({
              endpoint: d.endpoint,
              keys: { ...d.keys },
              addedAt: typeof (d as PushDevice).addedAt === 'number' ? (d as PushDevice).addedAt : Date.now(),
              label: typeof (d as PushDevice).label === 'string' ? (d as PushDevice).label : undefined,
            }))
          : [];
        this.teams.set(team, { nudge, push });
      }
    } catch (err) {
      console.error('Failed to load team preferences:', err);
    }
  }

  private persist(): void {
    try {
      const out: Record<string, TeamPrefs> = {};
      for (const [team, prefs] of this.teams) out[String(team)] = prefs;
      writeFileSync(this.filePath, JSON.stringify(out, null, 2));
    } catch (err) {
      console.error('Failed to save team preferences:', err);
    }
  }
}
