/**
 * A MessagePack decoder, enough for NetworkTables 4 (src/robotNt.ts): nil,
 * booleans, integers, floats, strings, binary, arrays and maps. Extension
 * types aren't used by NT4 and throw.
 */

export type MsgpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | MsgpackValue[]
  | { [key: string]: MsgpackValue };

/** Every value in `buf`, one after another (NT4 packs several per frame). */
export function decodeAll(buf: Uint8Array): MsgpackValue[] {
  const reader = new Reader(buf);
  const out: MsgpackValue[] = [];
  while (reader.pos < buf.length) out.push(reader.value());
  return out;
}

class Reader {
  pos = 0;
  private view: DataView;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): number {
    const at = this.pos;
    if (at + n > this.buf.length) throw new Error('msgpack: truncated');
    this.pos += n;
    return at;
  }
  private u8 = () => this.view.getUint8(this.need(1));
  private u16 = () => this.view.getUint16(this.need(2));
  private u32 = () => this.view.getUint32(this.need(4));
  private bytes = (n: number) => this.buf.subarray(this.need(n), this.pos);
  private str = (n: number) => new TextDecoder().decode(this.bytes(n));
  /** A 64-bit integer as a number when it fits exactly, else a bigint. */
  private big(v: bigint): number | bigint {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }

  value(): MsgpackValue {
    const b = this.u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xf0) === 0x80) return this.map(b & 0x0f);
    if ((b & 0xf0) === 0x90) return this.array(b & 0x0f);
    if ((b & 0xe0) === 0xa0) return this.str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.bytes(this.u8());
      case 0xc5:
        return this.bytes(this.u16());
      case 0xc6:
        return this.bytes(this.u32());
      case 0xca:
        return this.view.getFloat32(this.need(4));
      case 0xcb:
        return this.view.getFloat64(this.need(8));
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf:
        return this.big(this.view.getBigUint64(this.need(8)));
      case 0xd0:
        return this.view.getInt8(this.need(1));
      case 0xd1:
        return this.view.getInt16(this.need(2));
      case 0xd2:
        return this.view.getInt32(this.need(4));
      case 0xd3:
        return this.big(this.view.getBigInt64(this.need(8)));
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.array(this.u16());
      case 0xdd:
        return this.array(this.u32());
      case 0xde:
        return this.map(this.u16());
      case 0xdf:
        return this.map(this.u32());
    }
    throw new Error(`msgpack: unsupported type 0x${b.toString(16)}`);
  }

  private array(n: number): MsgpackValue[] {
    const out: MsgpackValue[] = [];
    for (let i = 0; i < n; i++) out.push(this.value());
    return out;
  }

  private map(n: number): { [key: string]: MsgpackValue } {
    const out: { [key: string]: MsgpackValue } = {};
    for (let i = 0; i < n; i++) {
      const key = this.value();
      out[String(key)] = this.value();
    }
    return out;
  }
}
