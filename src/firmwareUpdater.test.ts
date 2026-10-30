import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { updateRadioFirmware } from './firmwareUpdater.js';
import type { FirmwareStore } from './firmwareStore.js';
import { hashWpaKey } from './wpaKeyUtils.js';

const band = { hashedWpaKey: hashWpaKey('passphrase', 'salt'), wpaKeySalt: 'salt' };
const radio = { teamNumber: 1234, ssidSuffix: '', version: '2.0.1', networkStatus6: band };

const store = {
  needsUpdate: (version: string) => version === '1.0',
  // Any file will do: nothing reads the upload
  getFirmwareForRadio: () => ({ filePath: 'package.json', checksum: 'abc', version: '2.0.1' }),
} as unknown as FirmwareStore;

/** Run a whole update to its end, past its reboot and reconfigure waits. */
async function run(skipReconfigure: boolean): Promise<{ steps: string[]; result: Promise<void> }> {
  const steps: string[] = [];
  const result = updateRadioFirmware(1234, 'passphrase', undefined, skipReconfigure, store, p => steps.push(p.step));
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

  beforeEach(() => {
    jest.useFakeTimers();
    statusReads = 0;
    spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response('', { status: 202 }));
      if (!String(url).endsWith('/status')) return Promise.reject(new Error('unexpected request'));
      statusReads++;
      if (statusReads === 1) return Promise.resolve(Response.json({ ...radio, version: '1.0' }));
      return Promise.resolve(statusReads === 2 ? Response.json(radio) : finalStatus());
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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
