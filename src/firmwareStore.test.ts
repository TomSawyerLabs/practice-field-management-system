import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFirmwareRequest } from './firmwareApi.js';
import { FirmwareStore, FirmwareUploadRefused, type KnownRelease } from './firmwareStore.js';
import type { StaffHttpCheck } from './staffHttp.js';

const IMAGE = Buffer.from('an encrypted firmware image');
/** What the radio checks after decrypting: never the hash of the file. */
const RADIO_CHECKSUM = 'cd'.repeat(32);
const WRONG = 'ab'.repeat(32);

const RELEASE: KnownRelease = {
  version: '9.9.9',
  checksum: RADIO_CHECKSUM,
  imageSha256: createHash('sha256').update(IMAGE).digest('hex'),
  upgradeFrom: 'from12x',
};

let dir: string;
let store: FirmwareStore;

const images = () => readdirSync(dir).filter(f => f.endsWith('.img.enc'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pfms-firmware-'));
  store = new FirmwareStore(dir, [RELEASE]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('adding firmware by hand', () => {
  test('the image of a known release is kept', () => {
    const entry = store.addManualFirmware(IMAGE, RADIO_CHECKSUM, '9.9.9', 'from12x');
    expect(entry.filePath).toBeDefined();
    expect(images()).toHaveLength(1);
  });

  test("a checksum in capitals is the same checksum, and it isn't the file's own hash", () => {
    store.addManualFirmware(IMAGE, RADIO_CHECKSUM.toUpperCase(), '9.9.9', 'from12x');
    expect(RELEASE.imageSha256).not.toBe(RADIO_CHECKSUM);
    expect(images()).toHaveLength(1);
  });

  test('a corrupt image of a known release is refused, and nothing is written', () => {
    const corrupt = () => store.addManualFirmware(Buffer.from('truncated'), RADIO_CHECKSUM, '9.9.9', 'from12x');
    expect(corrupt).toThrow(FirmwareUploadRefused);
    expect(images()).toEqual([]);
    expect(store.getEntries()[0].filePath).toBeUndefined();
  });

  test('a mistyped checksum for a known release is refused', () => {
    expect(() => store.addManualFirmware(IMAGE, WRONG, '9.9.9', 'from12x')).toThrow(FirmwareUploadRefused);
    expect(images()).toEqual([]);
  });

  test('the same version for the other radios is not this image', () => {
    const other = new FirmwareStore(dir, [{ ...RELEASE, upgradeFrom: 'pre12x', imageSha256: WRONG }]);
    expect(() => other.addManualFirmware(IMAGE, RADIO_CHECKSUM, '9.9.9', 'pre12x')).toThrow(FirmwareUploadRefused);
  });

  test('a bad upload leaves the good image it would have replaced', () => {
    store.addManualFirmware(IMAGE, RADIO_CHECKSUM, '9.9.9', 'from12x');
    expect(() => store.addManualFirmware(Buffer.from('truncated'), RADIO_CHECKSUM, '9.9.9', 'from12x')).toThrow();
    const path = store.getEntries()[0].filePath!;
    expect(Bun.file(path).size).toBe(IMAGE.length);
  });

  test('a version nobody here knows goes to the radio to check', () => {
    expect(store.addManualFirmware(IMAGE, WRONG, '10.0.0', 'from12x').checksum).toBe(WRONG);
  });

  test('the check stays out of the entries clients get', () => {
    expect(store.getEntries()[0]).not.toHaveProperty('imageSha256');
  });
});

describe('uploading firmware', () => {
  let server: Server;
  let base: string;
  const access = { staffRefusal: () => null, readRefusal: () => null } as unknown as StaffHttpCheck;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (!handleFirmwareRequest(req, res, store, access)) res.writeHead(404).end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => void server.close());

  const upload = (body: Buffer) =>
    fetch(`${base}/api/firmware/upload?checksum=${RADIO_CHECKSUM}&version=9.9.9&upgradeFrom=from12x`, {
      method: 'POST',
      body,
    });

  test('a corrupt image is the uploader’s to fix, and says what the file really hashes to', async () => {
    const corrupt = Buffer.from('truncated');
    const res = await upload(corrupt);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      createHash('sha256').update(corrupt).digest('hex'),
    );
    expect(images()).toEqual([]);
  });

  test('the right image goes through', async () => {
    expect((await upload(IMAGE)).status).toBe(200);
    expect(images()).toHaveLength(1);
  });
});
