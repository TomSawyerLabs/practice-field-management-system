import { afterEach, describe, expect, test } from 'bun:test';
import { aptInstallCommand, aptPackagesFor, installMissingTools } from './hostTools.js';

const savedDryRun = process.env.DRY_RUN;
afterEach(() => {
  if (savedDryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = savedDryRun;
});

describe('apt packages for missing tools', () => {
  test('use the package names, not the binary names', () => {
    expect(aptPackagesFor(['arping', 'dnsmasq', 'aplay', 'dhcpcd', 'fping'])).toEqual([
      'iputils-arping',
      'dnsmasq-base',
      'alsa-utils',
      'dhcpcd5',
      'fping',
    ]);
    expect(aptInstallCommand(['dnsmasq', 'tcpdump'])).toBe('sudo apt install dnsmasq-base tcpdump');
  });
});

describe('installing from the wizard', () => {
  test('never runs apt in a dry run, or off Linux', async () => {
    process.env.DRY_RUN = '1';
    const output: string[] = [];
    const result = await installMissingTools(t => output.push(t));
    // On this machine either nothing is missing (ok, nothing to do) or the
    // install is refused — it never gets as far as running apt-get.
    expect(output).toEqual([]);
    if (!result.ok) expect(result.error).toMatch(/Dry run|only possible on Linux/);
  });
});
