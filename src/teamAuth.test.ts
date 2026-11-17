import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEAM_DEVICE_TTL_MS, TeamAuth } from './teamAuth.js';

const PASSWORD = 'gearbox42!';
const dir = mkdtempSync(join(tmpdir(), 'pfms-team-auth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('TeamAuth', () => {
  let file: string;
  let now: number;
  let auth: TeamAuth;
  const open = () => new TeamAuth(file, () => now);

  beforeEach(() => {
    file = join(dir, `${Math.random()}.json`);
    now = 1_000_000;
    auth = open();
  });

  async function setUp(team = 1234) {
    const r = await auth.setPassword(team, PASSWORD, { deviceName: 'Setter' });
    if (!r || !('token' in r)) throw new Error('set failed');
    return r;
  }

  async function logIn(team = 1234, address = '192.168.3.10') {
    const r = await auth.login(team, PASSWORD, 'Laptop', address);
    if (!r.ok) throw new Error('login failed');
    return r;
  }

  test('a team with no password has nothing to log in to', async () => {
    expect(auth.hasPassword(1234)).toBe(false);
    expect(auth.status(1234)).toEqual({ passwordSet: false, lock: false, devices: 0 });
    expect(await auth.login(1234, PASSWORD, 'x', '1.1.1.1')).toEqual({ ok: false, reason: 'noPassword' });
  });

  test('a short password is refused', async () => {
    expect(await auth.setPassword(1234, 'short')).toBeNull();
    // 99xx numbers are spare robots: they join a team's login, never own one.
    expect(await auth.setPassword(9940, 'long-enough-password')).toBeNull();
    expect(auth.hasPassword(9940)).toBe(false);
    expect(auth.hasPassword(1234)).toBe(false);
  });

  test('setting a password logs the setter in', async () => {
    const { token } = await setUp();
    expect(auth.validate(1234, token)?.name).toBe('Setter');
    expect(auth.status(1234)).toEqual({ passwordSet: true, lock: false, devices: 1 });
  });

  test('a token is only good for its own team, and survives a restart', async () => {
    await setUp(1234);
    await setUp(5678);
    const { token } = await logIn(1234);
    auth = open();
    expect(auth.validate(1234, token)?.name).toBe('Laptop');
    expect(auth.validate(5678, token)).toBeNull();
    expect(auth.validate(1234, 'nonsense')).toBeNull();
    expect(auth.validate(1234, undefined)).toBeNull();
  });

  test('a wrong password is refused, and guesses are rate limited per address', async () => {
    await setUp();
    for (let i = 0; i < 5; i++) {
      expect(await auth.login(1234, 'wrong-password', 'x', '10.0.0.9')).toEqual({ ok: false, reason: 'wrong' });
    }
    const limited = await auth.login(1234, PASSWORD, 'x', '10.0.0.9');
    expect(limited.ok).toBe(false);
    expect(!limited.ok && limited.reason).toBe('busy');
    // Another address is unaffected.
    expect((await auth.login(1234, PASSWORD, 'x', '10.0.0.10')).ok).toBe(true);
  });

  test('a device is remembered for a year from its last visit', async () => {
    await setUp();
    const { token } = await logIn();
    now += TEAM_DEVICE_TTL_MS - 1000;
    expect(auth.validate(1234, token)).not.toBeNull();
    // That visit started the year again.
    now += TEAM_DEVICE_TTL_MS - 1000;
    expect(auth.validate(1234, token)).not.toBeNull();
    now += TEAM_DEVICE_TTL_MS + 1;
    expect(auth.validate(1234, token)).toBeNull();
    expect(auth.listDevices(1234).map(d => d.name)).not.toContain('Laptop');
    auth.pruneDevices();
    expect(auth.listDevices(1234)).toEqual([]);
  });

  test('changing the password signs out everyone but the device that changed it', async () => {
    const setter = await setUp();
    const other = await logIn();
    const r = await auth.setPassword(1234, 'another-password', { keepDeviceId: setter.device.id });
    expect(r && 'kept' in r).toBe(true);
    expect(auth.validate(1234, setter.token)).not.toBeNull();
    expect(auth.validate(1234, other.token)).toBeNull();
    expect((await auth.login(1234, PASSWORD, 'x', '10.0.0.2')).ok).toBe(false);
    expect((await auth.login(1234, 'another-password', 'x', '10.0.0.2')).ok).toBe(true);
  });

  test('reset forgets password, devices and lock', async () => {
    const { token } = await setUp();
    auth.setLock(1234, true);
    expect(auth.reset(1234)).toBe(true);
    expect(auth.status(1234)).toEqual({ passwordSet: false, lock: false, devices: 0 });
    expect(auth.validate(1234, token)).toBeNull();
    expect(auth.lockedTeams()).toEqual([]);
  });

  test('the lock needs a password', () => {
    expect(auth.setLock(1234, true)).toBe(false);
    expect(auth.isLocked(1234)).toBe(false);
  });

  describe('address bindings', () => {
    test('a device holds one address, and an address one device', async () => {
      await setUp(1234);
      await setUp(5678);
      const a = await logIn(1234, '192.168.3.10');
      const b = await logIn(5678, '192.168.3.11');
      auth.bindAddress(1234, a.device.id, '192.168.3.10');
      expect(auth.allowedAddresses(1234)).toEqual(['192.168.3.10']);

      // The laptop moved to a new lease.
      auth.bindAddress(1234, a.device.id, '192.168.3.20');
      expect(auth.allowedAddresses(1234)).toEqual(['192.168.3.20']);

      // Another team's laptop got the old one, then this one's.
      auth.bindAddress(5678, b.device.id, '192.168.3.20');
      expect(auth.allowedAddresses(1234)).toEqual([]);
      expect(auth.allowedAddresses(5678)).toEqual(['192.168.3.20']);
    });

    test('a binding ends after the idle limit with no traffic', async () => {
      await setUp();
      const a = await logIn();
      auth.bindAddress(1234, a.device.id, '192.168.3.10');
      const idle = 12 * 3600_000;

      now += idle - 1000;
      auth.sawTraffic(1234, ['192.168.3.10']);
      now += idle - 1000;
      expect(auth.expireBindings(idle)).toEqual([]);
      expect(auth.allowedAddresses(1234)).toEqual(['192.168.3.10']);

      now += 2000;
      expect(auth.expireBindings(idle)).toEqual([1234]);
      expect(auth.allowedAddresses(1234)).toEqual([]);
      // The device itself is still logged in: a visit binds it again.
      expect(auth.validate(1234, a.token)).not.toBeNull();
    });

    test('signing a device out ends its binding', async () => {
      await setUp();
      const a = await logIn();
      auth.bindAddress(1234, a.device.id, '192.168.3.10');
      auth.removeDevice(1234, a.device.id);
      expect(auth.allowedAddresses(1234)).toEqual([]);
    });

    test('changes that touch the network are announced', async () => {
      const changes: { team: number; network: boolean }[] = [];
      auth.onChange(c => changes.push(c));
      await setUp();
      const a = await logIn();
      changes.length = 0;
      auth.bindAddress(1234, a.device.id, '192.168.3.10');
      auth.setLock(1234, true);
      expect(changes).toEqual([
        { team: 1234, network: true },
        { team: 1234, network: true },
      ]);
    });
  });
});
