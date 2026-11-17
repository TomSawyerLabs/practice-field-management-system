/**
 * What the robot Wi-Fi scan and auto-connect did lately — robots heard,
 * passphrases checked and found, robots put on the field, retries, holds —
 * so a CSA can see why a robot did or didn't connect by itself without
 * reading the server log. In memory only: the last few hours.
 * See plans/robot-auto-connect.md.
 */
import type { RobotWifiActivity } from './types.js';

export interface RobotWifiActivityLogOptions {
  /** Most entries kept */
  max?: number;
  /** Entries older than this are dropped */
  keepMs?: number;
  now?: () => number;
}

export class RobotWifiActivityLog {
  private entries: RobotWifiActivity[] = [];
  private readonly max: number;
  private readonly keepMs: number;
  private readonly now: () => number;

  constructor(o: RobotWifiActivityLogOptions = {}) {
    this.max = o.max ?? 100;
    this.keepMs = o.keepMs ?? 4 * 60 * 60_000;
    this.now = o.now ?? Date.now;
  }

  add(robot: string, text: string, tone: RobotWifiActivity['tone'] = 'info'): void {
    this.entries.unshift({ at: this.now(), robot, text, tone });
    if (this.entries.length > this.max) this.entries.length = this.max;
  }

  /** Newest first */
  list(): RobotWifiActivity[] {
    const cutoff = this.now() - this.keepMs;
    const i = this.entries.findIndex(e => e.at < cutoff);
    if (i >= 0) this.entries.length = i;
    return [...this.entries];
  }
}
