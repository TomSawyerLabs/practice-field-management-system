/**
 * mDNS reflector — bridges mDNS queries/responses between the main network
 * (where team laptops live) and per-team VLAN interfaces (where robots live).
 *
 * Traffic is one-directional per type:
 *   Queries:   main network → team VLAN  (laptops looking up robots)
 *   Responses: team VLAN → the laptop that asked  (robots answering)
 *
 * Query routing uses the laptop's route preference to pick the VLAN. That
 * preference is set by driving a station, by the DS↔FMS handshake, or by the
 * subnet scanner when conntrack shows the laptop talking to a team subnet —
 * a laptop nobody can place gets nothing forwarded. Because the VLAN is
 * chosen per laptop, ALL .local names work (roboRIO, Limelight, PhotonVision,
 * radio, etc.) without parsing team numbers out of hostnames.
 *
 * Responses are never multicast back out. Every team's radio is `radio.local`
 * (and every Limelight `limelight.local`), so flooding the answers to the
 * laptop networks made six robots fight over one name in every laptop's cache.
 * Instead each forwarded question is remembered for a few seconds, and an
 * answer from a VLAN is sent unicast only to the laptop(s) whose open question
 * it answers. Unsolicited announcements are dropped.
 *
 * The robot side is one socket per station, pinned to that station's bridge
 * (src/mdnsSocket.ts, a native addon): a query leaves by the laptop's
 * station's bridge only, and an answer is known to come from that station's
 * robot. A team running two robots has the same address on two bridges,
 * which is why the bridge can't be chosen by address (1967, 2026-10-12).
 * Forwarded queries ask for multicast answers (the QU bit is cleared): a
 * unicast one would go to the gateway address, and the drive session's DNAT
 * would hand it to the DS laptop.
 *
 * The laptop side is one ordinary socket on :5353. It ignores anything from
 * a team subnet on the field (the station sockets have it), and never
 * receives its own packets (multicast loopback off).
 */
import dgram from 'node:dgram';
import { mdnsSocketUnavailable, openInterfaceSocket, type InterfaceSocket } from './mdnsSocket.js';
import { MdnsActivity, MdnsResolvedName, StationMdnsActivity, StationName, StationNameList } from './types.js';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

// ── DNS packet parsing (minimal) ────────────────────────────────────

/**
 * Read a DNS name from the packet at the given offset, handling label
 * compression pointers (RFC 1035 §4.1.4).
 */
function readDnsName(buf: Buffer, offset: number): { name: string; bytesRead: number } {
  const labels: string[] = [];
  let pos = offset;
  let bytesRead = 0;
  let jumped = false;

  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      if (!jumped) bytesRead += 1;
      break;
    }

    // Compression pointer: top 2 bits set → remaining 14 bits are an offset
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) bytesRead += 2;
      pos = pointer;
      jumped = true;
      continue;
    }

    // Regular label: 1-byte length prefix followed by that many ASCII bytes
    if (pos + 1 + len > buf.length) break;
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('ascii'));
    pos += 1 + len;
    if (!jumped) bytesRead += 1 + len;
  }

  return { name: labels.join('.'), bytesRead };
}

/** Extract all question names from an mDNS packet (header is 12 bytes). */
function parseQuestionNames(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  const names: string[] = [];
  let offset = 12;

  for (let i = 0; i < qdCount && offset < buf.length; i++) {
    const { name, bytesRead } = readDnsName(buf, offset);
    if (name) names.push(name);
    offset += bytesRead + 4; // skip QTYPE (2) + QCLASS (2)
  }

  return names;
}

/** Extract answer records from an mDNS packet, including A record IPs. */
function parseAnswerRecords(buf: Buffer): { name: string; resolvedIp?: string }[] {
  if (buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const records: { name: string; resolvedIp?: string }[] = [];

  // Skip past question section
  let offset = 12;
  for (let i = 0; i < qdCount && offset < buf.length; i++) {
    const { bytesRead } = readDnsName(buf, offset);
    offset += bytesRead + 4;
  }

  // Read answer records
  for (let i = 0; i < anCount && offset < buf.length; i++) {
    const { name, bytesRead } = readDnsName(buf, offset);
    offset += bytesRead;
    if (offset + 10 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const rdLength = buf.readUInt16BE(offset + 8);
    let resolvedIp: string | undefined;
    // A record: TYPE=1, RDLENGTH=4 → 4 bytes of IPv4
    if (type === 1 && rdLength === 4 && offset + 14 <= buf.length) {
      resolvedIp = `${buf[offset + 10]}.${buf[offset + 11]}.${buf[offset + 12]}.${buf[offset + 13]}`;
    }
    offset += 10 + rdLength;
    if (name) records.push({ name, resolvedIp });
  }

  return records;
}

// ── mDNS name condensing ────────────────────────────────────────────

/**
 * Split an mDNS name into hostname + optional service type.
 *
 * Examples:
 *   "roborio-846-frc._ni-rt._tcp.local" → { hostname: "roborio-846-frc.local", service: "_ni-rt._tcp" }
 *   "_services._dns-sd._udp.local"      → { hostname: "_services._dns-sd._udp.local" }  (no host prefix)
 *   "roborio-846-frc.local"             → { hostname: "roborio-846-frc.local" }
 *
 * A service suffix is detected when a label starting with '_' appears
 * after at least one non-underscore label.
 */
function splitMdnsName(name: string): { hostname: string; service?: string } {
  // Strip .local suffix for processing, re-add at end
  const stripped = name.replace(/\.local\.?$/i, '');
  const labels = stripped.split('.');

  // Find the first label starting with '_' — everything from there is the service
  const serviceIdx = labels.findIndex(l => l.startsWith('_'));
  if (serviceIdx <= 0) {
    // No service suffix, or the name starts with _ (pure service query)
    return { hostname: name.toLowerCase() };
  }

  const host = labels.slice(0, serviceIdx).join('.') + '.local';
  const service = labels.slice(serviceIdx).join('.');
  return { hostname: host.toLowerCase(), service };
}

// ── IP exclusion list ───────────────────────────────────────────────

type IpMatcher = (ip: number) => boolean;

/**
 * Parse a comma-separated list of IP exclusions into matchers.
 * Supported formats:
 *   "10.255.0.1"        — single IP
 *   "10.255.0.0/24"     — CIDR range
 *   "10.255.0.1-50"     — last-octet range (10.255.0.1 through 10.255.0.50)
 */
function parseExcludeList(raw: string): IpMatcher[] {
  const matchers: IpMatcher[] = [];
  for (const entry of raw.split(/[,\s]+/).filter(Boolean)) {
    // CIDR: "10.255.0.0/24"
    const cidrMatch = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (cidrMatch) {
      const prefix = parseInt(cidrMatch[2], 10);
      if (prefix < 0 || prefix > 32) {
        throw new Error(`mDNS: invalid CIDR prefix in "${entry}"`);
      }
      const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
      const network = (ipToNumber(cidrMatch[1]) & mask) >>> 0;
      matchers.push((ip: number) => (ip & mask) >>> 0 === network);
      continue;
    }

    // Last-octet range: "10.255.0.1-50"
    const rangeMatch = entry.match(/^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/);
    if (rangeMatch) {
      const base = ipToNumber(rangeMatch[1] + '.0') >>> 0;
      const lo = parseInt(rangeMatch[2], 10);
      const hi = parseInt(rangeMatch[3], 10);
      if (lo > hi || lo > 255 || hi > 255) {
        throw new Error(`mDNS: invalid range in "${entry}"`);
      }
      const start = (base | lo) >>> 0;
      const end = (base | hi) >>> 0;
      matchers.push((ip: number) => ip >= start && ip <= end);
      continue;
    }

    // Single IP: "10.255.0.1"
    if (/^\d+\.\d+\.\d+\.\d+$/.test(entry)) {
      const exact = ipToNumber(entry);
      matchers.push((ip: number) => ip === exact);
      continue;
    }

    throw new Error(`mDNS: unrecognized exclude entry "${entry}"`);
  }
  return matchers;
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.');
  return (
    ((parseInt(parts[0]) << 24) | (parseInt(parts[1]) << 16) | (parseInt(parts[2]) << 8) | parseInt(parts[3])) >>> 0
  );
}

function isExcluded(ip: string, matchers: IpMatcher[]): boolean {
  if (matchers.length === 0) return false;
  const num = ipToNumber(ip);
  return matchers.some(m => m(num));
}

// ── Open questions ──────────────────────────────────────────────────

/** How long a forwarded question stays open for answers. Responders answer
 *  within tens of milliseconds; a client re-asks itself after about a second
 *  if nothing came back, so anything older is stale, not late. */
const PENDING_QUERY_TTL_MS = 3_000;

/** Where an answer has to go: the laptop, the port it asked from, and its
 *  query ID (only meaningful for legacy one-shot queries from other ports). */
export interface Requester {
  address: string;
  port: number;
  id: number;
}

interface PendingEntry extends Requester {
  /** Where the question went (stationScope). */
  scope: string;
  expires: number;
}

/** Scope of a question forwarded to a station's robot. */
export const stationScope = (station: StationName) => `station:${station}`;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

/**
 * Questions forwarded to a VLAN that have not aged out, keyed by name, so an
 * answer can be routed back to exactly the laptop(s) that asked for it.
 */
export class PendingQueries {
  private byName = new Map<string, PendingEntry[]>();

  constructor(private readonly ttlMs = PENDING_QUERY_TTL_MS) {}

  add(names: string[], scope: string, requester: Requester, now = Date.now()): void {
    const expires = now + this.ttlMs;
    for (const raw of names) {
      const name = normalizeName(raw);
      const entries = this.byName.get(name) ?? [];
      // A re-ask from the same laptop replaces its earlier entry rather than stacking
      const kept = entries.filter(
        e => e.expires > now && !(e.address === requester.address && e.port === requester.port && e.scope === scope),
      );
      kept.push({ ...requester, scope, expires });
      this.byName.set(name, kept);
    }
  }

  /** Laptops with an open question for any of `names` in `scope` — one per laptop:port. */
  match(names: string[], scope: string, now = Date.now()): Requester[] {
    const seen = new Map<string, Requester>();
    for (const raw of names) {
      const name = normalizeName(raw);
      const entries = this.byName.get(name);
      if (!entries) continue;
      const live = entries.filter(e => e.expires > now);
      if (live.length === 0) this.byName.delete(name);
      else if (live.length !== entries.length) this.byName.set(name, live);
      for (const e of live) {
        if (e.scope !== scope) continue;
        const key = `${e.address}:${e.port}`;
        if (!seen.has(key)) seen.set(key, { address: e.address, port: e.port, id: e.id });
      }
    }
    return [...seen.values()];
  }

  /** Drop everything that has aged out (the match path prunes lazily; this is for the timer). */
  prune(now = Date.now()): void {
    for (const [name, entries] of this.byName) {
      const live = entries.filter(e => e.expires > now);
      if (live.length === 0) this.byName.delete(name);
      else if (live.length !== entries.length) this.byName.set(name, live);
    }
  }

  get size(): number {
    let n = 0;
    for (const entries of this.byName.values()) n += entries.length;
    return n;
  }
}

/** Copy of `packet` with the DNS header ID replaced — a legacy one-shot querier
 *  (anything not asking from port 5353) matches answers to questions by ID,
 *  while multicast responders always send ID 0. */
export function withDnsId(packet: Buffer, id: number): Buffer {
  const copy = Buffer.from(packet);
  copy.writeUInt16BE(id & 0xffff, 0);
  return copy;
}

/** An answer as `target` expects it: a full mDNS client (asking from 5353)
 *  wants ID 0, a legacy one-shot querier the ID it sent. One forwarded query
 *  can stand for several laptops' questions, so the ID is set per laptop. */
export function answerFor(packet: Buffer, target: Requester): Buffer {
  const id = target.port === MDNS_PORT ? 0 : target.id;
  return packet.readUInt16BE(0) === id ? packet : withDnsId(packet, id);
}

/** Copy of a query with the unicast-response ("QU") bit cleared in every
 *  question, so responders answer by multicast. A malformed question
 *  section is left as it is from that point on. */
export function withoutUnicastResponse(packet: Buffer): Buffer {
  if (packet.length < 12) return packet;
  const copy = Buffer.from(packet);
  const qdCount = copy.readUInt16BE(4);
  let offset = 12;
  for (let i = 0; i < qdCount && offset < copy.length; i++) {
    const { bytesRead } = readDnsName(copy, offset);
    const classAt = offset + bytesRead + 2;
    if (bytesRead === 0 || classAt + 2 > copy.length) break;
    copy.writeUInt16BE(copy.readUInt16BE(classAt) & 0x7fff, classAt);
    offset = classAt + 2;
  }
  return copy;
}

// ── Team IP helpers ─────────────────────────────────────────────────

/** Derive a team number from a 10.te.am.x source IP, or null if not a valid team VLAN IP. */
function ipToTeam(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts[0] !== '10') return null;
  const te = parseInt(parts[1], 10);
  const am = parseInt(parts[2], 10);
  if (isNaN(te) || isNaN(am) || am > 99) return null;
  const team = te * 100 + am;
  return team > 0 ? team : null;
}

// ── MdnsReflector ───────────────────────────────────────────────────

/** An answer waiting to go back to a laptop. */
type Outbound = { packet: Buffer; address: string; port: number; label: string };

/** A station's pinned socket, or why it couldn't be opened (retried later). */
type StationSocket =
  | { kind: 'open'; ifname: string; socket: InterfaceSocket }
  | { kind: 'failed'; ifname: string; at: number };

/** How long before a station socket that failed to open is tried again. */
const REOPEN_AFTER_MS = 30_000;

export class MdnsReflector {
  private socket: dgram.Socket | null = null;
  /** Teams with a station on the field (rebuilt in refreshMemberships). A
   *  packet from one of their subnets on the shared socket is the robot
   *  side: its station's socket handles it. */
  private activeTeams = new Set<number>();
  private stationSockets = new Map<StationName, StationSocket>();
  /** Per-station counters and recent names for reflected packets */
  private counters = new Map<StationName, StationMdnsActivity>();
  /** IPs/ranges to exclude from requester tracking */
  private readonly excludedRequesters: IpMatcher[];

  /** Answers go out one at a time (see flushSendQueue). */
  private sendQueue: Outbound[] = [];
  private sendInFlight = false;
  /** Questions forwarded to a VLAN and still waiting for their answers. */
  private readonly pending = new PendingQueries();
  private pruneTimer: NodeJS.Timeout | null = null;
  private unavailableLogged = false;

  constructor(
    private readonly getTeamForStation: (station: StationName) => number | null,
    private readonly getStationForRequester: (ip: string) => StationName | null,
    /** The bridge interface of a station ("br-slot1"). */
    private readonly bridgeOf: (station: StationName) => string,
    excludeRequesters?: string,
    /** Additional interface IPs to join multicast on (e.g. guest WiFi VLAN). */
    private readonly listenInterfaces: string[] = [],
    /** Opens a station's pinned socket; the native addon in production. */
    private readonly openSocket: typeof openInterfaceSocket = openInterfaceSocket,
  ) {
    this.excludedRequesters = excludeRequesters ? parseExcludeList(excludeRequesters) : [];
    if (this.excludedRequesters.length > 0) {
      console.log(`mDNS: excluding requesters matching ${excludeRequesters}`);
    }
  }

  /** Get the current activity state for broadcasting to clients. */
  getActivity(): MdnsActivity {
    const stations: MdnsActivity['stations'] = {};
    for (const [station, activity] of this.counters) {
      stations[station] = { ...activity, recentNames: [...activity.recentNames] };
    }
    return { type: 'mdnsActivity', stations };
  }

  start(): void {
    if (this.socket) return;

    // The laptop side: queries from team laptops arrive here, and answers go
    // back to them from here (unicast, from :5353 on their own subnet).
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', err => {
      console.error('mDNS reflector error:', err);
    });

    socket.on('message', (msg, rinfo) => {
      this.handleLaptopPacket(msg, rinfo);
    });

    socket.bind(MDNS_PORT, () => {
      // Join mDNS multicast on the default interface (main network).
      socket.addMembership(MDNS_ADDR);
      socket.setMulticastLoopback(false);
      socket.setMulticastTTL(255); // mDNS spec requires TTL=255
      socket.setTTL(255); // same for the unicast answers we hand back to laptops

      // Join multicast on additional interfaces (e.g. guest WiFi VLAN)
      // so we can receive mDNS queries from laptops on those networks.
      for (const ip of this.listenInterfaces) {
        try {
          socket.addMembership(MDNS_ADDR, ip);
          console.log(`mDNS: listening on ${ip}`);
        } catch (err) {
          console.error(`mDNS: failed to join multicast on ${ip}:`, err);
        }
      }

      console.log('mDNS reflector started on port', MDNS_PORT);
      this.refreshMemberships();
    });

    this.socket = socket;
    this.pruneTimer = setInterval(() => {
      this.pending.prune();
      this.reopenFailedSockets();
    }, PENDING_QUERY_TTL_MS);
    this.pruneTimer.unref();
  }

  stop(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    for (const station of [...this.stationSockets.keys()]) this.closeStationSocket(station);
    this.activeTeams.clear();
    this.sendQueue.length = 0;
    this.sendInFlight = false;
    console.log('mDNS reflector stopped');
  }

  /** Call when station config changes (and after the bridges are up): opens,
   *  keeps or closes each station's pinned socket. */
  refreshMemberships(): void {
    if (!this.socket) return;

    this.activeTeams.clear();
    for (const station of StationNameList) {
      const team = this.getTeamForStation(station);
      if (team === null) {
        this.closeStationSocket(station);
        this.counters.delete(station);
        continue;
      }
      this.activeTeams.add(team);
      const ifname = this.bridgeOf(station);
      const have = this.stationSockets.get(station);
      if (have?.kind === 'open' && have.ifname === ifname) continue;
      this.closeStationSocket(station);
      this.openStationSocket(station, ifname);
    }
    for (const [station, entry] of this.counters) {
      if (entry.team !== this.getTeamForStation(station)) this.counters.delete(station);
    }
  }

  // ── The robot side: one pinned socket per station ──────────────────

  private openStationSocket(station: StationName, ifname: string, { quiet = false } = {}): void {
    try {
      const socket = this.openSocket(ifname, MDNS_PORT, (data, address) =>
        this.handleRobotPacket(station, data, address),
      );
      this.stationSockets.set(station, { kind: 'open', ifname, socket });
      console.log(`mDNS: ${station} uses its own socket on ${ifname} (ifindex ${socket.ifindex})`);
    } catch (err) {
      this.stationSockets.set(station, { kind: 'failed', ifname, at: Date.now() });
      const msg = (err as Error).message;
      if (mdnsSocketUnavailable()) {
        // No addon: no robot-side mDNS at all. Say so once, loudly.
        if (!this.unavailableLogged) console.error(`mDNS: robot networks unreachable — ${msg}`);
        this.unavailableLogged = true;
      } else if (!quiet) {
        // The bridge isn't up yet (cold start), most likely: retried.
        console.warn(`mDNS: can't open a socket on ${ifname} for ${station} (${msg}) — retrying`);
      }
    }
  }

  private closeStationSocket(station: StationName): void {
    const entry = this.stationSockets.get(station);
    this.stationSockets.delete(station);
    if (entry?.kind === 'open') entry.socket.close();
  }

  private reopenFailedSockets(now = Date.now()): void {
    for (const [station, entry] of [...this.stationSockets]) {
      if (entry.kind !== 'failed' || now - entry.at < REOPEN_AFTER_MS) continue;
      if (this.getTeamForStation(station) === null) {
        this.stationSockets.delete(station);
        continue;
      }
      this.openStationSocket(station, entry.ifname, { quiet: true });
    }
  }

  /** A packet on a station's bridge: an answer goes to the laptop(s) whose
   *  question was forwarded to this station; anything else is dropped. */
  private handleRobotPacket(station: StationName, msg: Buffer, address: string): void {
    if (msg.length < 12 || (msg[2] & 0x80) === 0) return; // robots' own queries
    const team = this.getTeamForStation(station);
    if (team === null) return;
    const records = parseAnswerRecords(msg);
    const targets = this.pending.match(
      records.map(r => r.name),
      stationScope(station),
    );
    if (targets.length === 0) return; // an announcement nobody asked for
    const names: MdnsResolvedName[] = records.map(r => ({ name: r.name.toLowerCase(), resolvedIp: r.resolvedIp }));
    this.incrementCounter(station, team, 'responsesForwarded', names);
    for (const target of targets) {
      this.enqueueSend({
        packet: answerFor(msg, target),
        address: target.address,
        port: target.port,
        label: `answer from ${station} (${address}) → ${target.address}:${target.port}`,
      });
    }
  }

  // ── The laptop side: the shared socket ─────────────────────────────

  private handleLaptopPacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < 12) return;
    // The shared socket also sees robot-side traffic (it's bound to
    // 0.0.0.0:5353, and the host has joined the group on the bridges). The
    // station sockets handle that.
    const sourceTeam = ipToTeam(rinfo.address);
    if (sourceTeam !== null && this.activeTeams.has(sourceTeam)) return;
    if ((msg[2] & 0x80) !== 0) return; // answers from laptops aren't ours to forward

    const station = this.getStationForRequester(rinfo.address);
    if (!station) return; // Laptop hasn't selected a robot — nowhere to forward
    const team = this.getTeamForStation(station);
    const entry = this.stationSockets.get(station);
    if (team === null || entry?.kind !== 'open') return;

    const queryNames = parseQuestionNames(msg);
    if (queryNames.length === 0) return;

    if (!isExcluded(rinfo.address, this.excludedRequesters)) {
      const names: MdnsResolvedName[] = queryNames.map(n => ({ name: n.toLowerCase(), requester: rinfo.address }));
      this.incrementCounter(station, team, 'queriesForwarded', names);
    }

    // Remember who asked so the answer can come back to them alone
    this.pending.add(queryNames, stationScope(station), {
      address: rinfo.address,
      port: rinfo.port,
      id: msg.readUInt16BE(0),
    });
    try {
      // Multicast answers only: a unicast one would go to the gateway
      // address, where the drive session's DNAT hands it to the DS laptop.
      entry.socket.send(withoutUnicastResponse(msg));
    } catch (err) {
      console.error(`mDNS: failed to send (query → ${station}):`, err);
    }
  }

  /** Answers are sent one at a time, in order. */
  private enqueueSend(entry: Outbound): void {
    this.sendQueue.push(entry);
    this.flushSendQueue();
  }

  private flushSendQueue(): void {
    if (this.sendInFlight || this.sendQueue.length === 0 || !this.socket) return;
    this.sendInFlight = true;
    const entry = this.sendQueue.shift()!;
    this.socket.send(entry.packet, 0, entry.packet.length, entry.port, entry.address, err => {
      if (err) console.error(`mDNS: failed to send (${entry.label}):`, err);
      this.sendInFlight = false;
      this.flushSendQueue();
    });
  }

  private static readonly MAX_RECENT_NAMES = 10;

  private incrementCounter(
    station: StationName,
    team: number,
    field: 'queriesForwarded' | 'responsesForwarded',
    names: MdnsResolvedName[],
  ) {
    let entry = this.counters.get(station);
    if (!entry) {
      entry = { team, queriesForwarded: 0, responsesForwarded: 0, recentNames: [] };
      this.counters.set(station, entry);
    }
    entry[field]++;
    for (const incoming of names) {
      // Condense service discovery names: group by hostname, collect services
      const { hostname, service } = splitMdnsName(incoming.name);

      // Move to front if already present (merge fields), otherwise prepend
      const idx = entry.recentNames.findIndex(r => r.name === hostname);
      if (idx !== -1) {
        const existing = entry.recentNames.splice(idx, 1)[0];
        // Merge services list
        const services = existing.services ? [...existing.services] : [];
        if (service && !services.includes(service)) services.push(service);
        entry.recentNames.unshift({
          name: hostname,
          resolvedIp: incoming.resolvedIp ?? existing.resolvedIp,
          requester: incoming.requester ?? existing.requester,
          services: services.length > 0 ? services : undefined,
        });
      } else {
        entry.recentNames.unshift({
          name: hostname,
          resolvedIp: incoming.resolvedIp,
          requester: incoming.requester,
          services: service ? [service] : undefined,
        });
      }
    }
    if (entry.recentNames.length > MdnsReflector.MAX_RECENT_NAMES) {
      entry.recentNames.length = MdnsReflector.MAX_RECENT_NAMES;
    }
  }
}
