import { spawn, type ChildProcess } from 'node:child_process';
import type { StationName, TelemetryUpdate } from './types.js';

/**
 * Passively capture robot↔DS UDP packets via tcpdump to extract battery
 * voltage, robot status and joysticks without taking FMS control of the
 * Driver Station.
 *
 * The robot sends UDP with sport 1150 to the gateway IP on each team's VLAN.
 * We capture these packets, parse the pcap stream, and feed telemetry into
 * the existing broadcast pipeline.
 *
 * The DS's control packets to the robot (dst port 1110) carry its joysticks.
 * They cross pFMS only when the DS routes through it (drive sessions), so the
 * joystick report is best-effort: no packets means "can't tell".
 */
export class RobotPacketCapture {
  private proc: ChildProcess | null = null;
  private buf = Buffer.alloc(0);
  private headerParsed = false;
  private debuggedTeams = new Set<number>();

  constructor(
    private readonly interfaceName: string,
    private readonly getTeamMappings: () => Record<number, StationName>,
    private readonly onTelemetry: (update: TelemetryUpdate) => void,
    private readonly dryRun = false,
    /** Resolve station from a VLAN ID (for disambiguating duplicate teams). */
    private readonly vlanToStation?: (vlanId: number) => StationName | undefined,
    /** A DS→robot control packet was seen, carrying this many joysticks. */
    private readonly onJoysticks?: (station: StationName, count: number) => void,
  ) {}

  /** True while tcpdump is running, so a silent robot is really silent. */
  isRunning(): boolean {
    return this.proc !== null;
  }

  start(): void {
    if (this.dryRun || this.proc) return;

    // Capture on all VLAN sub-interfaces by listening on the parent
    const proc = spawn(
      'tcpdump',
      ['-i', this.interfaceName, '-U', '-w', '-', '--immediate-mode', '-p', 'udp and (dst port 1150 or dst port 1110)'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.headerParsed = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      // tcpdump prints stats to stderr — ignore those
      if (line && !line.includes('packets captured') && !line.includes('packets received')) {
        console.warn(`RobotPacketCapture: ${line}`);
      }
    });

    proc.on('error', err => {
      console.error(`RobotPacketCapture: failed to start tcpdump: ${err.message}`);
      this.proc = null;
    });

    proc.on('exit', (code, signal) => {
      this.proc = null;
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        console.warn(`RobotPacketCapture: tcpdump exited (code=${code}, signal=${signal})`);
        // Restart after a delay
        setTimeout(() => this.start(), 5000);
      }
    });

    console.log(`RobotPacketCapture: listening on ${this.interfaceName}`);
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  /** Process buffered pcap data. */
  private drain(): void {
    // Parse global header (24 bytes) once
    if (!this.headerParsed) {
      if (this.buf.length < 24) return;
      const magic = this.buf.readUInt32LE(0);
      if (magic !== 0xa1b2c3d4 && magic !== 0xa1b2cd34) {
        console.error('RobotPacketCapture: invalid pcap magic:', magic.toString(16));
        this.stop();
        return;
      }
      this.buf = this.buf.subarray(24);
      this.headerParsed = true;
    }

    // Read packet records
    while (this.buf.length >= 16) {
      // Pcap record header: ts_sec(4) ts_usec(4) incl_len(4) orig_len(4)
      const inclLen = this.buf.readUInt32LE(8);
      const totalLen = 16 + inclLen;
      if (this.buf.length < totalLen) break;

      const packetData = this.buf.subarray(16, totalLen);
      this.buf = this.buf.subarray(totalLen);

      this.parsePacket(packetData);
    }
  }

  /** Parse a single captured packet (Ethernet + [VLAN] + IP + UDP + payload). */
  private parsePacket(data: Buffer): void {
    // Ethernet header: 14 bytes (dst[6] + src[6] + etherType[2])
    if (data.length < 14) return;
    let etherType = data.readUInt16BE(12);
    let ipOffset = 14;
    let vlanId: number | undefined;

    // Skip 802.1Q VLAN tag if present (4 extra bytes)
    if (etherType === 0x8100) {
      if (data.length < 18) return;
      vlanId = data.readUInt16BE(14) & 0x0fff; // VLAN ID is lower 12 bits
      etherType = data.readUInt16BE(16);
      ipOffset = 18;
    }

    if (etherType !== 0x0800) return; // Not IPv4
    if (data.length < ipOffset + 20) return;
    const ipHeaderLen = (data[ipOffset] & 0x0f) * 4;
    if (data.length < ipOffset + ipHeaderLen + 8) return; // Need at least UDP header

    // Extract source IP (bytes 12-15 of IP header)
    const srcIp = `${data[ipOffset + 12]}.${data[ipOffset + 13]}.${data[ipOffset + 14]}.${data[ipOffset + 15]}`;

    // UDP payload starts after IP header + 8 bytes UDP header
    const payloadOffset = ipOffset + ipHeaderLen + 8;
    const dstPort = data.readUInt16BE(ipOffset + ipHeaderLen + 2);

    if (dstPort === DS_TO_ROBOT_PORT) {
      const dstIp = `${data[ipOffset + 16]}.${data[ipOffset + 17]}.${data[ipOffset + 18]}.${data[ipOffset + 19]}`;
      this.parseDsToRobot(data.subarray(payloadOffset), dstIp, vlanId);
      return;
    }
    if (data.length < payloadOffset + 6) return; // Need at least 6 bytes of robot payload

    // Robot→DS payload format (from frcture.readthedocs.io):
    // Bytes 0-1: Sequence number (uint16 BE)
    // Byte 2: Comm version (0x01)
    // Byte 3: Status (bit7=eStop, bit4=brownout, bit3=codeStart, bit2=enabled, bits1-0=mode)
    // Byte 4: Trace (bit5=robotCode, bit4=isRoboRIO, bit3=test, bit2=auto, bit1=teleop, bit0=disabled)
    // Bytes 5-6: Battery voltage (byte5=integer volts, byte6=fraction, voltage = byte5 + byte6/256)
    // Byte 7: Request date flag
    // Bytes 8+: Tags (variable)
    if (data.length < payloadOffset + 7) return; // Need at least through battery bytes
    const statusByte = data[payloadOffset + 3];
    const traceByte = data[payloadOffset + 4];
    // 0xFFFF is the DS "no reading" sentinel (robot not connected); it would
    // decode to 255.996V and display as "256.0V". An exact 0 is a frame that
    // carried no voltage (a brief telemetry hiccup) — a connected robot battery
    // is never 0.00V. Report undefined for both so the chart holds instead of
    // flapping to 0.
    const battByte = data[payloadOffset + 5];
    const battFrac = data[payloadOffset + 6];
    const batteryVoltage =
      (battByte === 0xff && battFrac === 0xff) || (battByte === 0 && battFrac === 0)
        ? undefined
        : battByte + battFrac / 256;

    // Extract team number from source IP (10.TE.AM.x)
    const team = teamFromIp(srcIp);
    if (!team) return;

    const now = Date.now();

    const station = this.resolveStation(team, vlanId);
    if (!station) return;

    // Status byte: bit7=eStop, bit4=brownout, bit3=codeStart, bit2=enabled, bits1-0=mode (0=teleop,1=test,2=auto)
    const eStop = Boolean(statusByte & 0x80);
    const brownout = Boolean(statusByte & 0x10);
    const enabled = Boolean(statusByte & 0x04);
    const modeNum = statusByte & 0x03;
    const mode: 'teleOp' | 'test' | 'auto' = modeNum === 2 ? 'auto' : modeNum === 1 ? 'test' : 'teleOp';

    // Trace byte: bit5=robotCode, bit4=isRoboRIO
    const hasRobotCode = Boolean(traceByte & 0x20);

    const update: TelemetryUpdate = {
      type: 'telemetry',
      station,
      timestamp: now,
      batteryVoltage,
      brownout,
      dsStatus: {
        eStop,
        aStop: false, // A-Stop is a DS-side state; not present in the robot→FMS status byte
        robotComms: hasRobotCode,
        radioPing: true, // If we see the packet, radio is up
        rioPing: true, // Packet came from the RIO
        enabled,
        mode,
      },
    };

    // Log first packet per team to verify parsing
    if (!this.debuggedTeams.has(team)) {
      this.debuggedTeams.add(team);
      console.log(
        `RobotPacketCapture: team ${team} → ${batteryVoltage !== undefined ? `${batteryVoltage.toFixed(2)}V` : 'no reading'} ${enabled ? 'enabled' : 'disabled'} ${mode}${hasRobotCode ? '' : ' (no code)'}`,
      );
    }

    this.onTelemetry(update);
  }

  /** DS→robot control packet: report how many joysticks it carries. */
  private parseDsToRobot(payload: Buffer, dstIp: string, vlanId: number | undefined): void {
    if (!this.onJoysticks) return;
    const team = teamFromIp(dstIp);
    if (!team) return;
    const count = countDsJoysticks(payload);
    if (count === null) return;
    const station = this.resolveStation(team, vlanId);
    if (station) this.onJoysticks(station, count);
  }

  /** Resolve team to station. When a team is duplicated across stations,
   *  prefer the VLAN-based resolution (the VLAN ID in the 802.1Q tag maps
   *  directly to a station via the radio VLAN map). */
  private resolveStation(team: number, vlanId: number | undefined): StationName | undefined {
    if (vlanId !== undefined && this.vlanToStation) {
      const vlanStation = this.vlanToStation(vlanId);
      if (vlanStation) return vlanStation;
    }
    return this.getTeamMappings()[team];
  }
}

const DS_TO_ROBOT_PORT = 1110;
const JOYSTICK_TAG = 0x0c;

/**
 * Count the joysticks in a legacy DS→robot control packet (UDP 1110), or
 * null if it isn't one.
 *
 * Layout (frcture.readthedocs.io): sequence (2), comm version 0x01 (1),
 * control (1), request (1), alliance station (1), then tags. Each tag is a
 * size byte — counting the id and data — then the id. A joystick tag (0x0c)
 * holds an axis count and axes, a button count and packed button bits, and a
 * POV count and 16-bit POVs. The DS may send a tag for an empty slot, so a
 * joystick only counts when it has any axes, buttons or POVs.
 */
export function countDsJoysticks(payload: Buffer): number | null {
  if (payload.length < 6 || payload[2] !== 0x01) return null;
  let count = 0;
  let i = 6;
  while (i + 1 < payload.length) {
    const size = payload[i];
    if (size === 0 || i + 1 + size > payload.length) return null;
    if (payload[i + 1] === JOYSTICK_TAG) {
      const tag = payload.subarray(i + 2, i + 1 + size);
      const axes = tag[0] ?? 0;
      const buttons = tag[1 + axes] ?? 0;
      const povs = tag[2 + axes + Math.ceil(buttons / 8)] ?? 0;
      if (axes + buttons + povs > 0) count++;
    }
    i += 1 + size;
  }
  return count;
}

/** Parse team number from 10.TE.AM.x IP. */
function teamFromIp(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts[0] !== '10') return null;
  const high = parseInt(parts[1], 10);
  const low = parseInt(parts[2], 10);
  if (isNaN(high) || isNaN(low)) return null;
  const team = high * 100 + low;
  return team > 0 && team <= 25599 ? team : null;
}
