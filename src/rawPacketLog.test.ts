import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawPacketLog } from './rawPacketLog.js';

/** A pcap record: 16-byte header, then `len` bytes of packet. */
function record(len: number, fill = 0xab): Buffer {
  const r = Buffer.alloc(16 + len, fill);
  r.writeUInt32LE(1_800_000_000, 0);
  r.writeUInt32LE(0, 4);
  r.writeUInt32LE(len, 8);
  r.writeUInt32LE(len, 12);
  return r;
}

describe('RawPacketLog', () => {
  let dir: string;
  let clock: Date;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rawlog-'));
    clock = new Date(2026, 9, 29, 15, 0, 0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('writes a pcap file per local day, header first', async () => {
    const log = new RawPacketLog({ directory: dir, prefix: 'sc', now: () => clock });
    log.write(record(60));
    log.write(record(60));
    await log.close();
    const bytes = readFileSync(join(dir, 'sc-2026-10-29.pcap'));
    expect(bytes.readUInt32LE(0)).toBe(0xa1b2c3d4);
    expect(bytes.readUInt32LE(20)).toBe(1); // Ethernet
    expect(bytes.length).toBe(24 + 2 * 76);
  });

  test('appends to the day’s file after a restart, without a second header', async () => {
    const first = new RawPacketLog({ directory: dir, prefix: 'sc', now: () => clock });
    first.write(record(10));
    await first.close();
    const second = new RawPacketLog({ directory: dir, prefix: 'sc', now: () => clock });
    second.write(record(10));
    await second.close();
    expect(readFileSync(join(dir, 'sc-2026-10-29.pcap')).length).toBe(24 + 2 * 26);
  });

  test('stops at the daily cap, and starts again the next day', async () => {
    const log = new RawPacketLog({ directory: dir, prefix: 'sc', maxBytesPerDay: 200, now: () => clock });
    for (let i = 0; i < 10; i++) log.write(record(60));
    clock = new Date(2026, 9, 30, 9, 0, 0);
    log.write(record(60));
    await log.close();
    expect(readFileSync(join(dir, 'sc-2026-10-29.pcap')).length).toBe(24 + 2 * 76);
    expect(readFileSync(join(dir, 'sc-2026-10-30.pcap')).length).toBe(24 + 76);
  });

  test('close still finishes when the file can not be written', async () => {
    mkdirSync(join(dir, 'sc-2026-10-29.pcap'));
    const log = new RawPacketLog({ directory: dir, prefix: 'sc', now: () => clock });
    log.write(record(10));
    await log.close();
  });

  test('deletes the oldest days to stay under the total cap', async () => {
    for (const day of ['2026-10-25', '2026-10-26', '2026-10-27']) {
      writeFileSync(join(dir, `sc-${day}.pcap`), Buffer.alloc(100));
    }
    writeFileSync(join(dir, 'unrelated.txt'), Buffer.alloc(1000));
    const log = new RawPacketLog({
      directory: dir,
      prefix: 'sc',
      maxBytesPerDay: 100,
      maxBytesTotal: 300,
      now: () => clock,
    });
    log.write(record(10));
    await log.close();
    expect(readdirSync(dir).sort()).toEqual([
      'sc-2026-10-26.pcap',
      'sc-2026-10-27.pcap',
      'sc-2026-10-29.pcap',
      'unrelated.txt',
    ]);
  });
});
