/**
 * mDNS sockets pinned to one network interface, from the native addon in
 * native/mdns-socket (Rust). Node's dgram can only choose an IPv4 multicast
 * interface by address, and a team on two stations has the same address
 * (10.TE.AM.254) on two bridges. A pinned socket sends out of its bridge and
 * hears only what arrives on it, so each robot's mDNS is kept apart.
 *
 * The addon is prebuilt per platform in CI and fetched at build time
 * (scripts/fetch-mdns-socket.ts) into native/mdns-socket/prebuilt/. It is
 * Linux only, like everything else pFMS does to the network.
 * MDNS_SOCKET_NODE points at another build (a local one, for testing).
 */
import { bundledPath } from './assetRoot.js';

export interface InterfaceSocket {
  readonly ifname: string;
  readonly ifindex: number;
  /** Multicast to 224.0.0.251:5353 out of this interface. Throws on failure. */
  send(packet: Buffer): void;
  /** Stop receiving and close. Idempotent. */
  close(): void;
}

type OnPacket = (data: Buffer, address: string, port: number) => void;
type InterfaceSocketCtor = new (ifname: string, port: number, onPacket: OnPacket) => InterfaceSocket;

/** The addon file for this platform. */
export function mdnsSocketAddonPath(): string {
  if (process.env.MDNS_SOCKET_NODE) return process.env.MDNS_SOCKET_NODE;
  const file = `mdns-socket.${process.platform}-${process.arch}-gnu.node`;
  // The checkout's prebuilt/, or the packaged binary's unpacked copy.
  return bundledPath('native', 'mdns-socket', 'prebuilt', file);
}

let loaded: { ctor: InterfaceSocketCtor } | { error: string } | undefined;

function load(): { ctor: InterfaceSocketCtor } | { error: string } {
  if (loaded) return loaded;
  if (process.platform !== 'linux') {
    loaded = { error: 'interface-pinned mDNS sockets need Linux' };
    return loaded;
  }
  const file = mdnsSocketAddonPath();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require(file) as { InterfaceSocket: InterfaceSocketCtor };
    loaded = { ctor: addon.InterfaceSocket };
  } catch (err) {
    loaded = { error: `can't load ${file}: ${(err as Error).message}` };
  }
  return loaded;
}

/** Why pinned sockets can't be opened here, or null when they can. */
export function mdnsSocketUnavailable(): string | null {
  const l = load();
  return 'error' in l ? l.error : null;
}

/**
 * Open an mDNS socket on `ifname` (a station bridge), bound to `port` (5353)
 * and joined to 224.0.0.251 on that interface only. `onPacket` gets every
 * datagram that arrives there. Throws if the addon isn't available or the
 * interface doesn't exist.
 */
export function openInterfaceSocket(ifname: string, port: number, onPacket: OnPacket): InterfaceSocket {
  const l = load();
  if ('error' in l) throw new Error(l.error);
  return new l.ctor(ifname, port, onPacket);
}
