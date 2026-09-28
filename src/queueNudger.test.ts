import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchQueue } from './matchQueue.js';
import { QueueNudger } from './queueNudger.js';
import { TeamPrefsStore } from './teamPrefsStore.js';
import type { PushOutcome, PushPayload } from './pushService.js';
import type { PushSubscriptionInput } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pfms-nudge-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sub = (n: number): PushSubscriptionInput => ({
  endpoint: `https://push.example/${n}`,
  keys: { p256dh: 'p', auth: 'a' },
});

function setup(opts: { slackMembers?: Record<number, string[]>; gone?: Set<string>; now?: () => number } = {}) {
  const queue = new MatchQueue(join(dir, 'queue.json'), { now: opts.now });
  queue.updateSettings({ lineOpen: true });
  const prefs = new TeamPrefsStore(join(dir, 'prefs.json'));
  const dms: { to: string; text: string }[] = [];
  const pushes: { endpoint: string; payload: PushPayload }[] = [];
  const nudger = new QueueNudger({
    queue,
    prefs,
    slack: {
      isConnected: () => true,
      findTeamMembers: async team => (opts.slackMembers?.[team] ?? []).map(id => ({ id, name: id })),
      postTo: async (to, text) => {
        dms.push({ to, text });
        return true;
      },
    },
    push: {
      isAvailable: () => true,
      send: async (s, payload): Promise<PushOutcome> => {
        if (opts.gone?.has(s.endpoint)) return 'gone';
        pushes.push({ endpoint: s.endpoint, payload });
        return 'ok';
      },
    },
    publicUrl: () => 'https://field.example',
  });
  nudger.start();
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { queue, prefs, nudger, dms, pushes, flush };
}

describe('queue nudges', () => {
  test('a team hears it is next up, then on deck, once each, on the channels it chose', async () => {
    const t = setup({ slackMembers: { 1: ['U1', 'U2'] } });
    t.prefs.setNudge(1, { slack: true });
    t.prefs.addPushDevice(2, sub(1), 'phone');
    const entry = t.queue.add({ red: [1], blue: [2] });
    await t.flush();
    expect(t.dms.map(d => d.to)).toEqual(['U1', 'U2']);
    expect(t.dms[0].text).toContain('Next up: Match 1');
    expect(t.dms[0].text).toContain('https://field.example/1');
    expect(t.pushes.map(p => p.payload.title)).toEqual(['Next up: Match 1']);
    expect(t.pushes[0].payload.body).toContain('Blue alliance');

    t.queue.updateSettings({ allowShort: true }); // an unrelated broadcast: nothing repeats
    await t.flush();
    expect(t.dms).toHaveLength(2);
    expect(t.pushes).toHaveLength(1);

    t.queue.markOnDeck(entry.id);
    await t.flush();
    expect(t.dms).toHaveLength(4);
    expect(t.dms[2].text).toContain('On deck: Match 1');
    expect(t.pushes).toHaveLength(2);
    expect(t.pushes[1].payload.title).toBe('On deck: Match 1');
  });

  test('a team that chose nothing hears nothing beyond its page', async () => {
    const t = setup({ slackMembers: { 1: ['U1'] } });
    t.queue.add({ red: [1], blue: [] });
    await t.flush();
    expect(t.dms).toEqual([]);
    expect(t.pushes).toEqual([]);
  });

  test('a device the push service says is gone is forgotten', async () => {
    const t = setup({ gone: new Set(['https://push.example/1']) });
    t.prefs.addPushDevice(1, sub(1));
    t.prefs.addPushDevice(1, sub(2));
    t.queue.add({ red: [1], blue: [] });
    await t.flush();
    expect(t.pushes.map(p => p.endpoint)).toEqual(['https://push.example/2']);
    expect(t.prefs.pushDevices(1).map(d => d.endpoint)).toEqual(['https://push.example/2']);
  });

  test('a no-show is told the match is waiting on it, once', async () => {
    let now = 1_000_000;
    const t = setup({ now: () => now });
    t.prefs.addPushDevice(1, sub(1));
    t.queue.setPresenceResolver(() => false);
    t.queue.updateSettings({ noShowMinutes: 1 });
    const entry = t.queue.add({ red: [1], blue: [] });
    t.queue.markOnDeck(entry.id);
    await t.flush();
    expect(t.pushes.map(p => p.payload.title)).toEqual(['Next up: Match 1', 'On deck: Match 1']);

    now += 61_000;
    // The clock's own timer would broadcast here; any broadcast does.
    t.queue.updateSettings({ allowShort: false });
    await t.flush();
    expect(t.pushes.map(p => p.payload.title)).toEqual([
      'Next up: Match 1',
      'On deck: Match 1',
      'Match 1 is waiting on you',
    ]);
    t.queue.updateSettings({ allowShort: true });
    await t.flush();
    expect(t.pushes).toHaveLength(3);
  });

  test('"send test" pushes to every device and reports the count', async () => {
    const t = setup();
    t.prefs.addPushDevice(3, sub(1));
    t.prefs.addPushDevice(3, sub(2));
    expect(await t.nudger.test(3)).toEqual({ sent: 2, gone: 0, devices: 2 });
    expect(await t.nudger.test(4)).toEqual({ sent: 0, gone: 0, devices: 0 });
  });
});

describe('team preferences', () => {
  test('defaults, edits, devices, and a restart', () => {
    const prefs = new TeamPrefsStore(join(dir, 'prefs.json'));
    expect(prefs.get(1)).toEqual({ nudge: { banner: true, slack: false, push: false }, push: [] });
    prefs.setNudge(1, { slack: true, banner: false });
    expect(prefs.get(1).nudge).toEqual({ banner: true, slack: true, push: false });
    prefs.addPushDevice(1, sub(1), 'phone');
    expect(prefs.get(1).nudge.push).toBe(true);
    prefs.addPushDevice(1, sub(1), 'phone again'); // same endpoint: refreshed, not duplicated
    expect(prefs.pushDevices(1)).toHaveLength(1);
    expect(prefs.pushDevices(1)[0].label).toBe('phone again');

    const again = new TeamPrefsStore(join(dir, 'prefs.json'));
    expect(again.get(1).nudge).toEqual({ banner: true, slack: true, push: true });
    expect(again.pushDevices(1)[0].endpoint).toBe('https://push.example/1');
    again.removePushDevice(1, 'https://push.example/1');
    expect(again.get(1).nudge.push).toBe(false);
  });
});
