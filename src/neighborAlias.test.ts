import { describe, expect, test } from 'bun:test';
import { pickIpv4Neighbor } from './neighborAlias.js';

const table = `192.168.1.1 dev eno1 lladdr 74:ac:b9:00:00:01 REACHABLE
192.168.1.57 dev eno1 lladdr a4:83:e7:12:34:56 STALE
10.0.100.40 dev eno1 lladdr a4:83:e7:12:34:56 FAILED
192.168.1.90 dev eno1 FAILED
2600:1700:abcd::57 dev eno1 lladdr a4:83:e7:12:34:56 REACHABLE
fe80::1c2b:3d4e:5f60:7182 dev eno1 lladdr a4:83:e7:12:34:56 router STALE
2600:1700:abcd::99 dev eno1 lladdr 3c:22:fb:00:00:99 REACHABLE`;

describe('the IPv4 address of a client seen over IPv6', () => {
  test('is the live IPv4 neighbour with the same MAC', () => {
    expect(pickIpv4Neighbor(table, '2600:1700:abcd::57')).toBe('192.168.1.57');
  });

  test('a link-local address with a zone works too', () => {
    expect(pickIpv4Neighbor(table, 'fe80::1c2b:3d4e:5f60:7182%eno1')).toBe('192.168.1.57');
  });

  test('is unknown when no IPv4 entry shares the MAC, or the address is not in the table', () => {
    expect(pickIpv4Neighbor(table, '2600:1700:abcd::99')).toBeUndefined();
    expect(pickIpv4Neighbor(table, '2600:1700:abcd::1234')).toBeUndefined();
  });

  test('prefers an entry on the same interface', () => {
    const twoNics = `${table}\n172.16.5.57 dev wlan0 lladdr a4:83:e7:12:34:56 REACHABLE`;
    expect(pickIpv4Neighbor(twoNics, '2600:1700:abcd::57')).toBe('192.168.1.57');
  });
});
