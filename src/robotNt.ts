/**
 * A read-only look at a robot's NetworkTables 4 server (roboRIO :5810): is
 * robot code running, which dashboards are connected, and what match info the
 * robot's code received from its Driver Station (`/FMSInfo/`). The last one
 * checks the whole path pFMS → DS → robot code, where pFMS otherwise sees only
 * that the DS got it.
 *
 * Each reading is a short visit: connect pinned to the station's bridge,
 * subscribe to `$clients` and `/FMSInfo/` only (a few hundred bytes), wait for
 * the values, hang up. Nothing is published. pFMS reads only while someone has
 * the Network page open (RobotNtReader caches each robot for a few seconds).
 */
import { decodeAll, type MsgpackValue } from './msgpack.js';
import type { InterfaceTcpConnection, TcpEvent } from './mdnsSocket.js';
import type { RobotFmsInfo, RobotNtReading, StationName } from './types.js';
import { WebSocketClient } from './webSocketClient.js';

export const NT4_PORT = 5810;
/** pFMS's name in the robot's `$clients`; the server may add `@N`. */
export const NT_CLIENT_NAME = 'pFMS';

export type ConnectTcp = (
  ifname: string,
  address: string,
  port: number,
  timeoutMs: number,
  onEvent: (kind: TcpEvent, data: Buffer | undefined, message: string) => void,
) => InterfaceTcpConnection;

export interface ReadOptions {
  connectTimeoutMs?: number;
  /** After subscribing, how long to wait for values that may never come. */
  settleMs?: number;
}

type Result = Pick<RobotNtReading, 'code' | 'error' | 'clients' | 'fms'>;

const FMS_TOPICS: Record<string, keyof RobotFmsInfo> = {
  '/FMSInfo/EventName': 'eventName',
  '/FMSInfo/MatchType': 'matchType',
  '/FMSInfo/MatchNumber': 'matchNumber',
  '/FMSInfo/ReplayNumber': 'replayNumber',
  '/FMSInfo/IsRedAlliance': 'isRedAlliance',
  '/FMSInfo/StationNumber': 'stationNumber',
  '/FMSInfo/FMSControlData': 'controlData',
  '/FMSInfo/GameSpecificMessage': 'gameMessage',
};

/** Read one robot. Never rejects: failures are in the result. */
export function readRobotNt(
  connect: ConnectTcp,
  ifname: string,
  ip: string,
  { connectTimeoutMs = 2_000, settleMs = 1_500 }: ReadOptions = {},
): Promise<Result> {
  return new Promise(resolve => {
    const topics = new Map<number, string>();
    const values = new Map<string, MsgpackValue>();
    let opened = false;
    let done = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Covers a server that accepts the connection but never answers the handshake
    const deadline = setTimeout(() => finish('The robot stopped answering'), connectTimeoutMs + settleMs + 2_000);

    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      clearTimeout(deadline);
      ws.close();
      conn?.close();
      resolve(opened ? { code: 'running', ...collect(values), ...(error ? { error } : {}) } : notOpened(error));
    };
    /** Never got as far as NT: what does that say about the robot? */
    const notOpened = (error = 'no answer'): Result => {
      if (/refused/i.test(error)) return { code: 'not running', error: 'Nothing is listening on 5810' };
      // Something answered on 5810, just not NT4 (an old NT3-only server, say)
      if (connected) return { code: 'running', error };
      return { code: 'unreachable', error };
    };

    let connected = false;
    let conn: InterfaceTcpConnection | undefined;
    const ws = new WebSocketClient(
      { write: data => conn?.write(data), close: () => conn?.close() },
      {
        host: `${ip}:${NT4_PORT}`,
        path: `/nt/${NT_CLIENT_NAME}`,
        protocols: ['v4.1.networktables.first.wpi.edu', 'networktables.first.wpi.edu'],
      },
      {
        onOpen: () => {
          opened = true;
          ws.sendText(
            JSON.stringify([
              { method: 'subscribe', params: { topics: ['$clients'], subuid: 1, options: {} } },
              { method: 'subscribe', params: { topics: ['/FMSInfo/'], subuid: 2, options: { prefix: true } } },
            ]),
          );
          settle = setTimeout(() => finish(), settleMs);
        },
        onText: text => {
          for (const msg of parseJsonArray(text)) {
            if (
              msg?.method === 'announce' &&
              typeof msg.params?.id === 'number' &&
              typeof msg.params.name === 'string'
            ) {
              topics.set(msg.params.id, msg.params.name);
            }
          }
        },
        onBinary: data => {
          for (const msg of decodeAll(data)) {
            if (!Array.isArray(msg) || msg.length < 4 || typeof msg[0] !== 'number') continue;
            const name = topics.get(msg[0]);
            if (name) values.set(name, msg[3]);
          }
          if (values.has('$clients') && values.has('/FMSInfo/StationNumber') && values.has('/FMSInfo/IsRedAlliance')) {
            finish();
          }
        },
        onClose: reason => finish(reason),
      },
    );

    try {
      conn = connect(ifname, ip, NT4_PORT, connectTimeoutMs, (kind, data, message) => {
        if (kind === 'connect') {
          connected = true;
          ws.open();
        } else if (kind === 'data' && data) ws.receive(data);
        else if (kind === 'end') finish(opened ? 'The robot closed the connection' : 'The robot hung up');
        else if (kind === 'error') finish(message);
      });
    } catch (err) {
      clearTimeout(deadline);
      done = true;
      resolve({ code: 'unreachable', error: (err as Error).message });
    }
  });
}

interface NtJsonMessage {
  method?: string;
  params?: { id?: unknown; name?: unknown };
}

function parseJsonArray(text: string): NtJsonMessage[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as NtJsonMessage[]) : [];
  } catch {
    return [];
  }
}

function collect(values: Map<string, MsgpackValue>): Pick<RobotNtReading, 'clients' | 'fms'> {
  const out: Pick<RobotNtReading, 'clients' | 'fms'> = {};
  // Meta topics have type "msgpack": the value is the packed bytes
  let clients = values.get('$clients');
  if (clients instanceof Uint8Array) {
    try {
      clients = decodeAll(clients)[0] ?? null;
    } catch {
      clients = null;
    }
  }
  if (Array.isArray(clients)) {
    out.clients = clients
      .filter((c): c is { [key: string]: MsgpackValue } => !!c && typeof c === 'object' && !Array.isArray(c))
      .map(c => ({ name: String(c.id ?? ''), address: String(c.conn ?? '') }))
      .filter(c => c.name !== NT_CLIENT_NAME && !c.name.startsWith(`${NT_CLIENT_NAME}@`));
  }
  const fms: RobotFmsInfo = {};
  for (const [topic, field] of Object.entries(FMS_TOPICS)) {
    const v = values.get(topic);
    if (v === undefined || v === null) continue;
    if (typeof v === 'bigint') (fms as Record<string, unknown>)[field] = Number(v);
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      (fms as Record<string, unknown>)[field] = v;
    }
  }
  if (Object.keys(fms).length) out.fms = fms;
  return out;
}

/**
 * Readings on demand, cached per station for `minIntervalMs`, with one visit
 * at a time per robot however many viewers ask.
 */
export class RobotNtReader {
  private cache = new Map<string, { reading: RobotNtReading | null; pending: Promise<RobotNtReading> | null }>();

  constructor(
    private connect: ConnectTcp,
    private opts: ReadOptions & { minIntervalMs?: number } = {},
  ) {}

  read(station: StationName, team: number, ifname: string, ip: string, now = Date.now()): Promise<RobotNtReading> {
    const id = `${station}|${team}|${ifname}|${ip}`;
    let entry = this.cache.get(id);
    if (!entry) this.cache.set(id, (entry = { reading: null, pending: null }));
    if (entry.pending) return entry.pending;
    if (entry.reading && now - entry.reading.at < (this.opts.minIntervalMs ?? 10_000)) {
      return Promise.resolve(entry.reading);
    }
    const current = entry;
    current.pending = readRobotNt(this.connect, ifname, ip, this.opts).then(result => {
      current.reading = { station, team, ip, at: Date.now(), ...result };
      current.pending = null;
      return current.reading;
    });
    // Forget robots no longer asked about
    for (const [other, e] of this.cache) {
      if (!e.pending && e.reading && now - e.reading.at > 10 * 60_000) this.cache.delete(other);
    }
    return current.pending;
  }
}
