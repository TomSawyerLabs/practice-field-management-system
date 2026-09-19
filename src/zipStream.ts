/**
 * Minimal streaming ZIP writer: store-only (no compression), ZIP64-capable.
 *
 * pFMS bundles a team's practice-day videos into one download. The files are
 * MP4s — already compressed, so "store" costs nothing in size and nothing in
 * CPU — and a day can exceed 4 GB, which the classic ZIP format cannot
 * express, hence ZIP64. Nothing is buffered: each entry is streamed from disk
 * straight into the response with its CRC computed on the way, and the sizes
 * and CRC follow the data in a data descriptor. The server hosting this has
 * no `zip` binary, and a dependency would be heavier than these lines.
 *
 * Layout written:
 *   [local header][data][data descriptor] × N
 *   [central directory]
 *   [zip64 end of central directory record + locator]   (when needed)
 *   [end of central directory]
 */
import { createReadStream } from 'node:fs';
import type { Writable } from 'node:stream';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_EOCD = 0x06054b50;
const VERSION_STORE = 20;
const VERSION_ZIP64 = 45;
/** General purpose flags: bit 3 = sizes/CRC follow the data; bit 11 = UTF-8 names. */
const FLAGS = 0x0008 | 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
  zip64: boolean;
}

/** MS-DOS date/time fields (local time, 2 s resolution — what ZIP has). */
function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipWriterOptions {
  /** Write every entry in ZIP64 form even when small (exercised by tests). */
  forceZip64?: boolean;
}

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private finished = false;
  private readonly forceZip64: boolean;

  constructor(
    private readonly out: Writable,
    opts: ZipWriterOptions = {},
  ) {
    this.forceZip64 = opts.forceZip64 ?? false;
  }

  /** Bytes written so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  /** Add a file from disk. `size` must be its exact length (from stat). */
  async addFile(name: string, path: string, size: number, mtime: Date): Promise<void> {
    const stream = createReadStream(path);
    const iter = stream[Symbol.asyncIterator]() as AsyncIterableIterator<Buffer>;
    await this.addEntry(name, size, mtime, iter);
  }

  /** Add an in-memory entry (a manifest, a CSV). */
  async addBuffer(name: string, data: Buffer | string, mtime = new Date()): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    async function* one() {
      yield buf;
    }
    await this.addEntry(name, buf.length, mtime, one());
  }

  private async addEntry(name: string, size: number, mtime: Date, chunks: AsyncIterable<Buffer>): Promise<void> {
    if (this.finished) throw new Error('zip already finished');
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf-8');
    const zip64 = this.forceZip64 || size > MAX32 || this.offset > MAX32;
    const { dosTime, dosDate } = dosDateTime(mtime);
    const entry: Entry = { name: nameBuf, crc: 0, size: 0, offset: this.offset, dosTime, dosDate, zip64 };

    // Local file header. Sizes are known up front (from stat); the CRC is not,
    // so it goes in the data descriptor after the data (flag bit 3).
    const extra = zip64 ? zip64Extra(size, size, undefined) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_STORE, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(0, 8); // method: store
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(0, 14); // crc (in the descriptor)
    header.writeUInt32LE(zip64 ? MAX32 : size, 18);
    header.writeUInt32LE(zip64 ? MAX32 : size, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([header, nameBuf, extra]));

    let crc = 0;
    let written = 0;
    for await (const chunk of chunks) {
      crc = crc32(chunk, crc);
      written += chunk.length;
      await this.write(chunk);
    }
    if (written !== size) {
      // The file changed under us; the archive would be corrupt either way,
      // so fail loudly rather than emit a descriptor that lies.
      throw new Error(`${name}: expected ${size} bytes, read ${written}`);
    }
    entry.crc = crc;
    entry.size = size;

    // Data descriptor: 8-byte sizes when the local header carried a ZIP64 extra.
    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (zip64) {
      descriptor.writeBigUInt64LE(BigInt(size), 8);
      descriptor.writeBigUInt64LE(BigInt(size), 16);
    } else {
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    await this.write(descriptor);
    this.entries.push(entry);
  }

  /** Write the central directory and end records. Does not end the stream. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const needZip64 = e.zip64 || e.size > MAX32 || e.offset > MAX32;
      const extra = needZip64 ? zip64Extra(e.size, e.size, e.offset) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(needZip64 ? VERSION_ZIP64 : VERSION_STORE, 4); // version made by
      h.writeUInt16LE(needZip64 ? VERSION_ZIP64 : VERSION_STORE, 6); // version needed
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.dosTime, 12);
      h.writeUInt16LE(e.dosDate, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(needZip64 ? MAX32 : e.size, 20);
      h.writeUInt32LE(needZip64 ? MAX32 : e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32); // comment length
      h.writeUInt16LE(0, 34); // disk number start
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(needZip64 ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([h, e.name, extra]));
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const needZip64End =
      this.forceZip64 || count > MAX16 || cdSize > MAX32 || cdStart > MAX32 || this.entries.some(e => e.zip64);

    if (needZip64End) {
      const z = Buffer.alloc(56);
      z.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      z.writeBigUInt64LE(BigInt(44), 4); // size of the rest of this record
      z.writeUInt16LE(VERSION_ZIP64, 12);
      z.writeUInt16LE(VERSION_ZIP64, 14);
      z.writeUInt32LE(0, 16); // this disk
      z.writeUInt32LE(0, 20); // disk with the central directory
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const zip64EndOffset = this.offset;
      await this.write(z);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_EOCD, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
  }

  /** Honour backpressure: wait for `drain` when the sink is full, and fail
   *  fast when the sink is gone (client hung up) so we stop reading files. */
  private write(buf: Buffer): Promise<void> {
    this.offset += buf.length;
    const out = this.out;
    if (out.destroyed || out.writableEnded) return Promise.reject(new Error('output closed'));
    if (out.write(buf)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('output closed'));
      };
      const cleanup = () => {
        out.off('drain', onDrain);
        out.off('close', onClose);
        out.off('error', onClose);
      };
      out.on('drain', onDrain);
      out.on('close', onClose);
      out.on('error', onClose);
    });
  }
}

/** ZIP64 extended information extra field (header id 0x0001). Fields are
 *  present only where the caller passes them, in the order the spec fixes:
 *  uncompressed size, compressed size, local header offset. */
function zip64Extra(uncompressed: number, compressed: number, offset: number | undefined): Buffer {
  const len = 16 + (offset === undefined ? 0 : 8);
  const b = Buffer.alloc(4 + len);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(len, 2);
  b.writeBigUInt64LE(BigInt(uncompressed), 4);
  b.writeBigUInt64LE(BigInt(compressed), 12);
  if (offset !== undefined) b.writeBigUInt64LE(BigInt(offset), 20);
  return b;
}

/** Total bytes a store-only zip of these entries will occupy, so a download
 *  can carry a Content-Length. Exact for the non-ZIP64 case; when ZIP64
 *  records are needed the extras are included as well. */
export function zipSizeEstimate(entries: { name: string; size: number }[], forceZip64 = false): number {
  let offset = 0;
  let cd = 0;
  let anyZip64 = false;
  for (const e of entries) {
    const nameLen = Buffer.byteLength(e.name, 'utf-8');
    const zip64 = forceZip64 || e.size > MAX32 || offset > MAX32;
    anyZip64 ||= zip64;
    offset += 30 + nameLen + (zip64 ? 20 : 0) + e.size + (zip64 ? 24 : 16);
    cd += 46 + nameLen + (zip64 ? 28 : 0);
  }
  const zip64End = anyZip64 || entries.length > MAX16 || cd > MAX32 || offset > MAX32 ? 56 + 20 : 0;
  return offset + cd + zip64End + 22;
}
