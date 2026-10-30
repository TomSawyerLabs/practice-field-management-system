import { beforeEach, describe, expect, test } from 'bun:test';
import { configureNetwork, duplicateDsBlock, restorePreviousStations, useNetworkBackend } from './networkManager.js';
import { createDryRunBackend, type NetworkBackend } from './node-ip/index.js';
import type { StationName } from './types.js';

/** A backend that keeps each interface's addresses (so a station already
 *  set up reads as unchanged), records the adds, and fails on cue. */
function fakeBackend() {
  const addresses = new Map<string, string[]>();
  const added: string[] = [];
  const failures = { iptablesDelete: false, addAddressOn: new Set<string>() };
  const base = createDryRunBackend();
  const backend: NetworkBackend = {
    ...base,
    async listInterfaces(name?: string) {
      if (!name) return [];
      return [
        {
          name,
          state: 'UP',
          mtu: 1500,
          addresses: (addresses.get(name) ?? []).map(address => ({
            family: 'inet' as const,
            address,
            prefixLength: 24,
          })),
        },
      ];
    },
    async addAddress(opts) {
      if (failures.addAddressOn.has(opts.interfaceName)) throw new Error('RTNETLINK answers: Operation not permitted');
      added.push(`${opts.interfaceName} ${opts.address}`);
      addresses.set(opts.interfaceName, [...(addresses.get(opts.interfaceName) ?? []), opts.address]);
    },
    async iptables(opts) {
      if (failures.iptablesDelete && opts.action === '-D') {
        throw new Error('iptables: Bad rule (does a matching rule exist in that chain?).');
      }
      return base.iptables(opts);
    },
    async removeAddress(opts) {
      addresses.set(
        opts.interfaceName,
        (addresses.get(opts.interfaceName) ?? []).filter(a => a !== opts.address),
      );
    },
  };
  return { backend, added, failures };
}

const none: Record<StationName, number | undefined> = {
  slot1: undefined,
  slot2: undefined,
  slot3: undefined,
  slot4: undefined,
  slot5: undefined,
  slot6: undefined,
};

let fake: ReturnType<typeof fakeBackend>;
beforeEach(() => {
  fake = fakeBackend();
  useNetworkBackend(fake.backend);
  restorePreviousStations(() => null);
});

describe('a station whose old team will not tear down', () => {
  test('still gets its new team', async () => {
    await configureNetwork({ ...none, slot1: 254 }, 'eth0', true);
    fake.failures.iptablesDelete = true;
    await configureNetwork({ ...none, slot1: 1678 }, 'eth0', true);
    expect(fake.added).toContain('br-slot1 10.16.78.254');
  });
});

describe('a station that fails to set up', () => {
  test('does not stop the others, fails the pass, and is retried on the next one', async () => {
    fake.failures.addAddressOn.add('br-slot1');
    const first = configureNetwork({ ...none, slot1: 254, slot2: 1678 }, 'eth0', true);
    await expect(first).rejects.toThrow('slot1');
    expect(fake.added).toEqual(['br-slot2 10.16.78.254']);

    // Same teams again, the fault gone: slot1 is set up, slot2 left alone
    fake.failures.addAddressOn.clear();
    await configureNetwork({ ...none, slot1: 254, slot2: 1678 }, 'eth0', true);
    expect(fake.added).toEqual(['br-slot2 10.16.78.254', 'br-slot1 10.2.54.254']);
  });
});

test("a second laptop loses only its Driver Station's control packets to the robot", () => {
  const rule = duplicateDsBlock('slot2', '10.55.231.82', 'pfms-block-dup-ds-slot2');
  expect(rule).toMatchObject({ source: '10.55.231.82', jump: 'DROP', protocol: 'udp', destinationPort: 1110 });
});
