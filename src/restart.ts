/**
 * Restarting pFMS from inside itself — the admin page's Restart button, and
 * self-update bringing up a newly installed binary (src/selfUpdate.ts).
 *
 * Always the graceful path: write the keep-network flag, then SIGHUP
 * ourselves. The SIGHUP handler in src/index.ts stops what pFMS runs and
 * exits without touching iptables or routes; the next start sees the flag
 * and keeps them, so robots stay connected.
 *
 * Under systemd (`Restart=always`) that's all — systemd starts us again.
 * The packaged binary run by hand has nothing to start it, so it first
 * spawns its successor, told to wait until this process is gone
 * (PFMS_WAIT_FOR_PID, honored by src/binaryMain.ts) before it binds the
 * ports. A checkout run by hand (development, `bun --watch`) just exits, as
 * it always has.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isPackagedBinary } from './buildInfo.js';

export const KEEP_NETWORK_FLAG = '/run/pfms-keep-network';

/** Started by systemd (it sets INVOCATION_ID for every service it runs). */
export function isSupervised(): boolean {
  return !!process.env.INVOCATION_ID;
}

/** Restart in place, keeping the network. `exe` is what to start when no
 *  supervisor will (defaults to this executable). */
export function restartSelf(exe = process.execPath): void {
  try {
    writeFileSync(KEEP_NETWORK_FLAG, '');
  } catch (err) {
    console.error('Could not write the keep-network flag before restarting:', err);
  }
  if (!isSupervised() && isPackagedBinary()) {
    console.log(`Not run by systemd — starting ${exe} to take over`);
    spawn(exe, process.argv.slice(2), {
      detached: true,
      stdio: 'inherit',
      env: { ...process.env, PFMS_WAIT_FOR_PID: String(process.pid) },
    }).unref();
  }
  process.kill(process.pid, 'SIGHUP');
}

/** Wait (up to `ms`) for the process we're replacing to exit. */
export async function waitForPredecessor(ms = 30_000): Promise<void> {
  const pid = Number(process.env.PFMS_WAIT_FOR_PID);
  delete process.env.PFMS_WAIT_FOR_PID;
  if (!pid) return;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone
    }
  }
  console.warn(`Process ${pid} still running after ${ms / 1000} s — starting anyway`);
}
