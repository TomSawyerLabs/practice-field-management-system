/**
 * The system tools pFMS uses, and installing the missing ones with apt from
 * the setup wizard (pFMS runs as root under systemd).
 *
 * The package list is always worked out here, from what is missing on the
 * host — never taken from a client — so the wizard can only ever install
 * these packages.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { skippedInDryRun } from './dryRun.js';

const execFileAsync = promisify(execFile);

/** Tools pFMS needs to run the field network. */
export const REQUIRED_TOOLS = ['iptables', 'arping', 'fping', 'dnsmasq', 'conntrack', 'tcpdump'];

/** Tools that only degrade a feature: [tool, what needs it]. */
export const OPTIONAL_TOOLS: [tool: string, why: string][] = [
  ['aplay', 'field match audio'],
  ['dhcpcd', 'the robot tester'],
];

/** apt package names differ from binary names for a few of these. */
const APT_PACKAGES: Record<string, string> = {
  arping: 'iputils-arping',
  dnsmasq: 'dnsmasq-base',
  dhcpcd: 'dhcpcd5',
  aplay: 'alsa-utils',
};

export async function hasTool(tool: string): Promise<boolean> {
  try {
    await execFileAsync('which', [tool]);
    return true;
  } catch {
    return false;
  }
}

/** The tools in `tools` that aren't on the PATH. */
export async function missingTools(tools: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const tool of tools) if (!(await hasTool(tool))) missing.push(tool);
  return missing;
}

/** The apt packages that provide these tools. */
export function aptPackagesFor(tools: string[]): string[] {
  return [...new Set(tools.map(t => APT_PACKAGES[t] ?? t))];
}

/** The apt command that installs these tools, for a person to run. */
export function aptInstallCommand(tools: string[]): string {
  return `sudo apt install ${aptPackagesFor(tools).join(' ')}`;
}

/** Every required and optional tool missing on this host. */
export async function allMissingTools(): Promise<string[]> {
  return missingTools([...REQUIRED_TOOLS, ...OPTIONAL_TOOLS.map(([t]) => t)]);
}

export type InstallResult = { ok: true; installed: string[] } | { ok: false; error: string };

let installing = false;

/**
 * Install the packages for every missing tool: `apt-get update`, then
 * `apt-get install -y`. Output is passed to `onOutput` as it arrives. One
 * install at a time.
 */
export async function installMissingTools(onOutput: (text: string) => void): Promise<InstallResult> {
  if (installing) return { ok: false, error: 'An install is already running' };
  if (process.platform !== 'linux') return { ok: false, error: 'Installing tools is only possible on Linux' };
  const missing = await allMissingTools();
  if (missing.length === 0) return { ok: true, installed: [] };
  const packages = aptPackagesFor(missing);
  if (skippedInDryRun(`apt-get install ${packages.join(' ')}`)) {
    return { ok: false, error: 'Dry run: nothing was installed' };
  }
  if (!(await hasTool('apt-get'))) {
    return {
      ok: false,
      error: `apt-get isn't available here. Install these with your package manager: ${packages.join(', ')}`,
    };
  }

  installing = true;
  try {
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
    const run = (args: string[]) =>
      new Promise<number>((resolve, reject) => {
        onOutput(`$ apt-get ${args.join(' ')}\n`);
        const proc = spawn('apt-get', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.setEncoding('utf-8').on('data', onOutput);
        proc.stderr.setEncoding('utf-8').on('data', onOutput);
        proc.on('error', reject);
        proc.on('exit', code => resolve(code ?? 1));
      });
    if ((await run(['update'])) !== 0) {
      return { ok: false, error: 'apt-get update failed — see the output (no internet, or apt is busy?)' };
    }
    if ((await run(['install', '-y', '--no-install-recommends', ...packages])) !== 0) {
      return { ok: false, error: 'apt-get install failed — see the output' };
    }
    return { ok: true, installed: packages };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    installing = false;
  }
}
