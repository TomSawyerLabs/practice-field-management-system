import { describe, expect, test } from 'bun:test';
import { SubnetScanner, fpingArgs } from './subnetScanner.js';
import type { StationName, SubnetScanResults } from './types.js';

describe('fpingArgs', () => {
  test('pins the sweep to the bridge when there is one', () => {
    expect(fpingArgs('10.19.67.1', '10.19.67.253', 'br-slot2').slice(0, 2)).toEqual(['-I', 'br-slot2']);
  });

  test('leaves routing to the host without one', () => {
    expect(fpingArgs('10.19.67.1', '10.19.67.253')).not.toContain('-I');
  });
});

describe('two robots of one team', () => {
  test('each station lists the devices on its own bridge', async () => {
    const teams: Partial<Record<StationName, number>> = { slot1: 1967, slot2: 1967 };
    const devices: Record<string, string[]> = {
      'br-slot1': ['10.19.67.1', '10.19.67.2', '10.19.67.14'],
      'br-slot2': ['10.19.67.1', '10.19.67.2', '10.19.67.20'],
    };
    const ran: string[][] = [];

    const results = await new Promise<SubnetScanResults>(resolve => {
      const scanner = new SubnetScanner(
        station => teams[station] ?? null,
        scan => {
          scanner.stop();
          resolve(scan);
        },
        station => (station === 'slot1' ? 'br-slot1' : 'br-slot2'),
        false,
        async (tool, args) => {
          ran.push([tool, ...args]);
          if (tool !== 'fping') return { stdout: '' };
          return { stdout: `${devices[args[1]].join('\n')}\n` };
        },
      );
      scanner.start(60_000);
    });

    const ips = (station: StationName) => results.stations[station]?.hosts.map(h => h.ip);
    expect(ips('slot1')).toEqual(devices['br-slot1']);
    expect(ips('slot2')).toEqual(devices['br-slot2']);
    expect(ran.filter(([tool]) => tool === 'fping')).toHaveLength(2);
  });
});
