import { afterEach, beforeEach, describe, expect, jest, spyOn, test, type Mock } from 'bun:test';
import { updateRadioFirmware } from './firmwareUpdater.js';
import type { FirmwareStore } from './firmwareStore.js';
import * as interfaceFetch from './interfaceFetch.js';
import { hashWpaKey } from './wpaKeyUtils.js';

const IFACE = 'testport';
const band = { hashedWpaKey: hashWpaKey('passphrase', 'salt'), wpaKeySalt: 'salt' };
const radio = { teamNumber: 1234, ssidSuffix: '', version: '2.0.1', networkStatus6: band };

const store = {
  needsUpdate: (version: string) => version === '1.0',
  getFirmwareForRadio: () => ({ filePath: '/data/firmware.img', checksum: 'abc', version: '2.0.1' }),
} as unknown as FirmwareStore;

/** Run a whole update to its end, past its reboot and reconfigure waits. */
async function run(skipReconfigure: boolean): Promise<{ steps: string[]; result: Promise<void> }> {
  const steps: string[] = [];
  const result = updateRadioFirmware(1234, IFACE, 'passphrase', undefined, skipReconfigure, store, p =>
    steps.push(p.step),
  );
  result.catch(() => {});
  for (let i = 0; i < 40; i++) {
    jest.advanceTimersByTime(1_000);
    for (let tick = 0; tick < 50; tick++) await Promise.resolve();
  }
  return { steps, result };
}

describe('updateRadioFirmware', () => {
  /** What the radio's last read of an update gets: every /status after the upload but one. */
  let finalStatus: () => Response;
  let statusReads: number;
  let upload: () => Response;
  let requests: Mock<typeof interfaceFetch.fetchOnInterface>;

  beforeEach(() => {
    jest.useFakeTimers();
    statusReads = 0;
    upload = () => new Response('', { status: 202 });
    requests = spyOn(interfaceFetch, 'fetchOnInterface').mockImplementation((_ifname, url, init) => {
      if (url.endsWith('/firmware')) return Promise.resolve(upload());
      if (init?.method === 'POST') return Promise.resolve(new Response('', { status: 202 }));
      if (!url.endsWith('/status')) return Promise.reject(new Error('unexpected request'));
      statusReads++;
      if (statusReads === 1) return Promise.resolve(Response.json({ ...radio, version: '1.0' }));
      return Promise.resolve(statusReads === 2 ? Response.json(radio) : finalStatus());
    });
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('left by the routing table'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("every request of an update stays on the tester's interface", async () => {
    finalStatus = () => Response.json(radio);
    await run(false);

    expect(requests.mock.calls.length).toBeGreaterThan(4);
    expect(requests.mock.calls.every(([ifname]) => ifname === IFACE)).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('the image goes up by path, as a form with 60 s to finish', async () => {
    finalStatus = () => Response.json(radio);
    await run(false);

    const call = requests.mock.calls.find(([, url]) => url.endsWith('/firmware'))!;
    expect(call[1]).toBe('http://10.12.34.1/firmware');
    expect(call[2]).toEqual({
      method: 'POST',
      form: { file: { path: '/data/firmware.img', filename: 'firmware.img.enc' }, checksum: 'abc' },
    });
    expect(call[3]).toBe(60_000);
  });

  test('an upload the radio answers with anything but 202 fails', async () => {
    finalStatus = () => Response.json(radio);
    upload = () => new Response('bad image', { status: 200 });
    const { result } = await run(false);

    await expect(result).rejects.toThrow('Firmware upload rejected (HTTP 200): bad image');
  });

  test('a firmware-only update still ends when the radio answers its last read with an error', async () => {
    finalStatus = () => new Response('', { status: 503 });
    const { steps, result } = await run(true);

    await expect(result).resolves.toBeUndefined();
    expect(steps.at(-1)).toBe('complete');
  });

  test('a reconfigured update fails, rather than never ending, when the same read gets an error', async () => {
    let reads = 0;
    // waitForHost needs one good answer before the final read
    finalStatus = () => (++reads === 1 ? Response.json(radio) : new Response('', { status: 503 }));
    const { steps, result } = await run(false);

    await expect(result).rejects.toThrow('Cannot verify radio after update: radio returned HTTP 503');
    expect(steps).not.toContain('complete');
  });

  test('a reconfigured update completes on a good final read', async () => {
    finalStatus = () => Response.json(radio);
    const { steps, result } = await run(false);

    await expect(result).resolves.toBeUndefined();
    expect(steps.at(-1)).toBe('complete');
  });
});
