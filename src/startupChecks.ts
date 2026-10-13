import { appWarn } from './appLogger.js';
import type { NetworkBackend } from './node-ip/index.js';

/**
 * Parse the firmware mode from the radio version string.
 * Expected format: VH-109_AP_PRACTICE_1.2.9-02102025
 */
export function detectFirmwareMode(version: string): 'PRACTICE' | 'OFFSEASON' | 'FRC' | 'UNKNOWN' {
  const upper = version.toUpperCase();

  if (upper.includes('OFFSEASON')) {
    console.log(`Radio firmware: OFFSEASON (${version})`);
    return 'OFFSEASON';
  }

  if (upper.includes('PRACTICE')) {
    console.log(`Radio firmware: PRACTICE (${version})`);
    console.log('PRACTICE firmware handles DHCP — skipping dnsmasq for team subnets.');
    return 'PRACTICE';
  }

  if (upper.includes('FRC')) {
    console.log(`Radio firmware: FRC (${version})`);
    appWarn('FRC firmware detected. This mode requires bearer token authentication.');
    return 'FRC';
  }

  appWarn(`Radio firmware: UNKNOWN (${version})`);
  return 'UNKNOWN';
}

/**
 * Ensure that the VLAN interface has the expected IPs configured.
 * Adds any missing IPs automatically.
 */
export async function checkInterfaceIps(iface: string, expectedIps: string[], net: NetworkBackend): Promise<void> {
  const interfaces = await net.listInterfaces(iface);

  if (interfaces.length === 0) {
    console.error(`Interface check: ${iface} does not exist`);
    return;
  }

  const info = interfaces[0];
  const assignedIps = info.addresses.filter(a => a.family === 'inet').map(a => a.address);

  console.log(
    `Interface ${iface}: ${assignedIps.length > 0 ? assignedIps.join(', ') : 'no IPv4 addresses'} (${info.state})`,
  );

  for (const expected of expectedIps) {
    if (assignedIps.includes(expected)) {
      console.log(`  OK: ${expected}`);
    } else {
      console.log(`  Adding ${expected}/24 to ${iface}`);
      await net.addAddress({ interfaceName: iface, address: expected, prefixLength: 24 });
    }
  }
}

/** The tools in `tools` that aren't on the PATH. */
export async function missingTools(tools: string[]): Promise<string[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const missing: string[] = [];
  for (const tool of tools) {
    try {
      await exec('which', [tool]);
    } catch {
      missing.push(tool);
    }
  }
  return missing;
}

/** The apt command that installs these tools. */
export function aptInstallCommand(tools: string[]): string {
  return `sudo apt install ${tools.map(t => (t === 'arping' ? 'iputils-arping' : t)).join(' ')}`;
}
