import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MdnsLookupLog } from './mdnsLookupLog.js';
import type { MdnsLookupEvent } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mdns-lookups-'));
  dirs.push(dir);
  return join(dir, 'mdns-lookups.jsonl');
}

const asked = (t: number, name = 'limelight.local'): MdnsLookupEvent => ({
  t,
  kind: 'forwarded',
  requester: '10.55.18.177',
  port: 5353,
  station: 'slot1',
  team: 2854,
  questions: [{ name, type: 'A', qu: false }],
});

/** appendFile is async; wait until the file holds `lines` lines. */
async function linesOf(file: string, lines: number): Promise<MdnsLookupEvent[]> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim();
      const parsed = text ? text.split('\n').map(l => JSON.parse(l) as MdnsLookupEvent) : [];
      if (parsed.length >= lines) return parsed;
    }
    await Bun.sleep(5);
  }
  throw new Error(`never saw ${lines} lines in ${file}`);
}

describe('mDNS lookup log', () => {
  test('a lookup repeated within the window is counted, not written again', () => {
    const log = new MdnsLookupLog({ file: null, repeatWindowMs: 30_000 });
    log.record(asked(0));
    log.record(asked(1_000));
    log.record(asked(2_000));
    log.record(asked(1_500, 'radio.local'));
    log.record(asked(31_000));
    expect(log.getRecent().map(e => [e.t, e.repeatsBefore])).toEqual([
      [0, undefined],
      [1_500, undefined],
      [31_000, 2],
    ]);
  });

  test('written to the file, and read back after a restart', async () => {
    const file = tempFile();
    const log = new MdnsLookupLog({ file });
    log.record(asked(0));
    log.record(asked(0, 'radio.local'));
    log.flush();
    await linesOf(file, 2);

    const restarted = new MdnsLookupLog({ file });
    expect(restarted.getRecent().map(e => e.kind === 'forwarded' && e.questions[0].name)).toEqual([
      'limelight.local',
      'radio.local',
    ]);
  });

  test('rotates past the size limit, keeping one old copy', async () => {
    const file = tempFile();
    const log = new MdnsLookupLog({ file, maxBytes: 500, repeatWindowMs: 0 });
    for (let i = 0; i < 4; i++) log.record(asked(i * 10, `cam${i}.local`));
    log.flush();
    await linesOf(file, 4);
    expect(statSync(file).size).toBeGreaterThan(500);

    log.record(asked(100, 'after.local'));
    log.flush();
    const fresh = await linesOf(file, 1);
    expect(fresh.length).toBe(1);
    expect(readFileSync(`${file}.1`, 'utf8').trim().split('\n').length).toBe(4);

    // Both copies count when reading back
    expect(new MdnsLookupLog({ file }).getRecent().length).toBe(5);
  });

  test('keeps only the newest events in memory', () => {
    const log = new MdnsLookupLog({ file: null, keepInMemory: 3, repeatWindowMs: 0 });
    for (let i = 0; i < 5; i++) log.record(asked(i, `n${i}.local`));
    expect(log.getRecent().map(e => e.t)).toEqual([2, 3, 4]);
    expect(log.getRecent(2).map(e => e.t)).toEqual([3, 4]);
  });

  test("a file it can't write leaves the memory copy working", async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const log = new MdnsLookupLog({ file: join(tempFile(), 'no-such-dir', 'x.jsonl') });
      log.record(asked(0));
      expect(() => log.flush()).not.toThrow();
      await Bun.sleep(20);
      expect(log.getRecent().length).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
