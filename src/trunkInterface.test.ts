import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDryRunBackend, type NetworkBackend } from './node-ip/index.js';
import { useNetworkBackend } from './networkManager.js';
import { FIELD_CONTROL_ADDRESS, bringUpTrunk, tearDownTrunk } from './trunkInterface.js';

/** A host with a couple of NICs, recording what pFMS does to it. Nothing
 *  here touches a real interface. */
function fakeHost(existing: Record<string, string[]>) {
  const addresses = new Map(Object.entries(existing));
  const calls: string[] = [];
  const base = createDryRunBackend();
  const backend: NetworkBackend = {
    ...base,
    async listInterfaces(name?: string) {
      const names = name ? (addresses.has(name) ? [name] : []) : [...addresses.keys()];
      return names.map(n => ({
        name: n,
        state: 'UP',
        mtu: 1500,
        addresses: (addresses.get(n) ?? []).map(address => ({ family: 'inet' as const, address, prefixLength: 24 })),
      }));
    },
    async setInterfaceUp(name) {
      calls.push(`up ${name}`);
    },
    async setInterfaceDown(name) {
      calls.push(`down ${name}`);
    },
    async deleteInterface(name) {
      calls.push(`delete ${name}`);
      addresses.delete(name);
    },
    async addAddress(o) {
      calls.push(`add ${o.address} ${o.interfaceName}`);
      addresses.set(o.interfaceName, [...(addresses.get(o.interfaceName) ?? []), o.address]);
    },
    async removeAddress(o) {
      calls.push(`remove ${o.address} ${o.interfaceName}`);
      addresses.set(
        o.interfaceName,
        (addresses.get(o.interfaceName) ?? []).filter(a => a !== o.address),
      );
    },
    async iptables(o) {
      calls.push(`iptables ${o.action} ${o.chain} ${o.inInterface ?? ''}>${o.outInterface ?? ''} ${o.comment ?? ''}`);
    },
    async flushRulesByComment(prefix) {
      calls.push(`flush ${prefix}`);
    },
    async setSysctl(o) {
      calls.push(`sysctl ${o.key}=${o.value}`);
    },
  };
  return { backend, calls, addresses };
}

const savedDryRun = process.env.DRY_RUN;
beforeEach(() => {
  // Skips the host checks (tools on the PATH, the NIC existing) — the fake
  // host stands in for them — and keeps `ip route flush` from running.
  process.env.DRY_RUN = '1';
});
afterEach(() => {
  if (savedDryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = savedDryRun;
});

describe('bringing up a trunk', () => {
  test('sets the link up, takes field control, and installs the trunk rules', async () => {
    const host = fakeHost({ eno1: [], eno2: [] });
    useNetworkBackend(host.backend);
    expect(await bringUpTrunk('eno2', { keepNetwork: false })).toEqual({ ok: true });
    expect(host.calls).toContain('up eno2');
    expect(host.addresses.get('eno2')).toEqual([FIELD_CONTROL_ADDRESS]);
    expect(host.calls).toContain('flush pfms-');
    expect(host.calls).toContain('sysctl net.ipv4.ip_forward=1');
    expect(host.calls.some(c => c.startsWith('iptables -I FORWARD eno2>eno2 pfms-no-hairpin'))).toBe(true);
    // Nothing on the other NIC
    expect(host.calls.some(c => c.includes('eno1'))).toBe(false);
  });

  test('a graceful restart keeps the rules already in the kernel', async () => {
    const host = fakeHost({ eno1: [FIELD_CONTROL_ADDRESS] });
    useNetworkBackend(host.backend);
    await bringUpTrunk('eno1', { keepNetwork: true });
    expect(host.calls).not.toContain('flush pfms-');
    expect(host.calls.filter(c => c.startsWith('add '))).toEqual([]); // address already there
  });
});

describe('tearing down a trunk', () => {
  test('removes the station VLANs and bridges, field control, and every pFMS rule', async () => {
    const host = fakeHost({
      eno1: [FIELD_CONTROL_ADDRESS],
      'eno1.slot1': [],
      'br-slot1': ['10.59.40.254'],
      'eno1.slot4': [],
      'br-slot4': ['10.2.54.254'],
      eno2: [],
    });
    useNetworkBackend(host.backend);
    await tearDownTrunk('eno1');
    expect([...host.addresses.keys()].sort()).toEqual(['eno1', 'eno2']);
    expect(host.addresses.get('eno1')).toEqual([]);
    expect(host.calls).toContain('flush pfms-');
    // The NIC itself stays up — it may carry other things
    expect(host.calls).not.toContain('down eno1');
  });
});

describe('moving the trunk', () => {
  test('leaves nothing on the old NIC and everything on the new one', async () => {
    const host = fakeHost({ eno1: [], eno2: [] });
    useNetworkBackend(host.backend);
    await bringUpTrunk('eno1', { keepNetwork: false });
    await tearDownTrunk('eno1');
    await bringUpTrunk('eno2', { keepNetwork: false });
    expect(host.addresses.get('eno1')).toEqual([]);
    expect(host.addresses.get('eno2')).toEqual([FIELD_CONTROL_ADDRESS]);
  });
});
