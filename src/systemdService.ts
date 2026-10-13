/**
 * Installing pFMS as a systemd service from the setup wizard, so it comes
 * back after a reboot — the alternative to following docs/deployment.md by
 * hand, which the wizard still shows.
 *
 * The unit runs pFMS exactly the way it is running now (same runtime, same
 * entry point, same working directory, where its state files live). It is
 * enabled for boot but not started: this copy is already running, and a
 * second one would fight it for the ports.
 */
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { skippedInDryRun } from './dryRun.js';

const execFileAsync = promisify(execFile);

export const SERVICE_NAME = 'practice-field-management-system';
export const SYSTEMD_UNIT = `/etc/systemd/system/${SERVICE_NAME}.service`;

/** systemd splits ExecStart on spaces; quote anything that has them. */
function quote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg;
}

/** The unit file for running pFMS as it runs now. */
export function unitFileFor(opts: { workingDirectory: string; execStart: string[] }): string {
  return `[Unit]
Description=Practice Field Management System Backend
After=network.target

[Service]
# Optional: settings from the setup wizard live in setup-config.json instead.
EnvironmentFile=-/etc/pfms/environment
WorkingDirectory=${opts.workingDirectory}
ExecStart=${opts.execStart.map(quote).join(' ')}
# Graceful reload: preserve network rules across restarts
ExecReload=/bin/sh -c 'touch /run/pfms-keep-network && kill -HUP $MAINPID'
Restart=always

[Install]
WantedBy=multi-user.target
`;
}

/** How this process was started: runtime and entry point. */
export function currentExecStart(argv = process.argv, execPath = process.execPath): string[] {
  // A `bun build --compile` binary is its own entry point; argv[1] is the
  // virtual path of the embedded script (`/$bunfs/root/pfms`, or
  // `B:/~BUN/root/pfms.exe` on Windows), which doesn't exist on disk.
  if (/^(\/\$bunfs\/|B:[\\/]~BUN[\\/])/.test(argv[1] ?? '')) return [execPath];
  return [execPath, resolve(argv[1] ?? 'dist')];
}

export type ServiceInstallResult = { ok: true; unit: string } | { ok: false; error: string };

/** Write the unit, reload systemd, and enable the service for boot. */
export async function installSystemdService(): Promise<ServiceInstallResult> {
  if (process.platform !== 'linux' || !existsSync('/run/systemd/system')) {
    return { ok: false, error: 'This host is not running systemd' };
  }
  if (existsSync(SYSTEMD_UNIT)) return { ok: false, error: `${SYSTEMD_UNIT} already exists` };
  const unit = unitFileFor({ workingDirectory: process.cwd(), execStart: currentExecStart() });
  if (skippedInDryRun(`write ${SYSTEMD_UNIT} and enable ${SERVICE_NAME}`)) {
    return { ok: false, error: 'Dry run: the service was not installed' };
  }
  try {
    writeFileSync(SYSTEMD_UNIT, unit, { mode: 0o644 });
    await execFileAsync('systemctl', ['daemon-reload']);
    await execFileAsync('systemctl', ['enable', SERVICE_NAME]);
    return { ok: true, unit };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
