import net from 'net';
import dgram, { Socket } from 'dgram';
import { EventEmitter } from 'events';
import { Transform, TransformCallback } from 'stream';
import { BufferOverflowError, BufferReader, BufferWriter } from './BufferWrappers.js';
import { MatchSlot, StationName, Mode } from './types.js';

const DefaultTcpPort = 1750;
const DefaultUdpPort = 1160;
// Legacy NI DS control port. 1121 = official FMS: DS enters FMS control
// immediately. 1120 = offseason FMS: DS prompts the operator to approve FMS
// control first. https://frcture.readthedocs.io/en/latest/driverstation/fms_to_ds.html
// The 2027 FIRST Driver Station (SystemCore) instead advertises an ephemeral
// UDP port in its TCP handshake (0x1e) — see Ds2027TeamNumberMessage.
export const UdpSendPort = 1121;

/** Which Driver Station generation is on the other end of a DS address.
 *  - legacy: NI FRC Driver Station (roboRIO era). Handshake 0x18/0x19, control
 *    packets to fixed UDP 1121, game data as UDP tag 0x07.
 *  - ds2027: FIRST Driver Station 2027 (SystemCore). Handshake 0x1e/0x1f, the DS
 *    names its own UDP control port, game data as UDP tag 0x20.
 *  Reference: Team254/cheesy-arena field/driver_station_connection.go (PR #284). */
export type DsProtocol = 'legacy' | 'ds2027';

const DefaultAddress = '10.0.100.5';

type TeamNumberMessage = {
  type: 0x18;
  teamNumber: number;
};

/** 2027 FIRST Driver Station handshake. The DS tells the FMS which UDP port to
 *  send control packets to (it changes on every TCP reconnect) and sends its
 *  team number as length-prefixed ASCII. flags are currently always 0. */
type Ds2027TeamNumberMessage = {
  type: 0x1e;
  teamNumber: number;
  udpPort: number;
  flags: number;
};

type WPILibVersionMessage = {
  type: 0x00;
  version: string;
};

type RIOVersionMessage = {
  type: 0x01;
  version: string;
};

type DSVersionMessage = {
  type: 0x02;
  version: string;
};

type PDPVersionMessage = {
  type: 0x03;
  version: string;
};

type PCMVersionMessage = {
  type: 0x04;
  version: string;
};

type CANJagVersionMessage = {
  type: 0x05;
  version: string;
};

type CANTalonVersionMessage = {
  type: 0x06;
  version: string;
};

type ThirdPartyDeviceVersionMessage = {
  type: 0x07;
  version: string;
};

type UsageReportMessage = {
  type: 0x15;
  teamNumber: number;
  unknown: number;
  entries: Buffer; // TODO: Parse this into a more meaningful structure
};

type CommonFlags = {
  teleOp: boolean;
  auto: boolean;
  disable: boolean;
};

type Status = {
  brownout: boolean;
  watchdog: boolean;
  ds: CommonFlags;
  robot: CommonFlags;
};

export type LogDataMessage = {
  type: 0x16;
  roundTripTime: number;
  lostPackets: number;
  /** Robot battery voltage, or undefined when the robot isn't connected to the
   *  DS (the DS then reports the 0xFFFF sentinel — see parseBatteryVoltage). */
  voltage: number | undefined;
  status: Status;
  CAN: number;
  SignalDb: number;
  bandwidth: number;
};

type ErrorAndEventDataMessage = {
  type: 0x17;
  messageCount: number;
  timestamp: number;
  unknown: Buffer;
  message: string;
};

type ChallengeResponseMessage = {
  type: 0x1b;
  response: string;
};

type DSPingMessage = {
  type: 0x1c;
};

export type DSMessage =
  | TeamNumberMessage
  | Ds2027TeamNumberMessage
  | WPILibVersionMessage
  | RIOVersionMessage
  | DSVersionMessage
  | PDPVersionMessage
  | PCMVersionMessage
  | CANJagVersionMessage
  | CANTalonVersionMessage
  | ThirdPartyDeviceVersionMessage
  | UsageReportMessage
  | LogDataMessage
  | ErrorAndEventDataMessage
  | ChallengeResponseMessage
  | DSPingMessage;

/**
 * Convert the raw 16-bit battery-voltage field (fixed-point, /256) to volts.
 * A disconnected robot's DS reports 0xFFFF as a "no reading" sentinel; that
 * would otherwise decode to 255.996V and display as "256.0V". Return undefined
 * in that case so downstream telemetry omits the value rather than charting it.
 */
function parseBatteryVoltage(raw: number): number | undefined {
  if (raw === 0xffff) return undefined;
  return raw / 256;
}

function byteToStatus(byte: number): Status {
  return {
    brownout: Boolean(byte & 0x80),
    watchdog: Boolean(byte & 0x40),
    ds: {
      teleOp: Boolean(byte & 0x20),
      auto: Boolean(byte & 0x10),
      disable: Boolean(byte & 0x08),
    },
    robot: {
      teleOp: Boolean(byte & 0x04),
      auto: Boolean(byte & 0x02),
      disable: Boolean(byte & 0x01),
    },
  };
}

// Unknown DS TCP message types are skipped — frames are length-prefixed, so
// parsing stays in sync. Log each new type once with its payload so it can be
// identified later (a DS started sending type 0x1d on 2026-07-17, which used
// to raise a parse error every ~3s).
const loggedUnknownTypes = new Set<number>();

export function parseIncomingTcpMessage(data: Buffer): DSMessage | null {
  const r = new BufferReader(data);

  const type = r.readNumber(1);

  switch (type) {
    case 0x00: // WPILib version
    case 0x01: // roboRIO version
    case 0x02: // DS version
    case 0x03: // PDP version
    case 0x04: // PCM version
    case 0x05: // CANJag version
    case 0x06: // CANTalon version
    case 0x07: // Third-party device version
      return { type, version: r.readString() } as DSMessage;
    case 0x15:
      return { type, teamNumber: r.readNumber(2), unknown: r.readNumber(1), entries: r.readSlice() };
    case 0x16:
      return {
        type,
        roundTripTime: r.readNumber(1),
        lostPackets: r.readNumber(1),
        voltage: parseBatteryVoltage(r.readNumber(2)),
        status: byteToStatus(r.readNumber(1)),
        CAN: r.readNumber(1) * 2,
        SignalDb: r.readNumber(1) * 2,
        bandwidth: r.readNumber(2) / 256,
      };
    case 0x17:
      return {
        type,
        messageCount: r.readNumber(4),
        timestamp: r.readNumber(8),
        unknown: r.readSlice(8),
        message: r.readString(),
      };
    case 0x18:
      return { type, teamNumber: r.readNumber(2) };
    case 0x1e: {
      // [udpPort:2] [flags:1] [teamLen:1] [team ASCII…]
      const udpPort = r.readNumber(2);
      const flags = r.readNumber(1);
      const teamNumber = Number.parseInt(r.readString(r.readNumber(1)), 10);
      if (!Number.isInteger(teamNumber) || teamNumber < 0 || teamNumber > 0xffff || udpPort === 0) {
        console.log(`Malformed 2027 DS handshake: ${data.toString('hex')}`);
        return null;
      }
      return { type, teamNumber, udpPort, flags };
    }
    case 0x1b:
      return { type, response: r.readString() };
    case 0x1c:
      return { type };
    default:
      if (!loggedUnknownTypes.has(type)) {
        loggedUnknownTypes.add(type);
        console.log(`Ignoring unknown DS TCP message type ${type} (0x${type.toString(16)}): ${data.toString('hex')}`);
      }
      return null;
  }
}

class ByteToObjectTransform extends Transform {
  constructor() {
    super({ readableObjectMode: true });
  }

  private unprocessed: Buffer[] = [];

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.unprocessed.push(chunk);

    // Combine all chunks into a single buffer
    let buff = new BufferReader(Buffer.concat(this.unprocessed));

    try {
      while (buff.remaining >= 2) {
        const data = buff.readSizedBuffer(2);

        const parsed = parseIncomingTcpMessage(data);
        // Never push(null) — that would end the object stream
        if (parsed) this.push(parsed);
      }
    } catch (err) {
      if (err instanceof BufferOverflowError) return;
      console.error('Error parsing TCP message:', err);
    } finally {
      this.unprocessed = [buff.readSlice()];
      callback();
    }
  }
}

type FieldRadioMetrics = {
  type: 'field';
  signalStrength: number;
  bandwidthUtilization: number;
};
type CommsMetrics = {
  lostPackets: number;
  sentPackets: number;
  averageRoundTripTime: number;
};
type LaptopMetrics = {
  batteryPercent: number;
  cpuPercent: number;
};
type RobotRadioMetrics = {
  type: 'robot';
  signalStrength: number;
  bandwidthUtilization: number;
};
type PDInfo = {
  type: 'pd';
};

type Metrics = FieldRadioMetrics | CommsMetrics | LaptopMetrics | RobotRadioMetrics | PDInfo;

type Tags = Metrics[];

export type DsStatus = {
  EStop: boolean;
  AStop: boolean;
  robotComms: boolean;
  radioPing: boolean;
  rioPing: boolean;
  enabled: boolean;
  mode: Mode;
};

function byteToDsStatus(byte: number): DsStatus {
  const modeN = byte & 0x03;

  return {
    EStop: Boolean(byte & 0x80),
    AStop: Boolean(byte & 0x40),
    robotComms: Boolean(byte & 0x20),
    radioPing: Boolean(byte & 0x10),
    rioPing: Boolean(byte & 0x08),
    enabled: Boolean(byte & 0x04),
    mode: ['teleOp', 'test', 'auto'][modeN] as Mode,
  };
}

export type UdpMessage = {
  sequence: number;
  commVersion: number;
  status: DsStatus;
  teamNumber: number;
  /** Robot battery voltage, or undefined when the robot isn't connected to the
   *  DS (the DS then reports the 0xFFFF sentinel — see parseBatteryVoltage). */
  BatteryVoltage: number | undefined;
  tags: Tags;
};

// Log each unknown / oversized UDP status tag once with its payload so a new
// DS generation's extra tags can be identified without flooding journald.
const loggedUnknownUdpTags = new Set<number>();
const loggedTrailingUdpTags = new Set<number>();

function parseIncomingUdpMessage(buff: Buffer): UdpMessage {
  const r = new BufferReader(buff);
  const sequence = r.readNumber(2);
  const commVersion = r.readNumber(1);
  const status = byteToDsStatus(r.readNumber(1));
  const teamNumber = r.readNumber(2);
  const BatteryVoltage = parseBatteryVoltage(r.readNumber(2));
  const tags: Tags = [];

  while (r.remaining > 0) {
    const size = r.readNumber(1);
    if (size === 0) throw new Error('Size is 0');

    const tagBuff = r.readSlice(size);

    const t = new BufferReader(tagBuff);

    const tagType = t.readNumber(1);

    switch (tagType) {
      case 0x00:
        tags.push({ type: 'field', signalStrength: t.readNumber(1), bandwidthUtilization: t.readNumber(2) });
        break;
      case 0x01:
        tags.push({
          lostPackets: t.readNumber(2),
          sentPackets: t.readNumber(2),
          averageRoundTripTime: t.readNumber(1),
        });
        break;
      case 0x02:
        tags.push({ batteryPercent: t.readNumber(1), cpuPercent: t.readNumber(1) });
        break;
      case 0x03:
        tags.push({ type: 'robot', signalStrength: t.readNumber(1), bandwidthUtilization: t.readNumber(2) });
        break;
      case 0x04:
        tags.push({ type: 'pd' });
        break;
      default:
        if (!loggedUnknownUdpTags.has(tagType)) {
          loggedUnknownUdpTags.add(tagType);
          console.log(`Unknown DS UDP status tag ${tagType} (0x${tagType.toString(16)}): ${buff.toString('hex')}`);
        }
    }

    if (t.remaining && !loggedTrailingUdpTags.has(tagType)) {
      loggedTrailingUdpTags.add(tagType);
      console.log(`${t.remaining} trailing byte(s) in DS UDP status tag ${tagType}: ${buff.toString('hex')}`);
    }
  }

  return {
    sequence,
    commVersion,
    status,
    teamNumber,
    BatteryVoltage,
    tags,
  };
}

type Events = {
  message: [{ address: string; port: number; data: DSMessage | UdpMessage }];
  dsConnected: [{ address: string }];
  dsDisconnected: [{ address: string }];
  /** Inbound command: close all TCP connections from this DS address. The DS
   *  reconnects and re-sends its 0x18 handshake within seconds, picking up the
   *  current station-assignment answer — this is how join/leave hands the DS
   *  to the FMS (0x19 reply locks out local enable) or releases it (no reply). */
  disconnectDS: [{ address: string }];
};

export async function startFMSServer({
  address = DefaultAddress,
  tcp = DefaultTcpPort,
  udp = DefaultUdpPort,
  resolveTeamSlot,
}: {
  address?: string;
  tcp?: number;
  udp?: number;
  /** Map a team number to its alliance slot for the TCP station-assignment reply.
   *  Return undefined to send NO reply: answering the handshake flips the DS into
   *  FMS-controlled mode (local enable locked out), so only resolve teams whose
   *  station has joined a match — or is opted in via FMS_TCP_REPLY_STATIONS to
   *  test that lockout hypothesis on a single robot. */
  resolveTeamSlot?: (teamNumber: number) => MatchSlot | undefined;
} = {}) {
  return new Promise<EventEmitter<Events>>((resolve, reject) => {
    let udpServer: Socket;

    // Track active TCP connections per IP so we only emit dsDisconnected when the
    // last connection from an IP closes (avoids removing DNAT rules prematurely
    // when a DS reconnects before the old TCP connection times out).
    const tcpConnections = new Map<string, number>();
    // Live sockets per IP, so the disconnectDS command can force a re-handshake
    const socketsByAddr = new Map<string, Set<net.Socket>>();

    // Log dampening: a DS that never completes the station-assignment handshake
    // (or can't reach its station) cycles TCP every ~6s. Log the first connect,
    // then suppress reconnects within CHURN_WINDOW_MS of a close, summarizing at
    // most once per CHURN_SUMMARY_MS per address.
    const CHURN_WINDOW_MS = 30_000;
    const CHURN_SUMMARY_MS = 5 * 60_000;
    const churnByAddr = new Map<string, { lastClose: number; suppressed: number; lastReport: number }>();
    // Last handshake outcome logged per address (team, DS generation, reply
    // slot), so steady re-handshakes aren't re-logged but every change is.
    const lastLoggedHandshake = new Map<string, string>();
    // Unparseable UDP status packets per source address (first one is logged)
    const badUdpByAddr = new Map<string, number>();

    const tcpServer = net.createServer(socket => {
      const rawAddr = socket.remoteAddress || '';
      const addr = rawAddr.replace(/^::ffff:/, '');
      tcpConnections.set(addr, (tcpConnections.get(addr) ?? 0) + 1);
      let sockets = socketsByAddr.get(addr);
      if (!sockets) socketsByAddr.set(addr, (sockets = new Set()));
      sockets.add(socket);

      // Reap dead NAT'd connections — a DS that vanishes without FIN otherwise
      // stays ESTAB forever and inflates the per-address connection count.
      socket.setKeepAlive(true, 30_000);

      const now = Date.now();
      const churn = churnByAddr.get(addr);
      // Whether this connection's lifecycle gets its own log lines (suppressed for rapid reconnects)
      let logConnection = true;
      if (churn && now - churn.lastClose < CHURN_WINDOW_MS) {
        logConnection = false;
        churn.suppressed++;
        if (now - churn.lastReport >= CHURN_SUMMARY_MS) {
          const minutes = Math.max(1, Math.round((now - churn.lastReport) / 60_000));
          console.log(`DS ${addr}: ${churn.suppressed} rapid reconnects in the last ${minutes}m`);
          churn.suppressed = 0;
          churn.lastReport = now;
        }
      } else {
        console.log(`DS connected: ${addr}`);
        churnByAddr.set(addr, { lastClose: 0, suppressed: 0, lastReport: now });
      }
      emitter.emit('dsConnected', { address: addr });

      const transformer = new ByteToObjectTransform();
      socket.pipe(transformer).on('data', (obj: DSMessage) => {
        if (obj.type === 0x18 || obj.type === 0x1e) {
          // Team number handshake. Only reply with the station assignment (0x19,
          // or 0x1f for the 2027 DS) when the resolver grants one (station joined
          // a match): the reply puts the DS in FMS-controlled mode, locking out
          // local enable. Freeplay DSes get no reply and keep local control —
          // they retry TCP every ~6s, which the churn dampener below keeps out
          // of the logs.
          const slot = resolveTeamSlot?.(obj.teamNumber);
          if (slot) {
            socket.write(makeStationAssignment(obj, slot));
          }
          const key = `${obj.teamNumber}|${obj.type}|${slot ?? ''}`;
          if (lastLoggedHandshake.get(addr) !== key) {
            lastLoggedHandshake.set(addr, key);
            const gen = obj.type === 0x1e ? ` (2027 DS, control UDP ${obj.udpPort}, flags ${obj.flags})` : '';
            const reply = slot
              ? ` → assigned ${slot} (reply 0x${obj.type === 0x1e ? '1f' : '19'})`
              : ' (no reply: not joined)';
            console.log(`DS at ${addr}: team ${obj.teamNumber}${gen}${reply}`);
          }
        } else if (process.env.FMS_LOG_DS_MESSAGES) {
          // Full per-message dumps flood journald into rate-limiting (~11k
          // suppressed msgs/30s on 2026-07-17), destroying the useful logs.
          console.log('Received object from TCP stream:', obj);
        }
        emitter.emit('message', { address: rawAddr, port: tcp, data: obj });
      });

      socket.on('close', () => {
        const s = socketsByAddr.get(addr);
        if (s) {
          s.delete(socket);
          if (s.size === 0) socketsByAddr.delete(addr);
        }
        const c = churnByAddr.get(addr);
        if (c) c.lastClose = Date.now();
        const remaining = (tcpConnections.get(addr) ?? 1) - 1;
        if (remaining <= 0) {
          tcpConnections.delete(addr);
          if (logConnection) console.log(`DS disconnected: ${addr}`);
          emitter.emit('dsDisconnected', { address: addr });
        } else {
          tcpConnections.set(addr, remaining);
          if (logConnection) console.log(`DS connection closed: ${addr} (${remaining} remaining)`);
        }
      });

      socket.on('error', err => {
        console.error(`Error with ${socket.remoteAddress}:`, err);
      });
    });

    function error(err: any) {
      tcpServer.close();
      udpServer?.close();
      reject(err);
    }

    const emitter = new EventEmitter<Events>();

    emitter.on('disconnectDS', ({ address }) => {
      const sockets = socketsByAddr.get(address);
      if (!sockets?.size) return;
      console.log(`Closing ${sockets.size} TCP connection(s) to DS ${address} to force a fresh handshake`);
      for (const socket of [...sockets]) socket.destroy();
    });

    tcpServer.on('error', error);

    tcpServer.listen(tcp, address, () => {
      console.log(`FMS server listening on TCP ${address}:${tcp}`);
      udpServer = dgram.createSocket('udp4');

      udpServer.on('message', (msg, rinfo) => {
        if (process.env.FMS_LOG_DS_MESSAGES) {
          console.log(`UDP message from ${rinfo.address}:${rinfo.port}:`, msg.toString('hex'));
        }

        let message: UdpMessage;
        try {
          message = parseIncomingUdpMessage(msg);
        } catch (err) {
          // A DS generation we don't fully understand must not take the FMS
          // down. Log the first bad packet per address with its payload.
          const bad = badUdpByAddr.get(rinfo.address) ?? 0;
          badUdpByAddr.set(rinfo.address, bad + 1);
          if (bad === 0) {
            console.log(
              `Unparseable DS UDP status from ${rinfo.address}:${rinfo.port} (${(err as Error).message}): ${msg.toString('hex')}`,
            );
          } else if (bad % 1000 === 0) {
            console.log(`Unparseable DS UDP status from ${rinfo.address}: ${bad} so far`);
          }
          return;
        }

        emitter.emit('message', { address: rinfo.address, port: udp, data: message });
      });

      udpServer.on('error', error);

      udpServer.bind(udp, address, () => {
        console.log(`UDP server listening on ${address}:${udp}`);

        tcpServer.removeListener('error', error);
        tcpServer.on('error', err => {
          console.error('TCP server error:', err);
          error(err);
        });
        resolve(emitter);
      });
    });
  });
}

export async function runFMS(options: Parameters<typeof startFMSServer>[0] = {}) {
  return startFMSServer(options).catch(err => {
    if ('code' in err && 'address' in err && err.code === 'EADDRNOTAVAIL') {
      console.log(`Bind to ${err.address} to enable FMS server`);
      return;
    }
    console.log('Failed to start FMS server:');
    console.log(err);
  });
}

export class Control {
  constructor(
    public eStop: boolean,
    public enabled: boolean,
    public mode: Mode,
  ) {}
  get bits() {
    return (this.eStop ? 0x80 : 0) | (this.enabled ? 0x04 : 0) | ['teleOp', 'test', 'auto'].indexOf(this.mode);
  }
}

type TournamentLevel = 'Match Test' | 'Practice' | 'Qualification' | 'Playoff';

/** Tags sent from FMS to DS (different from DS→FMS metrics tags). */
export type OutboundTag = { type: 'gameData'; data: string };

type DsPacket = {
  sequence: number;
  control: Control;
  /** Match position (red1-blue3), NOT physical station name (slot1-slot6). */
  allianceStation: MatchSlot;
  tournamentLevel: TournamentLevel;
  matchNumber: number;
  playNumber: number;
  matchTime: Date;
  remainingTime: number;
  tags: OutboundTag[];
  /** Which DS generation the packet is for — selects the game data tag id. */
  protocol?: DsProtocol;
};

function allianceStationFromName(station: MatchSlot): number {
  return ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'].indexOf(station);
}

/**
 * Station-assignment reply to a DS team-number handshake. Status 0 = accepted.
 *  - legacy 0x18 → 0x19: [size:2=3] [0x19] [station] [status]
 *  - 2027   0x1e → 0x1f: [size:2=6] [0x1f] [station] [status] [flags] [team:2]
 * flags bit0 = "lite" (DS asks the operator before handing control to the
 * FMS). Left clear: pFMS asserts control the same way the official FMS does.
 */
export function makeStationAssignment(handshake: TeamNumberMessage | Ds2027TeamNumberMessage, slot: MatchSlot): Buffer {
  const station = allianceStationFromName(slot);
  if (handshake.type === 0x18) return Buffer.from([0x00, 0x03, 0x19, station, 0]);
  const team = handshake.teamNumber;
  return Buffer.from([0x00, 0x06, 0x1f, station, 0, 0, (team >> 8) & 0xff, team & 0xff]);
}

function tournamentLevelToByte(level: TournamentLevel): number {
  return ['Match Test', 'Practice', 'Qualification', 'Playoff'].indexOf(level);
}

function dateToBuffer(date: Date): Buffer {
  const buff = new BufferWriter(Buffer.allocUnsafe(10));
  buff.writeNumber(4, date.getMilliseconds() * 1000);
  buff.writeNumber(1, date.getSeconds());
  buff.writeNumber(1, date.getMinutes());
  buff.writeNumber(1, date.getHours());
  buff.writeNumber(1, date.getDate());
  buff.writeNumber(1, date.getMonth());
  buff.writeNumber(1, date.getFullYear() - 1900);
  return buff.buffer;
}

/** The 2027 DS reads at most this many game data characters (per Cheesy Arena). */
const Ds2027GameDataMaxBytes = 8;

function makeTagsBuffers(tags: OutboundTag[], protocol: DsProtocol): Buffer[] {
  const buffers: Buffer[] = [];
  for (const tag of tags) {
    if (tag.type === 'gameData') {
      let data = Buffer.from(tag.data, 'utf-8');
      if (protocol === 'ds2027') data = data.subarray(0, Ds2027GameDataMaxBytes);
      // Format: [size] [tag_id] [data...]
      // size includes the tag_id byte. Tag id 0x07 for the legacy DS, 0x20 for the 2027 DS.
      const header = Buffer.alloc(2);
      header[0] = data.length + 1; // size = tag_id + data
      header[1] = protocol === 'ds2027' ? 0x20 : 0x07;
      buffers.push(header, data);
    }
  }
  return buffers;
}

export function makeDSPacket(data: DsPacket): Buffer {
  const main = new BufferWriter(Buffer.allocUnsafe(22));

  const CommVersion = 0x00;
  const Request = 0x00;

  main.writeNumber(2, data.sequence);
  main.writeNumber(1, CommVersion);
  main.writeNumber(1, data.control.bits);
  main.writeNumber(1, Request);
  main.writeNumber(1, allianceStationFromName(data.allianceStation));
  main.writeNumber(1, tournamentLevelToByte(data.tournamentLevel));
  main.writeNumber(2, data.matchNumber);
  main.writeNumber(1, data.playNumber);
  main.writeBuffer(dateToBuffer(data.matchTime));
  main.writeNumber(2, data.remainingTime);

  if (main.remaining) throw new Error(`Main buffer has ${main.remaining} bytes remaining`);

  return Buffer.concat([main.buffer, ...makeTagsBuffers(data.tags, data.protocol ?? 'legacy')]);
}
