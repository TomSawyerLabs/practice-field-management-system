import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { emojify } from 'node-emoji';
import type { SupportIssue, SlackConfigState } from './types.js';

const DEFAULT_CONFIG_FILE = 'slack-config.json';

interface StoredSlackConfig {
  botToken: string;
  appToken: string;
  channelId: string;
  channelName?: string;
}

/**
 * Bridges support system to a Slack channel.
 * Each chat session becomes a single Slack thread.
 * Issues are posted as formatted messages.
 */
export class SlackBridge {
  private web: WebClient | null = null;
  private socketMode: SocketModeClient | null = null;
  private config: StoredSlackConfig | null = null;
  private configFilePath: string;
  private connected = false;
  private lastError: string | undefined;
  private listeners: ((state: SlackConfigState) => void)[] = [];
  /** Cached custom workspace emoji: name → image URL or "alias:target". */
  private customEmoji = new Map<string, string>();
  private emojiRefreshTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Called when a message is received from Slack in a support thread.
   * The handler should forward it to the appropriate WebSocket client.
   */
  onSlackMessage:
    | ((threadTs: string, senderName: string, text: string, files?: { url: string; mimetype: string }[]) => void)
    | null = null;

  constructor(configFilePath?: string) {
    this.configFilePath = configFilePath ?? process.env.SLACK_CONFIG_FILE ?? DEFAULT_CONFIG_FILE;
    this.loadConfig();
    if (this.config) {
      this.connect().catch(err => {
        console.warn('Failed to connect to Slack on startup:', err.message);
      });
    }
  }

  /** Whether Slack is configured (has tokens). */
  isConfigured(): boolean {
    return this.config !== null;
  }

  /** Whether Slack is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  // ── Configuration ───────────────────────────────────────────────────

  async saveConfig(botToken: string, appToken: string, channelId: string): Promise<void> {
    // Validate tokens by making a test API call
    const testClient = new WebClient(botToken);

    let channelName: string | undefined;
    try {
      const info = await testClient.conversations.info({ channel: channelId });
      channelName = (info.channel as { name?: string })?.name;
    } catch (err) {
      throw new Error(`Failed to access channel ${channelId}: ${(err as Error).message}`);
    }

    this.config = { botToken, appToken, channelId, channelName };
    this.persistConfig();

    // Reconnect with new config
    await this.disconnect();
    await this.connect();

    this.notifyListeners();
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; channelName?: string }> {
    if (!this.config) return { ok: false, error: 'Slack not configured' };

    try {
      const client = new WebClient(this.config.botToken);
      const authResult = await client.auth.test();
      if (!authResult.ok) return { ok: false, error: 'Auth test failed' };

      const channelInfo = await client.conversations.info({ channel: this.config.channelId });
      const channelName = (channelInfo.channel as { name?: string })?.name;

      return { ok: true, channelName };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ── Connection ──────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (!this.config) return;

    try {
      this.web = new WebClient(this.config.botToken);

      // Start Socket Mode for receiving messages
      this.socketMode = new SocketModeClient({
        appToken: this.config.appToken,
        // Reconnect automatically
      });

      // Listen for message events in our channel
      this.socketMode.on('message', async ({ event, ack }) => {
        await ack();
        this.handleSlackMessage(event);
      });

      this.socketMode.on('connected', () => {
        console.log('Slack Socket Mode connected');
        this.connected = true;
        this.lastError = undefined;
        this.notifyListeners();
        // Fetch/refresh custom emoji on every (re)connect
        this.fetchCustomEmoji();
      });

      this.socketMode.on('disconnected', () => {
        console.log('Slack Socket Mode disconnected');
        this.connected = false;
        this.notifyListeners();
      });

      await this.socketMode.start();

      // Refresh custom emoji periodically (every 30 minutes)
      this.emojiRefreshTimer = setInterval(() => this.fetchCustomEmoji(), 30 * 60 * 1000);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.connected = false;
      console.error('Failed to connect Slack:', this.lastError);
      this.notifyListeners();
    }
  }

  private async disconnect(): Promise<void> {
    if (this.emojiRefreshTimer) {
      clearInterval(this.emojiRefreshTimer);
      this.emojiRefreshTimer = null;
    }
    if (this.socketMode) {
      try {
        await this.socketMode.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.socketMode = null;
    }
    this.web = null;
    this.connected = false;
  }

  // ── Emoji Resolution ─────────────────────────────────────────────────

  /** Fetch all custom workspace emoji and cache them. */
  private async fetchCustomEmoji(): Promise<void> {
    if (!this.web) return;
    try {
      const result = await this.web.emoji.list();
      const emoji = (result as { emoji?: Record<string, string> }).emoji;
      if (emoji) {
        this.customEmoji.clear();
        for (const [name, value] of Object.entries(emoji)) {
          this.customEmoji.set(name, value);
        }
        console.log(`Cached ${this.customEmoji.size} custom Slack emoji`);
      }
    } catch (err) {
      console.warn('Failed to fetch custom emoji:', (err as Error).message);
    }
  }

  /**
   * Resolve a custom emoji name to its image URL, following alias chains.
   * Returns the image URL, or null if not found.
   */
  private resolveCustomEmoji(name: string): string | null {
    let current = name;
    for (let depth = 0; depth < 5; depth++) {
      const value = this.customEmoji.get(current);
      if (!value) return null;
      if (value.startsWith('alias:')) {
        current = value.slice(6);
        // The alias target might be a standard emoji — try emojify
        const standard = emojify(`:${current}:`);
        if (standard !== `:${current}:`) return null; // It's a standard emoji, emojify already handled it
        continue;
      }
      // It's an image URL
      return value;
    }
    return null;
  }

  /**
   * Convert Slack emoji codes in text to Unicode or image markers.
   * Standard emoji → Unicode via emojify().
   * Custom emoji → `<emoji:URL>` markers for frontend rendering.
   */
  resolveEmoji(text: string): string {
    // First pass: convert standard emoji
    let result = emojify(text);

    // Second pass: resolve remaining :name: patterns (custom emoji)
    result = result.replace(/:([a-zA-Z0-9_+\-]+):/g, (match, name) => {
      const url = this.resolveCustomEmoji(name);
      if (url) return `<emoji:${url}>`;
      return match; // Leave unresolved codes as-is
    });

    return result;
  }

  // ── Posting ─────────────────────────────────────────────────────────

  /**
   * Post a plain mrkdwn message to the configured support channel.
   * Returns false when Slack isn't configured/connected yet or the post fails.
   */
  async postToChannel(text: string): Promise<boolean> {
    if (!this.web || !this.config) return false;
    try {
      await this.web.chat.postMessage({ channel: this.config.channelId, text, unfurl_links: false });
      return true;
    } catch (err) {
      console.warn('Slack postToChannel failed:', (err as Error).message);
      return false;
    }
  }

  /**
   * Post a mrkdwn message to any conversation the bot can write to (a team's
   * channel or a DM opened with openGroupDm). Returns false when Slack isn't
   * connected or the post fails.
   */
  async postTo(channelId: string, text: string): Promise<boolean> {
    if (!this.web || !this.config) return false;
    try {
      await this.web.chat.postMessage({ channel: channelId, text, unfurl_links: false, unfurl_media: false });
      return true;
    } catch (err) {
      console.warn(`Slack postTo ${channelId} failed:`, (err as Error).message);
      return false;
    }
  }

  /**
   * Everyone in the workspace on a team, judged from their Slack names: the
   * pfms-support convention is a team number in the display or real name —
   * "Mark 5940", "Aidan Honnold (5940)", "Stephan Massalt (971/9584)",
   * "Christina Lee (Team 6036)". Any run of 1–5 digits bounded by
   * non-digits in the display name, real name or title counts; the
   * username is ignored (people use their student ID there). The directory
   * is cached for an hour. Needs `users:read`.
   */
  async findTeamMembers(teamNumber: number): Promise<{ id: string; name: string }[]> {
    const directory = await this.userDirectory();
    const out: { id: string; name: string }[] = [];
    for (const u of directory) {
      if (u.teams.has(teamNumber)) out.push({ id: u.id, name: u.name });
    }
    return out;
  }

  private directoryCache: { at: number; users: { id: string; name: string; teams: Set<number> }[] } | null = null;

  private async userDirectory(): Promise<{ id: string; name: string; teams: Set<number> }[]> {
    if (this.directoryCache && Date.now() - this.directoryCache.at < 60 * 60 * 1000) return this.directoryCache.users;
    if (!this.web) return this.directoryCache?.users ?? [];
    const users: { id: string; name: string; teams: Set<number> }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.web.users.list({ limit: 1000, cursor });
      for (const m of page.members ?? []) {
        if (!m.id || m.deleted || m.is_bot || m.id === 'USLACKBOT') continue;
        const p = m.profile ?? {};
        const teams = teamNumbersIn([p.display_name, p.real_name, m.real_name, p.title]);
        if (teams.size === 0) continue;
        users.push({ id: m.id, name: p.real_name ?? m.real_name ?? m.name ?? m.id, teams });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    this.directoryCache = { at: Date.now(), users };
    return users;
  }

  /**
   * Post an issue report to the Slack channel.
   * Returns the thread timestamp for future replies.
   */
  async postIssue(issue: SupportIssue): Promise<string | null> {
    if (!this.web || !this.config) return null;

    try {
      const blocks = [
        {
          type: 'header' as const,
          text: { type: 'plain_text' as const, text: `🐛 Issue Report: ${issue.id}` },
        },
        {
          type: 'section' as const,
          fields: [
            { type: 'mrkdwn' as const, text: `*Trying to do:*\n${issue.tryingToDo || '_Not specified_'}` },
            { type: 'mrkdwn' as const, text: `*What happened:*\n${issue.actual || '_Not specified_'}` },
          ],
        },
        {
          type: 'section' as const,
          fields: [
            { type: 'mrkdwn' as const, text: `*Steps:*\n${issue.stepsPerformed || '_Not specified_'}` },
            { type: 'mrkdwn' as const, text: `*Expected:*\n${issue.expected || '_Not specified_'}` },
          ],
        },
        {
          type: 'context' as const,
          elements: [
            {
              type: 'mrkdwn' as const,
              text: `📍 ${issue.metadata.pageUrl} | 🖥️ ${issue.metadata.screenSize ?? 'unknown'} | 🌐 ${issue.metadata.clientIp ?? 'unknown'}`,
            },
          ],
        },
      ];

      const result = await this.web.chat.postMessage({
        channel: this.config.channelId,
        text: `Issue Report: ${issue.tryingToDo}`,
        blocks,
      });

      const threadTs = result.ts;

      // If there are recent logs, post them as a thread reply
      if (issue.recentLogs.length > 0) {
        const logText = issue.recentLogs.slice(-20).join('\n');
        await this.web.chat.postMessage({
          channel: this.config.channelId,
          thread_ts: threadTs,
          text: `📋 *Recent Logs:*\n\`\`\`${logText}\`\`\``,
        });
      }

      // If there's a screenshot, upload it as a thread reply
      if (issue.screenshotDataUrl && threadTs) {
        await this.uploadScreenshot(issue.screenshotDataUrl, threadTs, 'Issue screenshot');
      }

      return threadTs ?? null;
    } catch (err) {
      console.error('Failed to post issue to Slack:', (err as Error).message);
      return null;
    }
  }

  /**
   * Start a chat thread in Slack for a support chat session.
   * Returns the thread timestamp.
   */
  async startChatThread(sessionId: string, issueId?: string, senderName?: string): Promise<string | null> {
    if (!this.web || !this.config) return null;

    try {
      const who = senderName ?? 'a user';
      const text = issueId ? `💬 Support chat from ${who} (issue ${issueId})` : `💬 Support chat from ${who}`;

      const result = await this.web.chat.postMessage({
        channel: this.config.channelId,
        text,
      });

      return result.ts ?? null;
    } catch (err) {
      console.error('Failed to start Slack chat thread:', (err as Error).message);
      return null;
    }
  }

  /**
   * Post a user's chat message as a reply in the Slack thread.
   */
  async postChatMessage(threadTs: string, senderName: string, text: string, screenshotDataUrl?: string): Promise<void> {
    if (!this.web || !this.config) return;

    try {
      await this.web.chat.postMessage({
        channel: this.config.channelId,
        thread_ts: threadTs,
        text: `*${senderName}:* ${text}`,
      });

      if (screenshotDataUrl) {
        await this.uploadScreenshot(screenshotDataUrl, threadTs, `Screenshot from ${senderName}`);
      }
    } catch (err) {
      console.error('Failed to post chat message to Slack:', (err as Error).message);
    }
  }

  /**
   * Post a notification that a chat session has ended.
   */
  async postChatEnded(threadTs: string): Promise<void> {
    if (!this.web || !this.config) return;

    try {
      await this.web.chat.postMessage({
        channel: this.config.channelId,
        thread_ts: threadTs,
        text: '🔚 Support chat session ended.',
      });
    } catch (err) {
      console.error('Failed to post chat-ended to Slack:', (err as Error).message);
    }
  }

  // ── Receiving ───────────────────────────────────────────────────────

  private handleSlackMessage(event: {
    type?: string;
    subtype?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    files?: { url_private?: string; mimetype?: string }[];
  }): void {
    // Only handle messages in our channel that are threaded replies
    if (!this.config) return;
    if (event.channel !== this.config.channelId) return;
    if (!event.thread_ts) return; // Only threaded replies
    if (event.bot_id) return; // Ignore our own bot messages
    if (event.subtype === 'bot_message') return;

    const files = event.files?.map(f => ({
      url: f.url_private ?? '',
      mimetype: f.mimetype ?? 'application/octet-stream',
    }));

    // Look up the user's display name and convert Slack emoji codes
    this.resolveUserName(event.user ?? '').then(name => {
      const text = this.resolveEmoji(event.text ?? '');
      this.onSlackMessage?.(event.thread_ts!, name, text, files);
    });
  }

  private async resolveUserName(userId: string): Promise<string> {
    if (!this.web || !userId) return 'Admin';
    try {
      const info = await this.web.users.info({ user: userId });
      return (
        (info.user as { real_name?: string; name?: string })?.real_name ??
        (info.user as { name?: string })?.name ??
        'Admin'
      );
    } catch {
      return 'Admin';
    }
  }

  // ── Screenshots ─────────────────────────────────────────────────────

  private async uploadScreenshot(dataUrl: string, threadTs: string, title: string): Promise<void> {
    if (!this.web || !this.config) return;

    try {
      // Strip data URL prefix to get raw base64
      const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (!base64Match) return;

      const buffer = Buffer.from(base64Match[1], 'base64');

      await this.web.filesUploadV2({
        channel_id: this.config.channelId,
        thread_ts: threadTs,
        file: buffer,
        filename: 'screenshot.png',
        title,
      });
    } catch (err) {
      console.error('Failed to upload screenshot to Slack:', (err as Error).message);
    }
  }

  // ── State & Listeners ───────────────────────────────────────────────

  getState(): SlackConfigState {
    return {
      type: 'slackConfigState',
      configured: this.isConfigured(),
      connected: this.connected,
      channelName: this.config?.channelName,
      error: this.lastError,
    };
  }

  addListener(fn: (state: SlackConfigState) => void): () => void {
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
        console.error('Error in SlackBridge listener:', err);
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadConfig(): void {
    try {
      if (!existsSync(this.configFilePath)) return;
      const raw = readFileSync(this.configFilePath, 'utf-8');
      const parsed: StoredSlackConfig = JSON.parse(raw);
      if (parsed.botToken && parsed.appToken && parsed.channelId) {
        this.config = parsed;
        console.log(`Loaded Slack config from ${this.configFilePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load Slack config from ${this.configFilePath}:`, (err as Error).message);
    }
  }

  private persistConfig(): void {
    try {
      writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save Slack config to ${this.configFilePath}:`, (err as Error).message);
    }
  }
}

/** FRC team numbers mentioned in free text: 1–5 digit runs bounded by
 *  non-digits ("5940", "(971/9584)", "Team 6036", "FRC 8033x9400"). */
export function teamNumbersIn(fields: (string | undefined)[]): Set<number> {
  const out = new Set<number>();
  for (const f of fields) {
    if (!f) continue;
    for (const m of f.matchAll(/(?<!\d)(\d{1,5})(?!\d)/g)) {
      const n = Number(m[1]);
      if (n > 0) out.add(n);
    }
  }
  return out;
}
