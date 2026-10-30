import { afterEach, describe, expect, test } from 'bun:test';
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

describe('dry run', () => {
  const savedDryRun = process.env.DRY_RUN;
  afterEach(() => {
    if (savedDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = savedDryRun;
  });

  test('sends nothing to team subnets when DRY_RUN is set, with no help from the caller', async () => {
    process.env.DRY_RUN = '1';
    const ran: string[] = [];

    const results = await new Promise<SubnetScanResults>(resolve => {
      const scanner = new SubnetScanner(
        station => (station === 'slot1' ? 1967 : null),
        scan => {
          scanner.stop();
          resolve(scan);
        },
        undefined,
        undefined,
        undefined,
        async tool => {
          ran.push(tool);
          return { stdout: '' };
        },
      );
      scanner.start(60_000);
    });

    expect(ran).toEqual([]);
    expect(results.stations).toEqual({});
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
        undefined,
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

  describe('guest laptops', () => {
    const flow = (laptop: string, robot: string) => `tcp 6 100 ESTABLISHED src=${laptop} dst=${robot} sport=1 dport=2`;

    async function scanGuests(
      teams: Partial<Record<StationName, number>>,
      conntrack: string[],
      chosen: Record<string, StationName> = {},
    ) {
      const results = await new Promise<SubnetScanResults>(resolve => {
        const scanner = new SubnetScanner(
          station => teams[station] ?? null,
          scan => {
            scanner.stop();
            resolve(scan);
          },
          undefined,
          ip => chosen[ip] ?? null,
          false,
          async tool => ({ stdout: tool === 'conntrack' ? conntrack.join('\n') : '10.19.67.1\n' }),
        );
        scanner.start(60_000);
      });
      const guests = (station: StationName) =>
        results.stations[station]?.hosts.filter(h => h.source === 'conntrack').map(h => h.ip);
      return guests;
    }

    const twoRobots = { slot1: 1967, slot2: 1967 };

    test("one that hasn't chosen a robot is on neither station, so nothing auto-connects it", async () => {
      const guests = await scanGuests(twoRobots, [flow('10.55.1.2', '10.19.67.2')]);
      expect(guests('slot1')).toEqual([]);
      expect(guests('slot2')).toEqual([]);
    });

    test('one that chose a robot is on that station, whichever it is', async () => {
      const onFirst = await scanGuests(twoRobots, [flow('10.55.1.2', '10.19.67.2')], { '10.55.1.2': 'slot1' });
      expect(onFirst('slot1')).toEqual(['10.55.1.2']);
      expect(onFirst('slot2')).toEqual([]);
    });

    test('a choice of some other team does not place it', async () => {
      const guests = await scanGuests(twoRobots, [flow('10.55.1.2', '10.19.67.2')], { '10.55.1.2': 'slot3' });
      expect(guests('slot1')).toEqual([]);
      expect(guests('slot2')).toEqual([]);
    });

    test('a team on one station still gets its guests without choosing', async () => {
      const guests = await scanGuests({ slot1: 1967 }, [flow('10.19.67.2', '10.55.1.2')]);
      expect(guests('slot1')).toEqual(['10.55.1.2']);
    });
  });
});
