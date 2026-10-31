import { describe, expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { isOnSite, ON_SITE_IPV6_PREFIX, OnLinkChecker, onLinkPrefixes, type InterfaceTable } from './onLink.js';

const v4 = (address: string, cidr: string): NetworkInterfaceInfo =>
  ({ address, netmask: '', family: 'IPv4', mac: '', internal: false, cidr }) as NetworkInterfaceInfo;
const v6 = (address: string, cidr: string): NetworkInterfaceInfo =>
  ({ address, netmask: '', family: 'IPv6', mac: '', internal: false, cidr, scopeid: 0 }) as NetworkInterfaceInfo;

const WITH_IPV6: InterfaceTable = {
  eno1: [
    v4('10.0.100.5', '10.0.100.5/24'),
    v6('2600:1700:459:8a1f::1a5', '2600:1700:459:8a1f::1a5/128'), // a DHCPv6 lease: one address
    v6('2600:1700:459:8a1f:1e69:7aff:fea2:713c', '2600:1700:459:8a1f:1e69:7aff:fea2:713c/64'),
    v6('fe80::1e69:7aff:fea2:713c', 'fe80::1e69:7aff:fea2:713c/64'),
  ],
};
/** Like steamboat on 2026-10-30, no global IPv6, plus one public network. */
const NO_GLOBAL_IPV6: InterfaceTable = {
  eno1: [v4('10.0.100.5', '10.0.100.5/24'), v6('fe80::1e69:7aff:fea2:713c', 'fe80::1e69:7aff:fea2:713c/64')],
  public: [v4('198.51.100.5', '198.51.100.5/24')],
};

const site = (table: InterfaceTable) => new OnLinkChecker(60_000, () => table, ON_SITE_IPV6_PREFIX);

describe('onLinkPrefixes', () => {
  test('widening reaches global IPv6 only', () => {
    expect(onLinkPrefixes(WITH_IPV6, 60).map(p => p.cidr)).toEqual([
      '10.0.100.0/24',
      '2600:1700:459:8a10::/60',
      'fe80::/64',
    ]);
  });

  test('left alone without it', () => {
    expect(onLinkPrefixes(WITH_IPV6).map(p => p.cidr)).toContain('2600:1700:459:8a1f::/64');
  });
});

describe('isOnSite', () => {
  test.each([
    ['guest Wi-Fi', '10.55.65.20'],
    ['a team network', '10.16.78.5'],
    ['the office LAN', '192.168.69.8'],
    ['a Docker bridge', '172.17.0.2'],
    ['this host', '127.0.0.1'],
    ['this host, IPv6', '::1'],
    ['a mapped address', '::ffff:10.55.65.20'],
    ['a ULA', 'fd12:3456:789a::1'],
    ['link-local', 'fe80::1'],
    ['link-local with a zone', 'fe80::1%eno1'],
  ])('%s is on site', (_, ip) => {
    expect(isOnSite(ip, site(NO_GLOBAL_IPV6))).toBe(true);
  });

  test.each([
    ['the internet', '203.0.113.7'],
    ['a mapped internet address', '::ffff:203.0.113.7'],
    ['a Cloudflare edge', '172.70.176.14'],
    ['just past the 172.16/12 range', '172.32.0.1'],
    ['the internet over IPv6', '2606:4700:3037::6815:1ece'],
    ['an unknown socket', 'unknown'],
    ['a garbled header', '[::1]:443'],
    ['an empty string', ''],
  ])('%s is not', (_, ip) => {
    expect(isOnSite(ip, site(NO_GLOBAL_IPV6))).toBe(false);
  });

  test("a public address on one of this host's networks is", () => {
    expect(isOnSite('198.51.100.9', site(NO_GLOBAL_IPV6))).toBe(true);
  });

  test('IPv6 matches the proxy: the whole delegation, sibling VLANs too', () => {
    const networks = site(WITH_IPV6);
    expect(isOnSite('2600:1700:459:8a1f::9', networks)).toBe(true);
    expect(isOnSite('2600:1700:459:8a12::9', networks)).toBe(true);
    expect(isOnSite('2600:1700:459:8a20::9', networks)).toBe(false);
  });
});
