import dgram from 'node:dgram';
import type { StationName, CheckResult, TeamCheckResults, DiscoveredHost, ControllerPolicy } from './types.js';

const FETCH_TIMEOUT = 1500;
/** roboRIO's NI SysAPI is slower than the radio — give it more time. */
const RIO_FETCH_TIMEOUT = 3000;
const MDNS_PORT = 5353;

// ── Help URLs ───────────────────────────────────────────────────────

const HELP_URLS = {
  radioSystemCore: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/radio-programming.html',
  radioFirmware: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/radio-programming.html',
  roboRIOHostname: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/roborio2-setup.html',
  roboRIOIP: 'https://docs.wpilib.org/en/stable/docs/networking/networking-introduction/ip-configurations.html',
  roboRIOImage: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/imaging-your-roborio.html',
  systemCore: 'https://github.com/wpilibsuite/SystemcoreTesting/blob/main/README.md',
} as const;

/** Which robot controller answered on the team subnet. */
export type RobotController = 'roboRIO' | 'systemcore';

// ── NI SysAPI property tags ─────────────────────────────────────────

// Tags from the system PropertyBag (//localhost/nisyscfg/system)
const TAG_HOSTNAME = '101F000';
const TAG_IMAGE_VERSION = 'D15C000';
// Tags from the eth0 PropertyBag (//localhost/nisyscfg/eth0)
const TAG_IP_ADDRESS = 'D107000';
// Tag that identifies which bag we're looking at
const TAG_ITEM_NAME = '1000000';

// ── Expected values ─────────────────────────────────────────────────

/** Expected radio firmware version prefix. Updated each season. */
const EXPECTED_RADIO_FIRMWARE_PREFIX = '2.0.1';

/** Expected roboRIO image year. Updated each season. */
const EXPECTED_IMAGE_YEAR = '2026';

// ── Helpers ─────────────────────────────────────────────────────────

export function teamSubnet(team: number): string {
  const high = Math.floor(team / 100);
  const low = team % 100;
  return `10.${high}.${low}`;
}

function expectedHostname(team: number): string {
  return `roboRIO-${team}-FRC`;
}

function expectedIP(team: number): string {
  return `${teamSubnet(team)}.2`;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── NI SysAPI XML parsing ───────────────────────────────────────────

interface NISysAPIBag {
  itemName: string; // e.g. //localhost/nisyscfg/system
  properties: Map<string, string>; // tag → value
}

function parseNISysAPIResponse(xml: string): NISysAPIBag[] {
  const bags: NISysAPIBag[] = [];
  // Match each <PropertyBag>...</PropertyBag>
  const bagPattern = /<PropertyBag>([\s\S]*?)<\/PropertyBag>/g;
  let bagMatch: RegExpExecArray | null;
  while ((bagMatch = bagPattern.exec(xml)) !== null) {
    const properties = new Map<string, string>();
    const propPattern = /<Property\s+tag='([^']+)'\s+type='[^']*'[^>]*>([^<]*)<\/Property>/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propPattern.exec(bagMatch[1])) !== null) {
      properties.set(propMatch[1], propMatch[2]);
    }
    bags.push({
      itemName: properties.get(TAG_ITEM_NAME) ?? '',
      properties,
    });
  }
  return bags;
}

// ── Standalone check functions ──────────────────────────────────────

const FACTORY_DEFAULT_IP = '192.168.69.1';

/**
 * Send a raw mDNS multicast query on a specific interface and wait for a response.
 * Returns the first A record IP, or null on timeout.
 *
 * This is a standalone diagnostic socket, separate from the mDNS reflector
 * (mdnsReflector.ts). Both coexist on port 5353 via SO_REUSEADDR:
 *
 *   - The reflector bridges queries between the main/guest networks and team
 *     VLANs. It will also see responses to our queries and forward them to
 *     laptop-facing interfaces — that's harmless extra traffic.
 *
 *   - This socket binds to 0.0.0.0:5353 so it receives multicast responses
 *     from ALL VLANs, not just the target. That means concurrent checks for
 *     different stations, laptop mDNS queries from the guest WiFi, and the
 *     reflector's forwarded packets all arrive here. parseARecord() filters
 *     by hostname to ensure we only accept the specific A record we asked for.
 *
 *   - Binding to sourceIp:5353 instead of 0.0.0.0 would seem cleaner but
 *     breaks multicast delivery on Linux: the kernel filters by destination
 *     IP, and mDNS responses are addressed to 224.0.0.251, not our unicast IP.
 */
function mdnsQuery(hostname: string, sourceIp: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      sock.close();
      resolve(null);
    }, timeoutMs);

    sock.on('error', () => {
      clearTimeout(timer);
      sock.close();
      resolve(null);
    });

    sock.on('message', msg => {
      // Only accept A records whose name matches our query. This is critical
      // because we're on 0.0.0.0:5353 and receive mDNS traffic from all VLANs,
      // including: concurrent diagnostic checks for other stations, the mDNS
      // reflector's forwarded responses, and unsolicited announcements.
      const ip = parseARecord(msg, hostname);
      if (ip) {
        clearTimeout(timer);
        sock.close();
        resolve(ip);
      }
    });

    // Bind to 0.0.0.0:5353 — see function doc for why not sourceIp.
    // SO_REUSEADDR (set in createSocket) allows coexistence with the mDNS reflector.
    sock.bind(MDNS_PORT, '0.0.0.0', () => {
      try {
        sock.addMembership('224.0.0.251', sourceIp);
      } catch {
        // May fail if already a member (e.g. reflector already joined this interface)
      }
      // Set the outgoing multicast interface explicitly — otherwise the OS sends
      // on the default-route interface (main network) and the query never reaches
      // the team VLAN where the robot lives.
      sock.setMulticastInterface(sourceIp);
      sock.setMulticastTTL(255); // mDNS spec requires TTL=255
      const query = buildMdnsQuery(hostname);
      sock.send(query, 0, query.length, 5353, '224.0.0.251');
    });
  });
}

/** Build a minimal DNS query packet (A record by default, or `qtype`). */
function buildMdnsQuery(hostname: string, qtype = 1): Buffer {
  // DNS header: ID=0, flags=0, 1 question, 0 answers
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  // Encode hostname labels (e.g. "roboRIO-1234-FRC.local" → \x12roboRIO-1234-FRC\x05local\x00)
  const labels = hostname.split('.').map(label => {
    const buf = Buffer.alloc(1 + label.length);
    buf[0] = label.length;
    buf.write(label, 1);
    return buf;
  });
  const name = Buffer.concat([...labels, Buffer.from([0])]);
  // Type, Class IN (1) with unicast-response bit
  const question = Buffer.from([(qtype >> 8) & 0xff, qtype & 0xff, 0x80, 1]);
  return Buffer.concat([header, name, question]);
}

/**
 * Read a DNS name from the packet at the given offset, handling label
 * compression pointers (RFC 1035 §4.1.4).  Returns the dotted name and
 * the offset immediately after the name field in the original packet.
 */
function readDnsName(buf: Buffer, offset: number): { name: string; endOffset: number } {
  const labels: string[] = [];
  let pos = offset;
  let endOffset = -1;

  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      if (endOffset === -1) endOffset = pos + 1;
      break;
    }
    // Compression pointer: top 2 bits set → remaining 14 bits are an offset
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      if (endOffset === -1) endOffset = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (pos + 1 + len > buf.length) break;
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('ascii'));
    pos += 1 + len;
  }

  if (endOffset === -1) endOffset = pos;
  return { name: labels.join('.'), endOffset };
}

/**
 * Parse the first A record from a DNS response.  When `expectedName` is
 * provided, only A records whose name matches (case-insensitive) are
 * accepted — this prevents cross-contamination when multiple mDNS queries
 * share the same socket/port on a VLAN.
 */
function parseARecord(msg: Buffer, expectedName?: string): string | null {
  if (msg.length < 12) return null;
  const qdcount = msg.readUInt16BE(4);
  const ancount = msg.readUInt16BE(6);
  if (ancount === 0) return null;

  const expected = expectedName?.toLowerCase();

  // Skip the question section
  let offset = 12;
  for (let i = 0; i < qdcount && offset < msg.length; i++) {
    const { endOffset } = readDnsName(msg, offset);
    offset = endOffset + 4; // skip QTYPE (2) + QCLASS (2)
  }

  // Parse answer records
  for (let i = 0; i < ancount && offset < msg.length; i++) {
    const { name, endOffset } = readDnsName(msg, offset);
    offset = endOffset;

    if (offset + 10 > msg.length) break;
    const rtype = msg.readUInt16BE(offset);
    const rdlength = msg.readUInt16BE(offset + 8);
    offset += 10;

    if (rtype === 1 && rdlength === 4 && offset + 4 <= msg.length) {
      if (!expected || name.toLowerCase() === expected) {
        return `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
      }
    }
    offset += rdlength;
  }
  return null;
}

/** Check mDNS resolution for a hostname via multicast on a specific interface. */
export async function checkMdns(
  name: string,
  hostname: string,
  expectedIp: string | undefined,
  sourceIp?: string,
): Promise<CheckResult[]> {
  if (!sourceIp) return [];
  try {
    const resolved = await mdnsQuery(hostname, sourceIp, FETCH_TIMEOUT);
    if (!resolved) {
      return [{ name, status: 'error', message: `${hostname} — no response` }];
    }
    if (!expectedIp || resolved === expectedIp) {
      return [{ name, status: 'pass', actual: `${hostname} → ${resolved}` }];
    }
    return [
      {
        name,
        status: 'warn',
        expected: expectedIp,
        actual: `${hostname} → ${resolved}`,
        message: 'Resolved to unexpected IP',
      },
    ];
  } catch {
    return [{ name, status: 'error', message: `${hostname} — query failed` }];
  }
}

/**
 * Check if the radio is reachable at the factory default IP (192.168.69.1).
 * Radios always respond here as a recovery fallback — this is normal.
 * Only warn if the radio responds at the factory IP but NOT at the team IP,
 * which means the radio hasn't been configured with a team number yet.
 */
export async function checkFactoryDefault(team: number): Promise<CheckResult[]> {
  const teamIp = `${teamSubnet(team)}.1`;

  const [factoryResult, teamResult] = await Promise.all([
    fetchWithTimeout(`http://${FACTORY_DEFAULT_IP}/status`).catch(() => null),
    fetchWithTimeout(`http://${teamIp}/status`).catch(() => null),
  ]);

  if (!factoryResult?.ok) return []; // Factory IP not reachable — no radio connected
  if (teamResult?.ok) return []; // Both respond — normal operation

  let factoryData: { teamNumber?: number; version?: string } | undefined;
  try {
    factoryData = (await factoryResult.json()) as { teamNumber?: number; version?: string };
  } catch {
    // Ignore parse errors
  }

  // Radio responds at factory IP but not team IP — needs configuration
  return [
    {
      name: 'Radio Not Configured',
      status: 'fail',
      actual: `Reachable at ${FACTORY_DEFAULT_IP} only${factoryData?.version ? ` (${factoryData.version})` : ''}`,
      message:
        'Radio responds at factory default IP but not at the team IP — it needs to be configured with a team number',
    },
  ];
}

/**
 * The radio's SystemCore mode has to match the robot controller: on for a
 * SystemCore, off for a roboRIO. When no controller was found the mode is
 * reported but not judged.
 */
export function evaluateSystemCore(
  data: { systemcoreEnabled?: boolean; version?: string },
  controller: RobotController | null | undefined,
): CheckResult {
  if (data.systemcoreEnabled === undefined) {
    // Older firmware doesn't report systemcoreEnabled — skip the check
    return {
      name: 'Radio SystemCore',
      status: 'pass',
      message: `Not reported by firmware${data.version ? ` (${data.version})` : ''} — update radio firmware to enable this check`,
    };
  }
  const actual = data.systemcoreEnabled ? 'enabled' : 'disabled';
  if (!controller) {
    return {
      name: 'Radio SystemCore',
      status: 'pass',
      actual,
      message:
        'No robot controller found to compare against — must be enabled for a SystemCore, disabled for a roboRIO',
    };
  }
  const expectedEnabled = controller === 'systemcore';
  const expected = expectedEnabled ? 'enabled' : 'disabled';
  if (data.systemcoreEnabled === expectedEnabled) {
    return { name: 'Radio SystemCore', status: 'pass', expected, actual };
  }
  return {
    name: 'Radio SystemCore',
    status: 'fail',
    expected,
    actual,
    message: expectedEnabled
      ? 'A SystemCore is connected but the radio is not in SystemCore mode'
      : 'SystemCore mode must be disabled for a roboRIO',
    helpUrl: HELP_URLS.radioSystemCore,
  };
}

function evaluateRadioFirmware(data: { version?: string }): CheckResult {
  if (!data.version) {
    return {
      name: 'Radio Firmware',
      status: 'error',
      message: 'Version field missing from radio status',
      helpUrl: HELP_URLS.radioFirmware,
    };
  }
  // Version format: "VH-109_2.0.1-02062026"
  // Extract the version part after the underscore
  const versionPart = data.version.includes('_') ? data.version.split('_')[1] : data.version;
  if (versionPart.startsWith(EXPECTED_RADIO_FIRMWARE_PREFIX)) {
    return { name: 'Radio Firmware', status: 'pass', actual: data.version };
  }
  return {
    name: 'Radio Firmware',
    status: 'fail',
    expected: `Version ${EXPECTED_RADIO_FIRMWARE_PREFIX}+`,
    actual: data.version,
    message: 'Radio firmware is outdated',
    helpUrl: HELP_URLS.radioFirmware,
  };
}

/**
 * The radio's "Enable QoS BW Limit" checkbox (`qosEnabled`). Its own help text:
 * bandwidth limiting protects control packets when cameras share the link. In
 * practice it throttles the robot to the competition cap, and a robot pushing
 * camera streams past that cap sees ~130 ms latency and packet loss — exactly
 * what took 6238 down at the 2026-09-13 scrimmage. The practice field applies
 * no limit of its own, so the setting only hurts here.
 */
const QOS_CAP_MBPS = 4;
const QOS_NEAR_MBPS = 3.5;

function evaluateQosLimit(data: { qosEnabled?: boolean }, usedMbps?: number): CheckResult {
  if (data.qosEnabled === undefined) {
    return { name: 'Radio QoS BW Limit', status: 'pass', message: 'Not reported by firmware' };
  }
  if (!data.qosEnabled) {
    return { name: 'Radio QoS BW Limit', status: 'pass', actual: 'disabled' };
  }
  const usage = usedMbps !== undefined ? `, using ${usedMbps.toFixed(1)} Mbps` : '';
  const hitting = usedMbps !== undefined && usedMbps >= QOS_NEAR_MBPS;
  return {
    name: 'Radio QoS BW Limit',
    status: 'warn',
    expected: 'disabled',
    actual: `enabled${usage}`,
    message: hitting
      ? `Enabled and you are at the ~${QOS_CAP_MBPS} Mbps cap right now (${usedMbps!.toFixed(1)} Mbps) — the radio is ` +
        `throttling the robot, which is what causes the lag and NetworkTables/Driver Station dropouts. Untick ` +
        `"Enable QoS BW Limit" on the radio, or cut what the robot streams (camera resolution/FPS).`
      : `The radio is throttling the robot to the ~${QOS_CAP_MBPS} Mbps competition cap. With camera streams above the ` +
        `cap this adds latency and packet loss (NetworkTables timeouts). The practice field sets no limit — untick ` +
        `"Enable QoS BW Limit" in the radio configuration unless the 2.4 GHz network is needed.`,
    helpUrl: HELP_URLS.radioFirmware,
  };
}

/** Fetch radio /status and run all radio checks. Firmware first; SystemCore skipped if outdated. Includes detected team number.
 *  `controller` (from checkRobotController) decides what the SystemCore mode should be. */
export async function checkRadio(
  team: number,
  sourceIp?: string,
  controller?: RobotController | null,
): Promise<CheckResult[]> {
  const radioIp = `${teamSubnet(team)}.1`;
  const results: CheckResult[] = [];
  try {
    const res = await fetchWithTimeout(`http://${radioIp}/status`);
    if (!res.ok) {
      const msg = `Radio returned HTTP ${res.status}`;
      return [
        { name: 'Radio Firmware', status: 'error', message: msg, helpUrl: HELP_URLS.radioFirmware },
        { name: 'Radio SystemCore', status: 'error', message: msg, helpUrl: HELP_URLS.radioSystemCore },
      ];
    }
    type BandStatus = { isLinked?: boolean; bandwidthUsedMbps?: number };
    const data = (await res.json()) as {
      systemcoreEnabled?: boolean;
      qosEnabled?: boolean;
      version?: string;
      teamNumber?: number;
      networkStatus6?: BandStatus;
      networkStatus24?: BandStatus;
    };
    const linkedUsedMbps =
      (data.networkStatus6?.isLinked ? data.networkStatus6.bandwidthUsedMbps : undefined) ??
      (data.networkStatus24?.isLinked ? data.networkStatus24.bandwidthUsedMbps : undefined);
    const fwCheck = evaluateRadioFirmware(data);
    results.push(fwCheck);
    if (fwCheck.status === 'fail') {
      results.push({ name: 'Radio SystemCore', status: 'warn', message: 'Skipped — update firmware first' });
    } else {
      results.push(evaluateSystemCore(data, controller));
    }
    results.push(evaluateQosLimit(data, linkedUsedMbps));
    // Report detected team number for consistency checking
    if (data.teamNumber !== undefined) {
      results.push({
        name: 'Radio Team',
        status: data.teamNumber === team ? 'pass' : 'fail',
        actual: `${data.teamNumber}`,
        ...(data.teamNumber !== team && {
          expected: `${team}`,
          message: 'Radio team number does not match DHCP subnet',
        }),
      });
    }
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'Radio unreachable (timeout)' : String(err);
    return [
      { name: 'Radio Firmware', status: 'error', message: msg, helpUrl: HELP_URLS.radioFirmware },
      { name: 'Radio SystemCore', status: 'error', message: msg, helpUrl: HELP_URLS.radioSystemCore },
    ];
  }

  // radio.local mDNS check
  const mdns = await checkMdns('Radio mDNS', 'radio.local', radioIp, sourceIp);
  results.push(...mdns);

  return results;
}

/**
 * Find the roboRIO on the team's subnet by probing the NI SysAPI endpoint.
 * Try the standard .2 address first, then any other IPs provided.
 */
async function findRoboRIO(team: number, extraIps: string[]): Promise<{ ip: string; bags: NISysAPIBag[] } | null> {
  const standardIp = expectedIP(team);
  const ipsToTry = [standardIp, ...extraIps.filter(ip => ip !== standardIp)];

  for (const ip of ipsToTry) {
    try {
      const res = await fetchWithTimeout(
        `http://${ip}/nisysapi/server`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/xml',
          },
          body: 'Function=SearchForItemsAndProperties&Version=00010001&response_encoding=UTF-8&Plugins=nisyscfg&FilterMode=00000002',
        },
        RIO_FETCH_TIMEOUT,
      );
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes('NISysAPI_Results')) continue;
      // Check for success (hr='0')
      const hrMatch = xml.match(/hr='([^']+)'/);
      if (hrMatch && hrMatch[1] !== '0') continue;
      const bags = parseNISysAPIResponse(xml);
      if (bags.length > 0) return { ip, bags };
    } catch {
      // Not a RIO, try next
    }
  }
  return null;
}

// ── SystemCore ──────────────────────────────────────────────────────

const SYSTEMCORE_SERVICE = '_SystemCore._tcp.local';

interface SystemCoreInfo {
  ip: string;
  hostname: string;
  port: number;
}

/**
 * Ask a host directly (unicast mDNS, RFC 6762 §5.5) whether it is a
 * SystemCore: one advertises `_SystemCore._tcp` with an SRV pointing at its
 * hostname (`robot.local` by default, port 1740) plus that name's A record.
 * Unicast on purpose — a robot behind its radio does not reliably receive
 * multicast from the wired side, but answers a query sent to its address
 * (verified with 5940's SystemCore on 2026-09-13).
 */
function probeSystemCore(ip: string, timeoutMs = FETCH_TIMEOUT): Promise<SystemCoreInfo | null> {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const finish = (result: SystemCoreInfo | null) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== ip) return;
      const answers = parseMdnsAnswers(msg);
      const srv = answers.find(
        a => a.type === 'SRV' && a.name.toLowerCase().endsWith(SYSTEMCORE_SERVICE.toLowerCase()),
      );
      if (!srv || srv.type !== 'SRV') return;
      const a = answers.find(r => r.type === 'A' && r.name.toLowerCase() === srv.target.toLowerCase());
      finish({ ip: a?.type === 'A' ? a.address : ip, hostname: srv.target, port: srv.port });
    });
    const query = buildMdnsQuery(SYSTEMCORE_SERVICE, 12);
    sock.send(query, 0, query.length, MDNS_PORT, ip, err => {
      if (err) finish(null);
    });
  });
}

type MdnsAnswer =
  | { type: 'A'; name: string; address: string }
  | { type: 'PTR'; name: string; target: string }
  | { type: 'SRV'; name: string; target: string; port: number };

/** All A/PTR/SRV records in a DNS response (answers + additionals). */
export function parseMdnsAnswers(msg: Buffer): MdnsAnswer[] {
  const out: MdnsAnswer[] = [];
  if (msg.length < 12) return out;
  const qdcount = msg.readUInt16BE(4);
  const total = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < qdcount && offset < msg.length; i++) {
    offset = readDnsName(msg, offset).endOffset + 4;
  }
  for (let i = 0; i < total && offset < msg.length; i++) {
    const { name, endOffset } = readDnsName(msg, offset);
    offset = endOffset;
    if (offset + 10 > msg.length) break;
    const rtype = msg.readUInt16BE(offset);
    const rdlength = msg.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdlength > msg.length) break;
    if (rtype === 1 && rdlength === 4) {
      out.push({ type: 'A', name, address: `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}` });
    } else if (rtype === 12) {
      out.push({ type: 'PTR', name, target: readDnsName(msg, offset).name });
    } else if (rtype === 33 && rdlength >= 6) {
      out.push({ type: 'SRV', name, port: msg.readUInt16BE(offset + 4), target: readDnsName(msg, offset + 6).name });
    }
    offset += rdlength;
  }
  return out;
}

/**
 * Identify the robot controller on the team subnet and run its checks.
 * A roboRIO answers the NI SysAPI; a SystemCore answers the mDNS service
 * probe. Returns which one was found so the radio's SystemCore mode can be
 * judged against it.
 */
export async function checkRobotController(
  team: number,
  extraIps: string[] = [],
  sourceIp?: string,
): Promise<{ controller: RobotController | null; checks: CheckResult[] }> {
  const found = await detectRobotController(team, extraIps, sourceIp);
  const policy = evaluateControllerPolicy(found.controller, controllerPolicyResolver?.() ?? 'none');
  if (policy) found.checks.push(policy);
  return found;
}

/** The field's stance on control systems, supplied by index.ts (same resolver
 *  pattern as the video proxy target) so the checks pick up an admin change
 *  without a restart. */
let controllerPolicyResolver: (() => ControllerPolicy | undefined) | undefined;

export function setControllerPolicyResolver(resolver: () => ControllerPolicy | undefined): void {
  controllerPolicyResolver = resolver;
}

/**
 * Turn the field's control-system policy into a check the team sees.
 * Returns null when the field has no opinion, or when no controller was found
 * (the "no controller" error already says everything useful).
 *
 * Advisory by design: a failed check tells the team and field staff, it does
 * not stop the robot connecting or joining a match. Controller detection can
 * miss transiently (a dropped mDNS probe), and hard-blocking on that would
 * strand a legitimate robot mid-event.
 */
export function evaluateControllerPolicy(
  controller: RobotController | null,
  policy: ControllerPolicy = 'none',
): CheckResult | null {
  if (policy === 'none' || controller === null) return null;
  const name = 'Control System Policy';
  const isCore = controller === 'systemcore';
  switch (policy) {
    case 'preferSystemCore':
      return isCore
        ? { name, status: 'pass', actual: 'SystemCore' }
        : {
            name,
            status: 'warn',
            expected: 'SystemCore',
            actual: 'roboRIO',
            message:
              'This field is moving to SystemCore. Your robot still runs the roboRIO control system — still allowed here, but plan the switch.',
            helpUrl: HELP_URLS.systemCore,
          };
    case 'blockRoboRIO':
      return isCore
        ? { name, status: 'pass', actual: 'SystemCore' }
        : {
            name,
            status: 'fail',
            expected: 'SystemCore',
            actual: 'roboRIO',
            message: 'This field is set to SystemCore only — a roboRIO robot is not accepted here. See field staff.',
            helpUrl: HELP_URLS.systemCore,
          };
    case 'blockSystemCore':
      return isCore
        ? {
            name,
            status: 'fail',
            expected: 'roboRIO',
            actual: 'SystemCore',
            message: 'This field is not accepting SystemCore robots right now. See field staff.',
            helpUrl: HELP_URLS.systemCore,
          }
        : { name, status: 'pass', actual: 'roboRIO' };
  }
}

async function detectRobotController(
  team: number,
  extraIps: string[],
  sourceIp?: string,
): Promise<{ controller: RobotController | null; checks: CheckResult[] }> {
  const rio = await findRoboRIO(team, extraIps);
  if (rio) return { controller: 'roboRIO', checks: await roboRIOChecks(team, rio, sourceIp) };

  const standardIp = expectedIP(team);
  const ipsToTry = [standardIp, ...extraIps.filter(ip => ip !== standardIp)];
  for (const ip of ipsToTry) {
    const core = await probeSystemCore(ip);
    if (core) return { controller: 'systemcore', checks: await systemCoreChecks(team, core, sourceIp) };
  }

  return {
    controller: null,
    checks: [
      {
        name: 'Robot Controller',
        status: 'error',
        message: 'No roboRIO or SystemCore found on team subnet',
        helpUrl: HELP_URLS.roboRIOIP,
      },
    ],
  };
}

async function systemCoreChecks(team: number, core: SystemCoreInfo, sourceIp?: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = [
    {
      name: 'Robot Controller',
      status: 'pass',
      actual: `SystemCore (${core.hostname}, port ${core.port})`,
    },
  ];
  const expectedIpAddr = expectedIP(team);
  checks.push({
    name: 'SystemCore IP',
    status: core.ip === expectedIpAddr ? 'pass' : 'fail',
    expected: expectedIpAddr,
    actual: core.ip,
    ...(core.ip !== expectedIpAddr && {
      message:
        'Set a static IP of 10.TE.AM.2 on eth0 in the SystemCore web UI (Gear tab) so the Driver Station finds it reliably',
      helpUrl: HELP_URLS.systemCore,
    }),
  });
  // The SystemCore keeps the default "robot.local" name; there is no per-team
  // hostname convention to enforce, so this only proves the name resolves.
  const mdns = await checkMdns('SystemCore mDNS', core.hostname, core.ip, sourceIp);
  checks.push(...mdns);
  return checks;
}

/** Run roboRIO checks. `extraIps` are additional addresses to probe beyond the standard .2. */
export async function checkRoboRIO(team: number, extraIps: string[] = [], sourceIp?: string): Promise<CheckResult[]> {
  const result = await findRoboRIO(team, extraIps);
  if (!result) {
    return [
      {
        name: 'roboRIO',
        status: 'error',
        message: 'roboRIO not found on team subnet',
        helpUrl: HELP_URLS.roboRIOIP,
      },
    ];
  }

  return roboRIOChecks(team, result, sourceIp);
}

async function roboRIOChecks(
  team: number,
  result: { ip: string; bags: NISysAPIBag[] },
  sourceIp?: string,
): Promise<CheckResult[]> {
  const { ip, bags } = result;
  const systemBag = bags.find(b => b.itemName.endsWith('/system'));
  const eth0Bag = bags.find(b => b.itemName.endsWith('/eth0'));

  const checks: CheckResult[] = [];

  // Hostname check
  const hostname = systemBag?.properties.get(TAG_HOSTNAME);
  const expectedName = expectedHostname(team);
  if (hostname) {
    checks.push({
      name: 'roboRIO Hostname',
      status: hostname === expectedName ? 'pass' : 'fail',
      expected: expectedName,
      actual: hostname,
      ...(hostname !== expectedName && {
        message: 'Hostname does not match expected FRC format',
        helpUrl: HELP_URLS.roboRIOHostname,
      }),
    });
  } else {
    checks.push({
      name: 'roboRIO Hostname',
      status: 'error',
      message: 'Could not read hostname from roboRIO',
      helpUrl: HELP_URLS.roboRIOHostname,
    });
  }

  // IP check
  const rioIp = eth0Bag?.properties.get(TAG_IP_ADDRESS) ?? ip;
  const expectedIpAddr = expectedIP(team);
  checks.push({
    name: 'roboRIO IP',
    status: rioIp === expectedIpAddr ? 'pass' : 'fail',
    expected: expectedIpAddr,
    actual: rioIp,
    ...(rioIp !== expectedIpAddr && {
      message: `roboRIO is at non-standard IP (found via ${ip})`,
      helpUrl: HELP_URLS.roboRIOIP,
    }),
  });

  // Image version check
  const imageVersion = systemBag?.properties.get(TAG_IMAGE_VERSION);
  if (imageVersion) {
    const hasCurrentYear = imageVersion.includes(EXPECTED_IMAGE_YEAR);
    checks.push({
      name: 'roboRIO Image',
      status: hasCurrentYear ? 'pass' : 'fail',
      expected: `${EXPECTED_IMAGE_YEAR} image`,
      actual: imageVersion,
      ...(!hasCurrentYear && {
        message: 'roboRIO image is outdated',
        helpUrl: HELP_URLS.roboRIOImage,
      }),
    });
  } else {
    checks.push({
      name: 'roboRIO Image',
      status: 'error',
      message: 'Could not read image version from roboRIO',
      helpUrl: HELP_URLS.roboRIOImage,
    });
  }

  // Extract team number from hostname for consistency display
  if (hostname) {
    const rioTeam = teamFromHostname(hostname);
    if (rioTeam !== null) {
      checks.push({
        name: 'roboRIO Team',
        status: rioTeam === team ? 'pass' : 'fail',
        actual: `${rioTeam}`,
        ...(rioTeam !== team && { expected: `${team}`, message: 'roboRIO team does not match DHCP subnet' }),
      });
    }
  }

  // roboRIO mDNS check
  const mdns = await checkMdns('roboRIO mDNS', `roboRIO-${team}-FRC.local`, expectedIP(team), sourceIp);
  checks.push(...mdns);

  return checks;
}

// ── Team number consistency ─────────────────────────────────────────

/** Extract a team number from an SSID like "1234" or "1234-Comp". */
function teamFromSsid(ssid: string): number | null {
  const match = ssid.match(/^(\d{1,5})/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return num > 0 && num <= 25599 ? num : null;
}

/** Extract a team number from a roboRIO hostname like "roboRIO-1234-FRC". */
function teamFromHostname(hostname: string): number | null {
  const match = hostname.match(/^roboRIO-(\d+)-FRC$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return num > 0 && num <= 25599 ? num : null;
}

/**
 * Verify team number consistency across DHCP range, radio SSID, and roboRIO hostname.
 * The `dhcpTeam` is derived from the DHCP-assigned IP (10.TE.AM.x).
 */
export async function checkTeamConsistency(dhcpTeam: number): Promise<CheckResult[]> {
  const sources: { source: string; team: number }[] = [{ source: 'DHCP', team: dhcpTeam }];
  const problems: string[] = [];

  // Try to get team from radio
  const radioIp = `${teamSubnet(dhcpTeam)}.1`;
  try {
    const res = await fetchWithTimeout(`http://${radioIp}/status`);
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      // Robot radios report teamNumber directly; fall back to parsing SSID
      let radioTeam: number | null = null;
      let radioLabel = 'Radio';
      if (typeof data.teamNumber === 'number') {
        radioTeam = data.teamNumber;
        radioLabel = `Radio (team ${radioTeam})`;
      } else {
        // Try SSID from networkStatus6 (6 GHz band, uses team-only SSID) or top-level
        const ssid =
          (data.networkStatus6 as { ssid?: string } | undefined)?.ssid ??
          (typeof data.ssid === 'string' ? data.ssid : undefined);
        if (ssid) {
          radioTeam = teamFromSsid(ssid);
          radioLabel = `Radio SSID (${ssid})`;
        }
      }
      if (radioTeam) {
        sources.push({ source: radioLabel, team: radioTeam });
        if (radioTeam !== dhcpTeam) problems.push(`${radioLabel} → team ${radioTeam}`);
      }
    }
  } catch {
    // Radio unreachable — skip, other checks will report this
  }

  // Try to get team from roboRIO hostname
  const rioIp = expectedIP(dhcpTeam);
  try {
    const res = await fetchWithTimeout(
      `http://${rioIp}/nisysapi/server`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/xml' },
        body: 'Function=SearchForItemsAndProperties&Version=00010001&response_encoding=UTF-8&Plugins=nisyscfg&FilterMode=00000002',
      },
      RIO_FETCH_TIMEOUT,
    );
    if (res.ok) {
      const xml = await res.text();
      const bags = parseNISysAPIResponse(xml);
      const systemBag = bags.find(b => b.itemName.endsWith('/system'));
      const hostname = systemBag?.properties.get(TAG_HOSTNAME);
      if (hostname) {
        const rioTeam = teamFromHostname(hostname);
        if (rioTeam) {
          sources.push({ source: `roboRIO (${hostname})`, team: rioTeam });
          if (rioTeam !== dhcpTeam) problems.push(`roboRIO hostname "${hostname}" → team ${rioTeam}`);
        }
      }
    }
  } catch {
    // RIO unreachable — skip
  }

  if (problems.length > 0) {
    return [
      {
        name: 'Team Consistency',
        status: 'fail',
        expected: `All devices: team ${dhcpTeam}`,
        actual: sources.map(s => `${s.source}: ${s.team}`).join(', '),
        message: `Team number mismatch: ${problems.join('; ')}`,
      },
    ];
  }

  // All sources agree (or only DHCP was available)
  const detail = sources.length > 1 ? sources.map(s => s.source).join(', ') : 'DHCP only';
  return [
    {
      name: 'Team Consistency',
      status: 'pass',
      actual: `Team ${dhcpTeam} (${detail})`,
    },
  ];
}

// ── TeamChecker (station-based wrapper) ─────────────────────────────

type HostLookup = (station: StationName) => DiscoveredHost[];

export class TeamChecker {
  constructor(
    private readonly getAliveHosts: HostLookup,
    private readonly vlanHostOctet?: number,
  ) {}

  async runChecks(station: StationName, team: number): Promise<TeamCheckResults> {
    const hosts = this.getAliveHosts(station);
    const extraIps = hosts.filter(h => h.alive && !h.ip.endsWith('.1') && !h.ip.endsWith('.254')).map(h => h.ip);
    const sourceIp = this.vlanHostOctet ? `${teamSubnet(team)}.${this.vlanHostOctet}` : undefined;
    const [radioChecks, rioChecks] = await Promise.all([
      checkRadio(team, sourceIp),
      checkRoboRIO(team, extraIps, sourceIp),
    ]);
    return {
      type: 'teamCheckResults',
      station,
      team,
      timestamp: Date.now(),
      checks: [...radioChecks, ...rioChecks],
    };
  }
}
