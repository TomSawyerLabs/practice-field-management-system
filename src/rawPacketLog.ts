import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/**
 * Captured packets saved as pcap files (one a day, readable in Wireshark),
 * for traffic pFMS can see but can't decode yet.
 *
 * Written for the 2027 FIRST Driver Station talking to a SystemCore robot:
 * its packet layout is unpublished, so the passive capture keeps it raw
 * until it can be read (plans/systemcore-robot-capture.md). Capped per day
 * and in total, oldest days deleted first, so a forgotten capture can't
 * fill the disk.
 */
export interface RawPacketLogOptions {
  directory: string;
  /** File name prefix; files are `<prefix>-YYYY-MM-DD.pcap`. */
  prefix: string;
  maxBytesPerDay?: number;
  maxBytesTotal?: number;
  now?: () => Date;
}

/** pcap global header: magic, v2.4, UTC offset 0, accuracy 0, snaplen, Ethernet. */
function pcapHeader(): Buffer {
  const h = Buffer.alloc(24);
  h.writeUInt32LE(0xa1b2c3d4, 0);
  h.writeUInt16LE(2, 4);
  h.writeUInt16LE(4, 6);
  h.writeUInt32LE(262144, 16);
  h.writeUInt32LE(1, 20);
  return h;
}

export class RawPacketLog {
  private stream: WriteStream | null = null;
  private day: string | null = null;
  private bytes = 0;
  private full = false;
  private readonly maxBytesPerDay: number;
  private readonly maxBytesTotal: number;
  private readonly now: () => Date;

  constructor(private readonly opts: RawPacketLogOptions) {
    this.maxBytesPerDay = opts.maxBytesPerDay ?? 50 * 1024 * 1024;
    this.maxBytesTotal = opts.maxBytesTotal ?? 300 * 1024 * 1024;
    this.now = opts.now ?? (() => new Date());
  }

  /** Append one pcap record (its 16-byte header and the packet). */
  write(record: Buffer): void {
    const day = localDay(this.now());
    if (day !== this.day) this.open(day);
    if (this.full || !this.stream) return;
    if (this.bytes + record.length > this.maxBytesPerDay) {
      this.full = true;
      console.log(`RawPacketLog: ${this.fileFor(day)} reached its daily cap; not recording more today`);
      return;
    }
    this.stream.write(record);
    this.bytes += record.length;
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
    this.day = null;
  }

  private fileFor(day: string): string {
    return join(this.opts.directory, `${this.opts.prefix}-${day}.pcap`);
  }

  private open(day: string): void {
    this.close();
    this.day = day;
    this.full = false;
    try {
      mkdirSync(this.opts.directory, { recursive: true });
      this.prune(day);
      const file = this.fileFor(day);
      const exists = existsSync(file);
      this.bytes = exists ? statSync(file).size : 0;
      this.stream = createWriteStream(file, { flags: 'a' });
      this.stream.on('error', err => {
        console.error(`RawPacketLog: writing ${file} failed: ${err.message}`);
        this.stream = null;
      });
      if (!exists) {
        const header = pcapHeader();
        this.stream.write(header);
        this.bytes += header.length;
      }
    } catch (err) {
      console.error(`RawPacketLog: can't open ${this.fileFor(day)}: ${(err as Error).message}`);
      this.stream = null;
    }
  }

  /** Delete the oldest files until the rest fit the total cap with room for
   *  a full day more. Today's file is never deleted. */
  private prune(today: string): void {
    const ours = readdirSync(this.opts.directory)
      .filter(n => n.startsWith(`${this.opts.prefix}-`) && n.endsWith('.pcap'))
      .sort();
    let total = ours.reduce((sum, n) => sum + statSync(join(this.opts.directory, n)).size, 0);
    for (const name of ours) {
      if (total + this.maxBytesPerDay <= this.maxBytesTotal) break;
      if (name === `${this.opts.prefix}-${today}.pcap`) continue;
      const file = join(this.opts.directory, name);
      total -= statSync(file).size;
      rmSync(file, { force: true });
    }
  }
}

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
