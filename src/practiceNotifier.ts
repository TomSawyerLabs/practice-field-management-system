/**
 * Sends each team its practice-day link on Slack once the session is over.
 *
 * "Over" is a judgement: the team has recorded something today and has been
 * quiet for a while (no robot heard from, no run ending, no match ending), or
 * the practice day has rolled over. One message per team per day — later
 * recordings that day land on the same live link, so nothing is repeated.
 *
 * Delivery goes to the team's configured Slack contact (a channel or a
 * group DM). With no contact configured nothing is sent to anyone; the
 * support channel gets one heads-up per team per day so staff can add one.
 * The link itself is not posted there: it opens the team's videos.
 */
import type { MatchHistoryStore } from './matchHistoryStore.js';
import { practiceDayEnd, practiceDayLabel, type PracticeStore } from './practiceStore.js';
import type { SlackBridge } from './slackBridge.js';
import type { TeamContactStore } from './teamContactStore.js';

/** Quiet this long after the last sign of the team = session over. */
const QUIET_MS = 20 * 60 * 1000;
const CHECK_MS = 60 * 1000;
/** Don't retry a failed post more often than this. */
const RETRY_MS = 10 * 60 * 1000;

export interface PracticeNotifierDeps {
  practiceStore: PracticeStore;
  historyStore: MatchHistoryStore;
  contacts: TeamContactStore;
  slack: SlackBridge;
  /** Last time any station configured for this team sent telemetry, epoch ms (0 = never). */
  lastSeen: (teamNumber: number) => number;
  /** How many recordings (matches + runs) the day link lists right now. */
  countItems: (teamNumber: number, day: string) => number;
  /** Absolute base URL of the field, when configured. */
  publicUrl: () => string | undefined;
  retentionDays: () => number;
  now?: () => number;
}

export class PracticeNotifier {
  private timer: NodeJS.Timeout | null = null;
  private lastAttempt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: PracticeNotifierDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => void this.check(), CHECK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The practice-day URL for a token, or the path alone when no public URL is set. */
  linkFor(token: string): string {
    const base = this.deps.publicUrl();
    const path = `/practice/${encodeURIComponent(token)}`;
    return base ? `${base}${path}` : path;
  }

  /** Look at every unsent day and post the ones whose session is over. */
  async check(): Promise<void> {
    const now = this.now();
    for (const day of this.deps.practiceStore.getDays()) {
      if (day.slackPostedAt) continue;
      const count = this.deps.countItems(day.teamNumber, day.day);
      if (count === 0) continue;
      const lastActivity = this.lastActivity(day.teamNumber, day.day);
      const over = now >= practiceDayEnd(day.day) || now - lastActivity >= QUIET_MS;
      if (!over) continue;
      const last = this.lastAttempt.get(day.token) ?? 0;
      if (now - last < RETRY_MS) continue;
      this.lastAttempt.set(day.token, now);
      await this.deliver(day.token, day.teamNumber, day.day, count);
    }
  }

  /** Post the link now (used by the check and by tests). */
  async deliver(token: string, teamNumber: number, day: string, count: number): Promise<boolean> {
    const store = this.deps.practiceStore;
    const entry = store.findByToken(token);
    if (!entry) return false;
    if (!this.deps.slack.isConnected()) return false;
    const contact = this.deps.contacts.get(teamNumber);
    if (!contact) {
      if (!entry.noContactNotedAt) {
        const ok = await this.deps.slack.postToChannel(
          `📹 Team ${teamNumber} recorded ${count} video${count === 1 ? '' : 's'} on ${practiceDayLabel(day)}, ` +
            `but has no Slack contact for their practice links. Add one under *Admin → Team Slack contacts* ` +
            `and the link will go out automatically next time.`,
        );
        if (ok) store.markNoContactNoted(token);
      }
      return false;
    }
    let channelId: string | null = null;
    if (contact.kind === 'channel') channelId = contact.channelId ?? null;
    else channelId = await this.deps.slack.openGroupDm((contact.users ?? []).map(u => u.id));
    if (!channelId) {
      console.warn(`Practice link for team ${teamNumber}: no Slack conversation to post into`);
      return false;
    }
    const ok = await this.deps.slack.postTo(channelId, this.message(teamNumber, day, count, token));
    if (ok) {
      store.markSlackPosted(token);
      console.log(`Practice link for team ${teamNumber} (${day}) posted to Slack ${contact.kind} ${channelId}`);
    }
    return ok;
  }

  message(teamNumber: number, day: string, count: number, token: string): string {
    const link = this.linkFor(token);
    const keep = this.deps.retentionDays();
    return (
      `📹 *Team ${teamNumber} — practice videos for ${practiceDayLabel(day)}*\n` +
      `${count} recording${count === 1 ? '' : 's'} (matches and practice runs), each with the balls scored and ` +
      `battery/telemetry alongside: ${link}\n` +
      `Download them one at a time or all at once as a zip. Anything recorded later today shows up on the same link. ` +
      `Videos are kept for ${keep} days.`
    );
  }

  /** Latest sign of the team on this day: telemetry, a run ending, a match ending. */
  private lastActivity(teamNumber: number, day: string): number {
    let last = this.deps.lastSeen(teamNumber);
    for (const run of this.deps.practiceStore.runsFor(teamNumber, day)) last = Math.max(last, run.endedAt);
    for (const m of this.deps.historyStore.getState().matches) {
      if (m.teams.some(t => t.teamNumber === teamNumber)) last = Math.max(last, m.endedAt);
    }
    return last;
  }
}
