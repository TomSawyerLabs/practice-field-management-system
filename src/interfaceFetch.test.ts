import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { curlArgs, fetchOnInterface } from './interfaceFetch.js';
import * as interfaceFetch from './interfaceFetch.js';
import { checkFactoryDefault, checkRadio, checkRoboRIO } from './teamChecker.js';

const reply = (stdout: string) => async () => ({ stdout });

describe('curlArgs', () => {
  test('pins a GET to the bridge and asks for the status after the body', () => {
    const args = curlArgs('br-slot2', 'http://10.19.67.1/status', {}, 1500);
    expect(args.slice(args.indexOf('--interface'), args.indexOf('--interface') + 2)).toEqual([
      '--interface',
      'br-slot2',
    ]);
    expect(args.slice(args.indexOf('--max-time'), args.indexOf('--max-time') + 2)).toEqual(['--max-time', '1.5']);
    expect(args).not.toContain('--request');
    expect(args.at(-1)).toBe('http://10.19.67.1/status');
  });

  test('passes the method, headers and body untouched', () => {
    const args = curlArgs(
      'br-slot1',
      'http://10.19.67.2/nisysapi/server',
      { method: 'POST', headers: { Accept: 'text/xml' }, body: '@not-a-file=1&b=2' },
      3000,
    );
    expect(args).toContain('POST');
    expect(args).toContain('Accept: text/xml');
    expect(args[args.indexOf('--data-raw') + 1]).toBe('@not-a-file=1&b=2');
  });
});

describe('fetchOnInterface', () => {
  test('reads the body and the status line curl appends', async () => {
    const res = await fetchOnInterface('br-slot1', 'http://x/', {}, 1000, reply('{"a":1}\n200'));
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  test('keeps newlines in the body', async () => {
    const res = await fetchOnInterface('br-slot1', 'http://x/', {}, 1000, reply('line 1\nline 2\n\n200'));
    expect(await res.text()).toBe('line 1\nline 2\n');
  });

  test('an HTTP error is a reply, as with fetch', async () => {
    const res = await fetchOnInterface('br-slot1', 'http://x/', {}, 1000, reply('nope\n503'));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  const failing = (fields: object) => async () => {
    throw Object.assign(new Error('Command failed'), fields);
  };

  test('a timeout is an AbortError, as with fetch', async () => {
    const err = await fetchOnInterface('br-slot1', 'http://x/', {}, 1000, failing({ code: 28, stderr: 'timed out\n' }))
      .then(() => null)
      .catch(e => e as Error);
    expect(err?.name).toBe('AbortError');
  });

  test('other failures say what curl said', async () => {
    await expect(
      fetchOnInterface(
        'br-slot1',
        'http://x/',
        {},
        1000,
        failing({ code: 7, stderr: 'curl: (7) Failed to connect\n' }),
      ),
    ).rejects.toThrow('curl: (7) Failed to connect');
  });

  test('a port that has gone says which', async () => {
    const stderr = "curl: (45) Couldn't bind to 'eno1.p101'\n";
    await expect(fetchOnInterface('eno1.p101', 'http://x/', {}, 1000, failing({ code: 45, stderr }))).rejects.toThrow(
      "Network interface eno1.p101 is not available (curl: (45) Couldn't bind to 'eno1.p101')",
    );
  });

  test('says so when curl is missing', async () => {
    await expect(fetchOnInterface('br-slot1', 'http://x/', {}, 1000, failing({ code: 'ENOENT' }))).rejects.toThrow(
      'curl is not installed',
    );
  });
});

describe('curlArgs for a multipart form', () => {
  const file = { path: '/var/lib/pfms/fw;v2 "new".img', filename: 'firmware.img.enc' };

  test('sends the file by path, with curl left to read it', () => {
    const args = curlArgs('testport', 'http://x/firmware', { method: 'POST', form: { file, checksum: 'abc' } }, 60_000);
    expect(args[args.indexOf('--form') + 1]).toBe(
      'file=@"/var/lib/pfms/fw;v2 \\"new\\".img";filename="firmware.img.enc";type=application/octet-stream',
    );
    expect(args.slice(args.indexOf('--max-time'), args.indexOf('--max-time') + 2)).toEqual(['--max-time', '60']);
  });

  test("a string field is literal, so a value starting with @ can't name a file", () => {
    const args = curlArgs('testport', 'http://x/', { form: { checksum: '@/etc/passwd' } }, 1000);
    expect(args[args.indexOf('--form-string') + 1]).toBe('checksum=@/etc/passwd');
    expect(args).not.toContain('--form');
  });

  test('keeps the fields in order, and turns off the wait for 100 Continue', () => {
    const args = curlArgs('testport', 'http://x/', { form: { file, checksum: 'abc' } }, 1000);
    expect(args.indexOf('--form')).toBeLessThan(args.indexOf('--form-string'));
    expect(args).toContain('Expect:');
  });

  test('a body-only request leaves Expect alone', () => {
    expect(curlArgs('testport', 'http://x/', { body: 'a' }, 1000)).not.toContain('Expect:');
  });
});

describe('fetchOnInterface in a dry run', () => {
  const saved = process.env.DRY_RUN;
  const ran = spyOn({ run: reply('{}\n200') }, 'run');

  beforeEach(() => {
    process.env.DRY_RUN = '1';
    ran.mockClear();
    spies.push(spyOn(console, 'log').mockImplementation(() => {}));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = saved;
    while (spies.length) spies.pop()!.mockRestore();
  });

  const spies: { mockRestore(): void }[] = [];

  test('refuses a write to another machine, without running curl', async () => {
    const write = fetchOnInterface('br-slot1', 'http://10.12.34.1/configuration', { method: 'POST' }, 1000, ran);
    await expect(write).rejects.toThrow('dry run: POST http://10.12.34.1/configuration not sent');
    expect(ran).not.toHaveBeenCalled();
  });

  test('a body or form with no method counts as a write', async () => {
    for (const init of [{ body: 'a=1' }, { form: { checksum: 'abc' } }]) {
      await expect(fetchOnInterface('br-slot1', 'http://10.12.34.1/x', init, 1000, ran)).rejects.toThrow('dry run');
    }
    expect(ran).not.toHaveBeenCalled();
  });

  test('reads go, and so do writes to a fake on this machine', async () => {
    await fetchOnInterface('br-slot1', 'http://10.12.34.1/status', {}, 1000, ran);
    await fetchOnInterface('lo', 'http://127.0.0.1:8080/configuration', { method: 'POST' }, 1000, ran);
    expect(ran).toHaveBeenCalledTimes(2);
  });
});

describe('team checks reach the robot on their own station', () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  /** Radio and roboRIO answers, per bridge. No request leaves this process. */
  function stubBridges() {
    const seen: string[] = [];
    const spy = spyOn(interfaceFetch, 'fetchOnInterface').mockImplementation(async (ifname, url) => {
      seen.push(`${ifname} ${url}`);
      const body = url.endsWith('/status')
        ? JSON.stringify({ version: 'VH-109_2.0.1-02062026', teamNumber: ifname === 'br-slot2' ? 9998 : 9999 })
        : "<NISysAPI_Results hr='0'></NISysAPI_Results>";
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    });
    spies.push(spy);
    const direct = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('left by the routing table'));
    spies.push(direct);
    return { seen, direct };
  }

  test('the radio check goes out of the station bridge', async () => {
    const { seen, direct } = stubBridges();
    const checks = await checkRadio(9999, { ifname: 'br-slot2' });
    expect(seen).toEqual(['br-slot2 http://10.99.99.1/status']);
    expect(direct).not.toHaveBeenCalled();
    expect(checks.find(c => c.name === 'Radio Team')?.status).toBe('fail');
  });

  test('the roboRIO search goes out of the station bridge, for every address it tries', async () => {
    const { seen, direct } = stubBridges();
    await checkRoboRIO(9999, ['10.99.99.20'], { ifname: 'br-slot1' });
    expect(seen).toEqual(['br-slot1 http://10.99.99.2/nisysapi/server', 'br-slot1 http://10.99.99.20/nisysapi/server']);
    expect(direct).not.toHaveBeenCalled();
  });

  test("the factory check stays on the tester's interface, for both addresses", async () => {
    const { seen, direct } = stubBridges();
    await checkFactoryDefault(9999, { ifname: 'testport' });
    expect(seen.sort()).toEqual(['testport http://10.99.99.1/status', 'testport http://192.168.69.1/status']);
    expect(direct).not.toHaveBeenCalled();
  });
});
