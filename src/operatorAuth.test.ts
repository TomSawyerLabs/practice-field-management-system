import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperatorAuth } from './operatorAuth.js';

const CODE = 'correct horse';
const dir = mkdtempSync(join(tmpdir(), 'pfms-operator-auth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('OperatorAuth', () => {
  let file: string;
  let now: number;
  let auth: OperatorAuth;
  const open = () => new OperatorAuth(file, () => now);

  beforeEach(() => {
    file = join(dir, `${Math.random()}.json`);
    now = 1_000_000;
    auth = open();
  });

  async function logIn() {
    const result = await auth.login(CODE, 'Phone', '10.0.0.1');
    if (!result.ok) throw new Error('login failed');
    return result;
  }

  test('nothing is required until a field sets it up', async () => {
    expect(auth.isRequired()).toBe(false);
    await auth.setCode(CODE);
    expect(auth.isRequired()).toBe(true);
  });

  test('a short code is refused', async () => {
    expect(await auth.setCode('1234567')).toBe(false);
    expect(auth.isRequired()).toBe(false);
  });

  test('logging in gives a token that keeps working after a restart', async () => {
    await auth.setCode(CODE);
    const { token } = await logIn();
    auth = open();
    expect(auth.validateToken(token)?.name).toBe('Phone');
    expect(auth.validateToken('nonsense')).toBeNull();
    expect(auth.validateToken('')).toBeNull();
  });

  test('a token never expires by itself', async () => {
    await auth.setCode(CODE);
    const { token } = await logIn();
    now += 10 * 365 * 24 * 60 * 60_000;
    expect(auth.validateToken(token)).not.toBeNull();
  });

  test('neither the code nor a token is stored in the clear', async () => {
    await auth.setCode(CODE);
    const { token } = await logIn();
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain(CODE);
    expect(stored).not.toContain(token);
  });

  test('a wrong code fails', async () => {
    await auth.setCode(CODE);
    expect(await auth.login('wrong code', 'Phone', '10.0.0.1')).toEqual({ ok: false });
    expect(auth.listDevices()).toEqual([]);
  });

  test('a sixth try from one address waits, and others are not held up', async () => {
    await auth.setCode(CODE);
    for (let i = 0; i < 5; i++) expect((await auth.login('wrong', 'x', '10.0.0.1')).ok).toBe(false);

    const blocked = await auth.login(CODE, 'x', '10.0.0.1');
    expect(blocked).toEqual({ ok: false, retryAfterMs: 60_000 });
    expect((await auth.login(CODE, 'x', '10.0.0.2')).ok).toBe(true);

    now += 60_001;
    expect((await auth.login(CODE, 'x', '10.0.0.1')).ok).toBe(true);
  });

  test('a burst is limited before the slow check finishes', async () => {
    await auth.setCode(CODE);
    const tries = await Promise.all(Array.from({ length: 8 }, () => auth.login('wrong', 'x', '10.0.0.1')));
    expect(tries.filter(t => !t.ok && t.retryAfterMs !== undefined)).toHaveLength(3);
  });

  test('guesses spread over many addresses are limited too', async () => {
    await auth.setCode(CODE);
    for (let i = 0; i < 30; i++) await auth.login('wrong', 'x', `10.0.1.${i}`);
    const blocked = await auth.login(CODE, 'x', '10.0.2.1');
    expect(!blocked.ok && blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test('changing the code signs out devices that used it, not paired ones', async () => {
    await auth.setCode(CODE);
    const typed = await logIn();
    const paired = auth.redeemPairing(auth.startPairing('Phone').secret, 'Tablet')!;

    await auth.setCode('a different code');
    expect(auth.validateToken(typed.token)).toBeNull();
    expect(auth.validateToken(paired.token)?.pairedBy).toBe('Phone');
    expect((await auth.login(CODE, 'x', '10.0.0.3')).ok).toBe(false);
  });

  test('removing the code turns logins off for every device', async () => {
    await auth.setCode(CODE);
    const typed = await logIn();
    const { secret } = auth.startPairing('Admin');
    const paired = auth.redeemPairing(auth.startPairing('Admin').secret, 'Tablet')!;

    auth.clearCode();
    expect(auth.isRequired()).toBe(false);
    expect(auth.listDevices()).toEqual([]);
    expect(auth.validateToken(typed.token)).toBeNull();
    expect(auth.validateToken(paired.token)).toBeNull();
    expect(auth.redeemPairing(secret, 'Tablet')).toBeNull();
  });

  test('logging out every device leaves the field locked', async () => {
    await auth.setCode(CODE);
    await logIn();
    auth.revokeAllDevices();
    expect(auth.isRequired()).toBe(true);
  });

  test('a pairing works once, and not after five minutes', () => {
    const { secret } = auth.startPairing('Admin', 'Head ref');
    expect(auth.redeemPairing(secret, 'iPhone browser')?.device).toMatchObject({
      name: 'Head ref',
      via: 'pairing',
      pairedBy: 'Admin',
    });
    expect(auth.redeemPairing(secret, 'iPhone browser')).toBeNull();

    const stale = auth.startPairing('Admin').secret;
    now += 5 * 60_000;
    expect(auth.redeemPairing(stale, 'iPhone browser')).toBeNull();
    expect(auth.redeemPairing('made up', 'iPhone browser')).toBeNull();
  });

  test('revoking one device leaves the others', async () => {
    await auth.setCode(CODE);
    const first = await logIn();
    const second = await logIn();
    auth.revokeDevice(first.device.id);
    expect(auth.validateToken(first.token)).toBeNull();
    expect(auth.validateToken(second.token)).not.toBeNull();
  });
});
