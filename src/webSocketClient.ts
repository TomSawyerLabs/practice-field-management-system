/**
 * A WebSocket client (RFC 6455) over any byte stream. pFMS needs one over a
 * TCP connection pinned to a station bridge (src/mdnsSocket.ts
 * openInterfaceTcp), which the built-in WebSocket can't use.
 *
 * Feed it what the connection receives with `receive()`; it writes through
 * `transport`. Call `open()` once the connection is up to send the handshake.
 */
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEADER_END = Buffer.from('\r\n\r\n');
/** Biggest message accepted; NT4 sends small ones. */
const MAX_MESSAGE = 4 * 1024 * 1024;

export interface ByteTransport {
  write(data: Buffer): void;
  close(): void;
}

export interface WebSocketHandlers {
  /** The handshake succeeded; `protocol` is the one the server chose. */
  onOpen(protocol: string | null): void;
  onText(text: string): void;
  onBinary(data: Buffer): void;
  /** The socket is finished: a close frame, a protocol error, or a refused handshake. */
  onClose(reason: string): void;
}

export interface WebSocketTarget {
  host: string;
  path: string;
  protocols?: string[];
}

export class WebSocketClient {
  private buf: Buffer = Buffer.alloc(0);
  private key = randomBytes(16).toString('base64');
  private state: 'idle' | 'handshake' | 'open' | 'closed' = 'idle';
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;

  constructor(
    private transport: ByteTransport,
    private target: WebSocketTarget,
    private handlers: WebSocketHandlers,
  ) {}

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** Send the opening handshake (the connection is up). */
  open(): void {
    if (this.state !== 'idle') return;
    this.state = 'handshake';
    const lines = [
      `GET ${this.target.path} HTTP/1.1`,
      `Host: ${this.target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.key}`,
      'Sec-WebSocket-Version: 13',
    ];
    if (this.target.protocols?.length) lines.push(`Sec-WebSocket-Protocol: ${this.target.protocols.join(', ')}`);
    this.transport.write(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`));
  }

  /** Bytes from the connection. */
  receive(chunk: Buffer): void {
    if (this.state === 'closed' || this.state === 'idle') return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      if (this.state === 'handshake' && !this.readHandshake()) return;
      while (this.state === 'open' && this.readFrame());
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  sendText(text: string): void {
    this.sendFrame(0x1, Buffer.from(text));
  }

  /** Close politely (a close frame), then hang up. */
  close(reason = 'closed by pFMS'): void {
    if (this.state === 'open') {
      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000);
      try {
        this.sendFrame(0x8, code);
      } catch {
        // the connection is already gone
      }
    }
    this.finish(reason);
  }

  private readHandshake(): boolean {
    const end = this.buf.indexOf(HEADER_END);
    if (end === -1) {
      if (this.buf.length > 16 * 1024) throw new Error('No handshake reply');
      return false;
    }
    const [statusLine, ...lines] = this.buf.subarray(0, end).toString('latin1').split('\r\n');
    this.buf = this.buf.subarray(end + HEADER_END.length);
    const status = Number(statusLine.split(' ')[1]);
    if (status !== 101) throw new Error(`The server answered "${statusLine}", not a WebSocket`);
    const headers = new Map<string, string>();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const expected = createHash('sha1')
      .update(this.key + GUID)
      .digest('base64');
    if (headers.get('sec-websocket-accept') !== expected) throw new Error('Bad Sec-WebSocket-Accept');
    this.state = 'open';
    this.handlers.onOpen(headers.get('sec-websocket-protocol') ?? null);
    return true;
  }

  /** One frame from the buffer, if a whole one is there. */
  private readFrame(): boolean {
    if (this.buf.length < 2) return false;
    const fin = (this.buf[0] & 0x80) !== 0;
    const opcode = this.buf[0] & 0x0f;
    const masked = (this.buf[1] & 0x80) !== 0;
    let length = this.buf[1] & 0x7f;
    let at = 2;
    if (length === 126) {
      if (this.buf.length < 4) return false;
      length = this.buf.readUInt16BE(2);
      at = 4;
    } else if (length === 127) {
      if (this.buf.length < 10) return false;
      const big = this.buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) throw new Error('Message too big');
      length = Number(big);
      at = 10;
    }
    if (length > MAX_MESSAGE) throw new Error('Message too big');
    const maskAt = at;
    if (masked) at += 4;
    if (this.buf.length < at + length) return false;
    let payload = Buffer.from(this.buf.subarray(at, at + length));
    if (masked) {
      const mask = this.buf.subarray(maskAt, maskAt + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = this.buf.subarray(at + length);

    switch (opcode) {
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const why = payload.subarray(2).toString();
        this.close(`the server closed (${code}${why ? `: ${why}` : ''})`);
        return false;
      }
      case 0x9:
        this.sendFrame(0xa, payload);
        return true;
      case 0xa:
        return true;
      case 0x0:
      case 0x1:
      case 0x2: {
        if (opcode !== 0x0) {
          this.fragments = [];
          this.fragmentOpcode = opcode;
        }
        this.fragments.push(payload);
        if (!fin) {
          if (this.fragments.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) throw new Error('Message too big');
          return true;
        }
        payload = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === 0x1) this.handlers.onText(payload.toString());
        else this.handlers.onBinary(payload);
        return this.state === 'open';
      }
      default:
        throw new Error(`Unknown opcode ${opcode}`);
    }
  }

  /** A client frame: always masked. */
  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.state !== 'open') return;
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    if (n < 126) head[1] = 0x80 | n;
    else if (n < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.transport.write(Buffer.concat([head, mask, body]));
  }

  private fail(reason: string): void {
    this.finish(reason);
  }

  private finish(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.transport.close();
    this.handlers.onClose(reason);
  }
}
