import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminPushStore } from './adminPushStore.js';
import { parseChainRuleLine } from './node-ip/linux.js';
import { alertForgotPassword } from './teamPasswordAlert.js';

const dir = mkdtempSync(join(tmpdir(), 'pfms-team-alert-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

describe('alertForgotPassword', () => {
  test('goes to Slack and every admin device, and forgets devices that are gone', async () => {
    const store = new AdminPushStore(join(dir, 'push.json'));
    store.add(sub('https://push/ok'), 'Phone');
    store.add(sub('https://push/gone'));
    const posted: string[] = [];
    const result = await alertForgotPassword(
      {
        postToSlack: async text => (posted.push(text), true),
        pushStore: store,
        sendPush: async s => (s.endpoint.endsWith('ok') ? 'ok' : 'gone'),
        adminUrl: () => 'https://pfms.example.org/admin',
      },
      1234,
      '192.168.3.10',
    );
    expect(result).toEqual({ slack: true, push: 1 });
    expect(posted[0]).toContain('Team 1234 forgot');
    expect(posted[0]).toContain('192.168.3.10');
    expect(store.list().map(d => d.endpoint)).toEqual(['https://push/ok']);
  });

  test('says when nobody could be told', async () => {
    const result = await alertForgotPassword(
      {
        postToSlack: async () => false,
        pushStore: new AdminPushStore(join(dir, 'empty.json')),
        sendPush: async () => 'ok',
        adminUrl: () => undefined,
      },
      1234,
      '192.168.3.10',
    );
    expect(result).toEqual({ slack: false, push: 0 });
  });
});

describe('parseChainRuleLine', () => {
  test('reads iptables -L -v -n -x rows', () => {
    expect(
      parseChainRuleLine('     152    12000 RETURN     0    --  *      *       192.168.3.10         0.0.0.0/0'),
    ).toEqual({
      packets: 152,
      target: 'RETURN',
      source: '192.168.3.10',
    });
    expect(
      parseChainRuleLine(
        '       0        0 REJECT     6    --  *      *       0.0.0.0/0            0.0.0.0/0   reject-with tcp-reset',
      ),
    ).toEqual({ packets: 0, target: 'REJECT', source: '0.0.0.0/0' });
    expect(
      parseChainRuleLine(' pkts bytes target     prot opt in     out     source               destination'),
    ).toBeUndefined();
  });
});
