/**
 * Robots that connected by themselves (src/robotWifiScan.ts) don't each get
 * their own field reconfiguration — every one drops all robots for ~30 s.
 * They are gathered for a few seconds, and longer while another robot heard
 * is still having its passphrase checked, then put on the field in one radio
 * change. The scoreboard counts the wait down. See
 * plans/robot-auto-connect.md.
 */
import type { SavedRobot } from './robotWifiScan.js';
import type { RobotWifiScanState } from './types.js';

export interface AutoConnectBatchOptions {
  /** How long the first robot waits for others */
  delayMs?: number;
  /** The longest the batch waits in all, however many are still checking */
  maxWaitMs?: number;
  /** Robots still being checked that may join (names minus `FRC-`) */
  stillChecking: () => string[];
  /** Put the gathered robots on the field, in one change */
  apply: (robots: SavedRobot[]) => void;
  onChange: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class AutoConnectBatch {
  private readonly o: Required<AutoConnectBatchOptions>;
  private robots = new Map<string, SavedRobot>();
  private at: number | null = null;
  private since = 0;
  private waitingFor: string[] = [];
  private timer: unknown;

  constructor(options: AutoConnectBatchOptions) {
    this.o = {
      delayMs: 5_000,
      maxWaitMs: 60_000,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  /** Gather a robot. The first starts the countdown; later ones join it. */
  add(robot: SavedRobot): void {
    this.robots.set(robot.ssid, robot);
    if (this.at === null) {
      this.since = this.o.now();
      this.schedule(this.since + this.o.delayMs);
    } else {
      this.o.onChange();
    }
  }

  has(ssid: string): boolean {
    return this.robots.has(ssid);
  }

  /** For the scoreboard: when the reconfiguration starts, and for whom. */
  upcoming(): RobotWifiScanState['upcoming'] {
    if (this.at === null) return undefined;
    return { at: this.at, robots: [...this.robots.keys()], waitingFor: this.waitingFor };
  }

  private schedule(at: number): void {
    this.at = at;
    if (this.timer !== undefined) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => this.due(), Math.max(0, at - this.o.now()));
    this.o.onChange();
  }

  private due(): void {
    this.timer = undefined;
    const now = this.o.now();
    this.waitingFor = this.o.stillChecking().filter(s => !this.robots.has(s));
    if (this.waitingFor.length > 0 && now - this.since < this.o.maxWaitMs) {
      this.schedule(Math.min(now + this.o.delayMs, this.since + this.o.maxWaitMs));
      return;
    }
    const robots = [...this.robots.values()];
    this.robots.clear();
    this.at = null;
    this.waitingFor = [];
    if (robots.length > 0) this.o.apply(robots);
    this.o.onChange();
  }
}
