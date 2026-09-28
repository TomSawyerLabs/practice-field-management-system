import type { MatchQueue } from './matchQueue.js';
import type { TeamPrefsStore } from './teamPrefsStore.js';
import type { PushOutcome, PushPayload } from './pushService.js';
import type { PushSubscriptionInput, QueueEntry, QueueState } from './types.js';

export type NudgeKind = 'nextUp' | 'onDeck' | 'noShow';

export interface QueueNudgerDeps {
  queue: MatchQueue;
  prefs: TeamPrefsStore;
  slack?: {
    isConnected(): boolean;
    findTeamMembers(team: number): Promise<{ id: string; name: string }[]>;
    postTo(channelId: string, text: string): Promise<boolean>;
  };
  push?: {
    isAvailable(): boolean;
    send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushOutcome>;
  };
  /** Absolute base URL of the field, for links in Slack messages and pushes. */
  publicUrl: () => string | undefined;
}

/**
 * Tells teams about the queue the way they asked to be told: a Slack DM to
 * members whose display name carries the team number, and a web push to
 * each device the team subscribed. The page banner needs nothing from here.
 *
 * Three moments, each once per team per match: it becomes next up, it goes
 * on deck ("Set up next match" ran), and it is flagged as a no-show.
 */
export class QueueNudger {
  private sent = new Set<string>();
  private lastNextId: string | undefined;
  private stop: (() => void) | null = null;

  constructor(private readonly deps: QueueNudgerDeps) {}

  start(): void {
    if (this.stop) return;
    this.lastNextId = this.nextOf(this.deps.queue.getState())?.id;
    this.stop = this.deps.queue.addListener(state => {
      this.onState(state).catch(err => console.error('Queue nudge failed:', err));
    });
  }

  private nextOf(state: QueueState): QueueEntry | undefined {
    return state.entries.find(e => e.status === 'onDeck') ?? state.entries.find(e => e.status === 'queued');
  }

  private async onState(state: QueueState): Promise<void> {
    const jobs: Promise<void>[] = [];
    const next = this.nextOf(state);
    if (next && next.status === 'queued' && next.id !== this.lastNextId) {
      for (const team of next.red.concat(next.blue)) jobs.push(this.nudge('nextUp', next, team));
    }
    this.lastNextId = next?.id;
    for (const entry of state.entries) {
      if (entry.status !== 'onDeck') continue;
      for (const team of entry.red.concat(entry.blue)) jobs.push(this.nudge('onDeck', entry, team));
      for (const team of state.noShows ?? []) {
        if (entry.red.includes(team) || entry.blue.includes(team)) jobs.push(this.nudge('noShow', entry, team));
      }
    }
    await Promise.all(jobs);
  }

  private message(kind: NudgeKind, entry: QueueEntry, team: number): PushPayload {
    const side = entry.red.includes(team) ? 'Red' : 'Blue';
    const time = entry.scheduledAt
      ? new Date(entry.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null;
    const url = `${this.deps.publicUrl() ?? ''}/${team}`;
    const tag = `queue-${entry.id}-${team}`;
    switch (kind) {
      case 'nextUp':
        return {
          title: `Next up: Match ${entry.number}`,
          body: `Team ${team}, you're next on the ${side} alliance${time ? ` (about ${time})` : ''}. Get your robot ready.`,
          url,
          tag,
        };
      case 'onDeck':
        return {
          title: `On deck: Match ${entry.number}`,
          body: `Team ${team}, get your robot on the field and press Join on your page (${side} alliance).`,
          url,
          tag,
        };
      case 'noShow':
        return {
          title: `Match ${entry.number} is waiting on you`,
          body: `Team ${team}, there's no robot of yours on the field yet — you may be swapped out. Enable Wi-Fi and join now.`,
          url,
          tag,
        };
    }
  }

  private async nudge(kind: NudgeKind, entry: QueueEntry, team: number): Promise<void> {
    const key = `${entry.id}:${kind}:${team}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    const prefs = this.deps.prefs.get(team);
    const payload = this.message(kind, entry, team);
    const jobs: Promise<unknown>[] = [];
    if (prefs.nudge.slack && this.deps.slack?.isConnected()) jobs.push(this.slack(team, payload));
    if (prefs.nudge.push && this.deps.push?.isAvailable()) jobs.push(this.pushAll(team, payload));
    await Promise.all(jobs);
  }

  private async slack(team: number, payload: PushPayload): Promise<void> {
    const slack = this.deps.slack!;
    const members = await slack.findTeamMembers(team);
    if (members.length === 0) {
      console.log(`Queue nudge: no Slack members found for team ${team}`);
      return;
    }
    const text = `*${payload.title}* — ${payload.body}${payload.url ? ` ${payload.url}` : ''}`;
    await Promise.all(members.map(m => slack.postTo(m.id, text)));
  }

  /** Push to every device the team subscribed; forget the ones that are gone. */
  private async pushAll(team: number, payload: PushPayload): Promise<{ sent: number; gone: number }> {
    const push = this.deps.push!;
    let sent = 0;
    let gone = 0;
    for (const device of this.deps.prefs.pushDevices(team)) {
      const outcome = await push.send(device, payload);
      if (outcome === 'ok') sent++;
      else if (outcome === 'gone') {
        gone++;
        this.deps.prefs.removePushDevice(team, device.endpoint);
      }
    }
    return { sent, gone };
  }

  /** "Send test" from the team page: a push to each of the team's devices. */
  async test(team: number): Promise<{ sent: number; gone: number; devices: number }> {
    const devices = this.deps.prefs.pushDevices(team).length;
    if (!this.deps.push?.isAvailable() || devices === 0) return { sent: 0, gone: 0, devices };
    const r = await this.pushAll(team, {
      title: 'pFMS test',
      body: `Team ${team}: this is how you'll hear that you're next up.`,
      url: `${this.deps.publicUrl() ?? ''}/${team}`,
      tag: `test-${team}`,
    });
    return { ...r, devices };
  }
}
