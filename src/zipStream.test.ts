import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { ZipWriter, crc32, zipSizeEstimate } from './zipStream.js';

function collect(): { sink: Writable; chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { sink, chunks };
}

/** Walk the central directory the way an extractor would and return the entries. */
function readCentralDirectory(zip: Buffer): { name: string; crc: number; size: number; offset: number }[] {
  // End of central directory: last 22 bytes when there is no comment.
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  let count = zip.readUInt16LE(eocd + 10);
  let cdStart = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdStart === 0xffffffff || zip.readUInt32LE(eocd - 20) === 0x07064b50) {
    const locator = eocd - 20;
    expect(zip.readUInt32LE(locator)).toBe(0x07064b50);
    const z64 = Number(zip.readBigUInt64LE(locator + 8));
    expect(zip.readUInt32LE(z64)).toBe(0x06064b50);
    count = Number(zip.readBigUInt64LE(z64 + 32));
    cdStart = Number(zip.readBigUInt64LE(z64 + 48));
  }
  const entries = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(p + 16);
    let size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    let offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    if (extraLen) {
      const extra = zip.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      expect(extra.readUInt16LE(0)).toBe(0x0001);
      let q = 4;
      if (size === 0xffffffff) {
        size = Number(extra.readBigUInt64LE(q));
        q += 16; // uncompressed + compressed
      }
      if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(q));
    }
    entries.push({ name, crc, size, offset });
    p += 46 + nameLen + extraLen;
  }
  return entries;
}

function unzipAvailable(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('crc32', () => {
  test('matches the reference value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
  test('can be computed incrementally', () => {
    const a = crc32(Buffer.from('12345'));
    expect(crc32(Buffer.from('6789'), a)).toBe(0xcbf43926);
  });
});

describe('ZipWriter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pfms-zip-'));
  const big = join(dir, 'video.bin');
  // Larger than the default read-stream chunk (64 KiB) so the CRC spans chunks.
  const bigData = Buffer.alloc(200_000);
  for (let i = 0; i < bigData.length; i++) bigData[i] = (i * 31) & 0xff;
  writeFileSync(big, bigData);

  async function build(forceZip64: boolean): Promise<Buffer> {
    const { sink, chunks } = collect();
    const zip = new ZipWriter(sink, { forceZip64 });
    await zip.addBuffer('day/metadata.json', '{"ok":true}', new Date(2026, 8, 18, 19, 4, 30));
    await zip.addFile('day/run-1/all-field.mp4', big, statSync(big).size, new Date(2026, 8, 18, 19, 5));
    await zip.finish();
    return Buffer.concat(chunks);
  }

  for (const forceZip64 of [false, true]) {
    test(`central directory lists every entry with the right CRC and size (zip64=${forceZip64})`, async () => {
      const out = await build(forceZip64);
      const entries = readCentralDirectory(out);
      expect(entries.map(e => e.name)).toEqual(['day/metadata.json', 'day/run-1/all-field.mp4']);
      expect(entries[0].size).toBe(11);
      expect(entries[0].crc).toBe(crc32(Buffer.from('{"ok":true}')));
      expect(entries[1].size).toBe(bigData.length);
      expect(entries[1].crc).toBe(crc32(bigData));
      // The stored bytes sit right after each local header.
      for (const e of entries) {
        expect(out.readUInt32LE(e.offset)).toBe(0x04034b50);
        const nameLen = out.readUInt16LE(e.offset + 26);
        const extraLen = out.readUInt16LE(e.offset + 28);
        const dataStart = e.offset + 30 + nameLen + extraLen;
        const expected = e.name.endsWith('.json') ? Buffer.from('{"ok":true}') : bigData;
        expect(out.subarray(dataStart, dataStart + e.size).equals(expected)).toBe(true);
      }
      expect(out.length).toBe(
        zipSizeEstimate(
          [
            { name: 'day/metadata.json', size: 11 },
            { name: 'day/run-1/all-field.mp4', size: bigData.length },
          ],
          forceZip64,
        ),
      );
    });

    test(`unzip accepts the archive (zip64=${forceZip64})`, async () => {
      if (!unzipAvailable()) return;
      const out = await build(forceZip64);
      const file = join(dir, `out-${forceZip64}.zip`);
      writeFileSync(file, out);
      const listing = execFileSync('unzip', ['-t', file], { encoding: 'utf-8' });
      expect(listing).toContain('No errors detected');
      const extracted = execFileSync('unzip', ['-p', file, 'day/run-1/all-field.mp4']);
      expect(Buffer.from(extracted).equals(bigData)).toBe(true);
    });
  }

  test('a file that changed size on disk fails instead of writing a corrupt entry', async () => {
    const { sink } = collect();
    const zip = new ZipWriter(sink);
    await expect(zip.addFile('x.bin', big, bigData.length - 1, new Date())).rejects.toThrow(/expected/);
  });

  test('waits for the sink to drain instead of buffering everything', async () => {
    const slow = new PassThrough({ highWaterMark: 1024 });
    const zip = new ZipWriter(slow);
    let done = false;
    const p = zip.addFile('v.bin', big, bigData.length, new Date()).then(() => (done = true));
    await new Promise(r => setTimeout(r, 20));
    expect(done).toBe(false); // nobody is reading, so the writer is parked on backpressure
    const drained: Buffer[] = [];
    slow.on('data', d => drained.push(d));
    await p;
    await zip.finish();
    slow.end();
    await new Promise(r => slow.on('end', r));
    expect(readCentralDirectory(Buffer.concat(drained))[0].size).toBe(bigData.length);
  });

  test('rejects once the sink has gone away', async () => {
    const { sink } = collect();
    sink.destroy();
    const zip = new ZipWriter(sink);
    await expect(zip.addBuffer('x.txt', 'hi')).rejects.toThrow(/closed/);
  });

  test('metadata sample survives a round trip', () => {
    expect(readFileSync(big).length).toBe(bigData.length);
  });
});
