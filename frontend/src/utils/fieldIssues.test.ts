import { describe, expect, test } from 'bun:test';
import type { MatchState, RadioUpdate, StationControlState, StationDetails, StatusEntry } from '../../../src/types';
import {
  detectFieldIssues,
  fieldControlOf,
  groupIssues,
  stationLabel,
  stationOrder,
  worstSeverity,
  type FieldIssueInputs,
} from './fieldIssues';

const NOW = 1_800_000_000_000;

function station(over: Partial<StationDetails> = {}): StationDetails {
  return {
    ssid: '1234',
    hashedWpaKey: '',
    wpaKeySalt: '',
    isLinked: true,
    macAddress: 'aa:bb:cc:dd:ee:ff',
    dataAgeMs: 500,
    signalDbm: -55,
    noiseDbm: -95,
    signalNoiseRatio: 40,
    rxRateMbps: 200,
    rxBytes: 0,
    rxPackets: 0,
    txRateMbps: 200,
    txBytes: 0,
    txPackets: 0,
    bandwidthUsedMbps: 0.4,
    connectionQuality: 'excellent',
    ...over,
  };
}

function radio(stations: Partial<Record<string, StationDetails | null>> = {}): StatusEntry {
  const update: RadioUpdate = {
    channel: 5,
    channelBandwidth: '40MHz',
    redVlans: '10_20_30',
    blueVlans: '40_50_60',
    status: 'ACTIVE',
    stationStatuses: {
      slot1: null,
      slot2: null,
      slot3: null,
      slot4: null,
      slot5: null,
      slot6: null,
      ...stations,
    },
    syslogIpAddress: '',
    version: 'test',
  };
  return { timestamp: NOW - 1000, radioUpdate: update };
}

function control(over: Partial<StationControlState> = {}): StationControlState {
  return {
    teamNumber: 1234,
    enabled: false,
    eStop: false,
    aStop: false,
    mode: 'teleOp',
    joined: false,
    ready: false,
    alliance: null,
    matchSlot: null,
    disabledBy: null,
    ...over,
  };
}

function match(over: Partial<MatchState> = {}): MatchState {
  return {
    type: 'matchState',
    phase: 'idle',
    remainingTime: 0,
    totalMatchTime: 0,
    config: {} as MatchState['config'],
    stationStates: {},
    connectedStations: {},
    readyRequested: false,
    staffStates: {
      headRef: { ready: false, ignored: false, connected: false },
      scorekeeper: { ready: false, ignored: false, connected: false },
      safety: { ready: false, ignored: false, connected: false },
    },
    ...over,
  };
}

function inputs(over: Partial<FieldIssueInputs> = {}): FieldIssueInputs {
  return {
    now: NOW,
    wsConnected: true,
    latest: radio(),
    matchState: match(),
    driveSession: { type: 'driveSessionState', sessions: {}, blockedDs: {} },
    pending: { type: 'pendingCommitState', pending: false },
    networkStats: {
      type: 'networkStats',
      stations: {},
      neighborTable: { entries: 100, limit: 8192, byInterface: {}, overflows: 0 },
    },
    routeState: { type: 'routePreferenceState', yourIp: '10.0.0.9', preference: null, conflictingTeams: {} },
    subnetScan: null,
    telemetry: {},
    lastLinked: {},
    teamChecks: {},
    hostnames: {},
    ...over,
  };
}

const ids = (input: FieldIssueInputs) => detectFieldIssues(input).map(i => i.id);

describe('detectFieldIssues', () => {
  test('an empty, healthy field reports nothing', () => {
    expect(ids(inputs())).toEqual([]);
  });

  test('a linked robot with a Driver Station in a match reports nothing', () => {
    const input = inputs({
      latest: radio({ slot1: station() }),
      matchState: match({
        phase: 'teleop',
        stationStates: {
          slot1: control({ joined: true, enabled: true, matchSlot: 'red1', alliance: 'red', dsAttached: true }),
        },
        connectedStations: { slot1: { ip: '10.55.1.2', lastSeen: NOW - 400, protocol: 'legacy' } },
      }),
      telemetry: {
        slot1: {
          type: 'telemetry',
          station: 'slot1',
          timestamp: NOW - 300,
          batteryVoltage: 12.4,
          rttMs: 8,
          dsStatus: {
            eStop: false,
            aStop: false,
            robotComms: true,
            radioPing: true,
            rioPing: true,
            enabled: true,
            mode: 'teleOp',
          },
        },
      },
    });
    expect(ids(input)).toEqual([]);
  });

  test('losing the websocket is critical', () => {
    const issues = detectFieldIssues(inputs({ wsConnected: false }));
    expect(issues.map(i => i.id)).toEqual(['pfms-disconnected']);
    expect(issues[0].severity).toBe('critical');
  });

  test('an AP that stopped answering is critical', () => {
    const issues = detectFieldIssues(inputs({ latest: { timestamp: NOW - 20_000 } }));
    expect(issues[0].id).toBe('radio-unreachable');
    expect(issues[0].severity).toBe('critical');
    expect(issues[0].detail).toContain('20 s');
  });

  test('radio status that has not refreshed for a long time is a warning', () => {
    const stale = radio();
    stale.timestamp = NOW - 60_000;
    expect(ids(inputs({ latest: stale }))).toEqual(['radio-status-stale']);
  });

  test('an unlinked robot is a warning out of a match and critical in one', () => {
    const cfg = radio({ slot2: station({ isLinked: false }) });
    const out = detectFieldIssues(inputs({ latest: cfg, lastLinked: { slot2: NOW - 90_000 } }));
    expect(out.map(i => i.id)).toEqual(['robot-not-linked-slot2']);
    expect(out[0].severity).toBe('warning');
    expect(out[0].title).toContain('dropped off');
    expect(out[0].detail).toContain('2 min');

    const inMatch = detectFieldIssues(
      inputs({
        latest: cfg,
        matchState: match({
          phase: 'created',
          stationStates: { slot2: control({ joined: true, dsAttached: true }) },
        }),
      }),
    );
    const linkIssue = inMatch.find(i => i.id === 'robot-not-linked-slot2')!;
    expect(linkIssue.severity).toBe('critical');
    expect(linkIssue.title).toContain('has not joined');
    expect(linkIssue.actions).toEqual([{ kind: 'kick', station: 'slot2' }]);
  });

  test('a joined station with no Driver Station is critical and offers Ready anyway during setup', () => {
    const out = detectFieldIssues(
      inputs({
        latest: radio({ slot4: station({ ssid: '4159' }) }),
        matchState: match({
          phase: 'created',
          stationStates: { slot4: control({ teamNumber: 4159, joined: true, dsAttached: false }) },
        }),
      }),
    );
    expect(out.map(i => i.id)).toEqual(['ds-missing-slot4']);
    expect(out[0].severity).toBe('critical');
    expect(out[0].title).toBe('No Driver Station for 4159');
    expect(out[0].fix).toContain('restart the Driver Station');
    expect(out[0].actions).toEqual([
      { kind: 'readyAnyway', station: 'slot4' },
      { kind: 'kick', station: 'slot4' },
    ]);
  });

  test('a Driver Station that went quiet mid-match names the laptop and how long ago', () => {
    const out = detectFieldIssues(
      inputs({
        latest: radio({ slot1: station({ ssid: '6238' }) }),
        matchState: match({
          phase: 'teleop',
          stationStates: { slot1: control({ teamNumber: 6238, joined: true, dsAttached: false, matchSlot: 'blue1' }) },
          connectedStations: { slot1: { ip: '10.55.64.219', lastSeen: NOW - 12_000 } },
        }),
        hostnames: { '10.55.64.219': 'blue-laptop' },
      }),
    );
    const ds = out.find(i => i.id === 'ds-missing-slot1')!;
    expect(ds.severity).toBe('critical');
    expect(ds.title).toContain('gone quiet');
    expect(ds.detail).toContain('12 s ago from blue-laptop (10.55.64.219)');
    expect(ds.detail).toContain('will not respond');
    expect(ds.actions).toEqual([]);
  });

  test('a second Driver Station on a station is a warning with both addresses', () => {
    const out = detectFieldIssues(
      inputs({
        latest: radio({ slot4: station({ ssid: '751' }) }),
        matchState: match({ stationStates: { slot4: control({ teamNumber: 751 }) } }),
        driveSession: {
          type: 'driveSessionState',
          sessions: { slot4: { dsIp: '10.55.48.12', lastActivity: NOW - 1000, timeoutRemaining: 18 } },
          blockedDs: { slot4: ['10.55.165.238'] },
        },
      }),
    );
    const blocked = out.find(i => i.id === 'ds-blocked-slot4')!;
    expect(blocked.severity).toBe('warning');
    expect(blocked.detail).toContain('10.55.165.238');
    expect(blocked.detail).toContain('10.55.48.12');
    expect(blocked.detail).toContain('18 s');
    expect(blocked.fix).toContain('team that had this slot before');
  });

  test('a disabled-by-DS robot mid-match offers Re-enable', () => {
    const out = detectFieldIssues(
      inputs({
        latest: radio({ slot5: station({ ssid: '840' }) }),
        matchState: match({
          phase: 'teleop',
          stationStates: {
            slot5: control({ teamNumber: 840, joined: true, dsAttached: true, disabledBy: 'ds', matchSlot: 'blue2' }),
          },
        }),
      }),
    );
    expect(out.map(i => i.id)).toEqual(['disabled-by-ds-slot5']);
    expect(out[0].actions).toEqual([{ kind: 'reenable', station: 'slot5' }]);
  });

  test('a DS with no robot comms explains which hop is missing', () => {
    const base = {
      latest: radio({ slot3: station({ ssid: '2813' }) }),
      matchState: match({
        phase: 'created',
        stationStates: { slot3: control({ teamNumber: 2813, joined: true, dsAttached: true }) },
      }),
    };
    const at = (radioPing: boolean, rioPing: boolean) =>
      detectFieldIssues(
        inputs({
          ...base,
          telemetry: {
            slot3: {
              type: 'telemetry',
              station: 'slot3',
              timestamp: NOW - 500,
              dsStatus: {
                eStop: false,
                aStop: false,
                robotComms: false,
                radioPing,
                rioPing,
                enabled: false,
                mode: 'teleOp',
              },
            },
          },
        }),
      ).find(i => i.id === 'no-robot-comms-slot3')!;

    expect(at(false, false).detail).toContain('cannot even ping the robot radio');
    expect(at(true, false).detail).toContain('pings the radio but not the roboRIO');
    expect(at(true, true).detail).toContain('no robot code');
    expect(at(true, true).severity).toBe('critical');
  });

  test('stale telemetry is ignored', () => {
    const out = detectFieldIssues(
      inputs({
        latest: radio({ slot3: station({ ssid: '2813' }) }),
        matchState: match({ stationStates: { slot3: control({ teamNumber: 2813, joined: true, dsAttached: true }) } }),
        telemetry: {
          slot3: {
            type: 'telemetry',
            station: 'slot3',
            timestamp: NOW - 60_000,
            dsStatus: {
              eStop: false,
              aStop: false,
              robotComms: false,
              radioPing: false,
              rioPing: false,
              enabled: false,
              mode: 'teleOp',
            },
          },
        },
      }),
    );
    expect(out.find(i => i.id === 'no-robot-comms-slot3')).toBeUndefined();
  });

  test('held Wi-Fi changes offer Apply now unless a match is running', () => {
    const pending = {
      type: 'pendingCommitState' as const,
      pending: true,
      hold: 'match' as const,
      stagedChanges: { slot2: { ssid: '972', secured: true } },
    };
    const idle = detectFieldIssues(inputs({ pending, matchState: match({ phase: 'created' }) }));
    expect(idle.find(i => i.id === 'wifi-held')!.actions).toEqual([{ kind: 'applyWifi' }]);

    const running = detectFieldIssues(inputs({ pending, matchState: match({ phase: 'auto' }) }));
    expect(running.find(i => i.id === 'wifi-held')!.actions).toBeUndefined();
  });

  test('ARP table pressure scales from warning to critical', () => {
    const at = (entries: number, overflows = 0) =>
      detectFieldIssues(
        inputs({
          networkStats: {
            type: 'networkStats',
            stations: {},
            neighborTable: { entries, limit: 1000, byInterface: {}, overflows },
          },
        }),
      ).find(i => i.id === 'arp-table');
    expect(at(500)).toBeUndefined();
    expect(at(750)!.severity).toBe('warning');
    expect(at(950)!.severity).toBe('critical');
    expect(at(100, 2)!.detail).toContain('overflowed 2×');
  });

  test('a team on two stations is a warning with a release for each', () => {
    const out = detectFieldIssues(
      inputs({
        routeState: {
          type: 'routePreferenceState',
          yourIp: '',
          preference: null,
          conflictingTeams: { '4159': ['slot3', 'slot4'] },
        },
      }),
    );
    expect(out.map(i => i.id)).toEqual(['duplicate-team-4159']);
    expect(out[0].actions).toEqual([
      { kind: 'release', station: 'slot3' },
      { kind: 'release', station: 'slot4' },
    ]);
  });

  test('a linked robot with nobody driving is a note, and only once drive sessions are known', () => {
    const cfg = radio({ slot1: station() });
    expect(ids(inputs({ latest: cfg }))).toEqual(['ds-absent-slot1']);
    expect(ids(inputs({ latest: cfg, driveSession: null }))).toEqual([]);
    expect(
      ids(
        inputs({
          latest: cfg,
          driveSession: {
            type: 'driveSessionState',
            sessions: { slot1: { dsIp: '10.55.1.1', lastActivity: NOW, timeoutRemaining: 20 } },
            blockedDs: {},
          },
        }),
      ),
    ).toEqual([]);
  });

  test('weak signal and bandwidth hogs are warnings, marginal signal a note', () => {
    const out = detectFieldIssues(
      inputs({
        driveSession: null,
        latest: radio({
          slot1: station({ ssid: '111', connectionQuality: 'warning', signalDbm: -80 }),
          slot2: station({ ssid: '222', bandwidthUsedMbps: 3.9 }),
          slot3: station({ ssid: '333', connectionQuality: 'caution' }),
        }),
      }),
    );
    expect(out.map(i => [i.id, i.severity])).toEqual([
      ['weak-signal-slot1', 'warning'],
      ['bandwidth-slot2', 'warning'],
      ['marginal-signal-slot3', 'info'],
    ]);
  });

  test('failed team checks are summarised and only when they are about the current team', () => {
    const checks = {
      slot1: {
        type: 'teamCheckResults' as const,
        station: 'slot1' as const,
        team: 1234,
        timestamp: NOW - 60_000,
        checks: [
          { name: 'Radio Team', status: 'fail' as const, actual: '4321' },
          { name: 'roboRIO', status: 'pass' as const },
        ],
      },
    };
    const same = detectFieldIssues(
      inputs({ driveSession: null, latest: radio({ slot1: station() }), teamChecks: checks }),
    );
    expect(same.map(i => i.id)).toEqual(['team-checks-slot1']);
    expect(same[0].detail).toBe('Radio Team: 4321');

    const other = detectFieldIssues(
      inputs({ driveSession: null, latest: radio({ slot1: station({ ssid: '9999' }) }), teamChecks: checks }),
    );
    expect(other.map(i => i.id)).toEqual([]);
  });

  test('issues sort critical → warning → info, field-wide first', () => {
    const out = detectFieldIssues(
      inputs({
        wsConnected: false,
        driveSession: null,
        latest: radio({
          slot1: station({ ssid: '111', isLinked: false }),
          slot2: station({ ssid: '222', connectionQuality: 'caution' }),
        }),
        pending: { type: 'pendingCommitState', pending: true, hold: 'admin', stagedChanges: { slot3: null } },
      }),
    );
    expect(out.map(i => i.id)).toEqual([
      'pfms-disconnected',
      'wifi-held',
      'robot-not-linked-slot1',
      'marginal-signal-slot2',
    ]);
    expect(worstSeverity(out)).toBe('critical');
    expect(worstSeverity([])).toBeUndefined();
  });
});

describe('groupIssues', () => {
  test('folds same-kind station issues into one row, keeping distinct variants apart', () => {
    const out = detectFieldIssues(
      inputs({
        driveSession: null,
        latest: radio({
          slot1: station({ ssid: '111', isLinked: false }),
          slot2: station({ ssid: '222', isLinked: false }),
          slot3: station({ ssid: '333', isLinked: false }),
          slot4: station({ ssid: '444', connectionQuality: 'warning' }),
        }),
        lastLinked: { slot3: NOW - 30_000 },
        pending: { type: 'pendingCommitState', pending: true, hold: 'admin', stagedChanges: { slot5: null } },
      }),
    );
    const rows = groupIssues(out);
    expect(
      rows.map(r => (r.type === 'one' ? r.issue.id : `${r.title} [${r.members.map(m => m.station).join(',')}]`)),
    ).toEqual([
      'wifi-held',
      '2 robots have not joined the field Wi-Fi [slot1,slot2]',
      'robot-not-linked-slot3',
      'weak-signal-slot4',
    ]);
    const group = rows[1];
    if (group.type !== 'group') throw new Error('expected a group');
    expect(group.severity).toBe('warning');
    expect(group.members.map(m => m.evidence)).toEqual(['never linked', 'never linked']);
    expect(group.fix).toBe(out.find(i => i.id === 'robot-not-linked-slot1')!.fix);
  });

  test('does not fold across severities or field-wide issues', () => {
    const cfg = radio({
      slot1: station({ ssid: '111', isLinked: false }),
      slot2: station({ ssid: '222', isLinked: false }),
    });
    const out = detectFieldIssues(
      inputs({
        driveSession: null,
        latest: cfg,
        matchState: match({
          phase: 'created',
          stationStates: { slot1: control({ teamNumber: 111, joined: true, dsAttached: true }) },
        }),
      }),
    );
    const rows = groupIssues(out);
    expect(rows.map(r => r.type)).toEqual(['one', 'one']);
    expect(rows.map(r => (r.type === 'one' ? r.issue.severity : ''))).toEqual(['critical', 'warning']);
  });

  test('collects every member action', () => {
    const cfg = radio({ slot1: station({ ssid: '111' }), slot2: station({ ssid: '222' }) });
    const out = detectFieldIssues(
      inputs({
        latest: cfg,
        matchState: match({
          phase: 'created',
          stationStates: {
            slot1: control({ teamNumber: 111, joined: true, dsAttached: false }),
            slot2: control({ teamNumber: 222, joined: true, dsAttached: false }),
          },
        }),
      }),
    );
    const rows = groupIssues(out);
    expect(rows).toHaveLength(1);
    const g = rows[0];
    if (g.type !== 'group') throw new Error('expected a group');
    expect(g.title).toBe('2 robots in the match have no Driver Station');
    expect(g.actions).toEqual([
      { kind: 'readyAnyway', station: 'slot1' },
      { kind: 'kick', station: 'slot1' },
      { kind: 'readyAnyway', station: 'slot2' },
      { kind: 'kick', station: 'slot2' },
    ]);
  });
});

describe('radio out of sync', () => {
  test('an unjoined station whose radio disagrees with pFMS is a warning, quiet while the AP reconfigures', () => {
    const states = { slot1: control({ teamNumber: 1234 }), slot2: control({ teamNumber: 972 }) };
    const cfg = radio({ slot1: station({ ssid: '5555' }) });
    const out = detectFieldIssues(
      inputs({ driveSession: null, latest: cfg, matchState: match({ stationStates: states }) }),
    );
    expect(out.map(i => i.id)).toEqual(['radio-out-of-sync-slot1', 'radio-out-of-sync-slot2']);
    expect(out[0].title).toContain('has 5555');
    expect(out[1].title).toContain('has nothing');

    cfg.radioUpdate!.status = 'CONFIGURING';
    const quiet = detectFieldIssues(
      inputs({ driveSession: null, latest: cfg, matchState: match({ stationStates: states }) }),
    );
    expect(quiet.map(i => i.id)).toEqual([]);
  });

  test('Wi-Fi link problems are hidden while the AP reconfigures or boots; DS problems are not', () => {
    const cfg = radio({
      slot1: station({ ssid: '1234', isLinked: false }),
      slot2: station({ ssid: '972', isLinked: false }),
    });
    const states = {
      slot1: control({ teamNumber: 1234 }),
      slot2: control({ teamNumber: 972, joined: true, dsAttached: false }),
    };
    const active = detectFieldIssues(
      inputs({ driveSession: null, latest: cfg, matchState: match({ phase: 'created', stationStates: states }) }),
    );
    // slot2 is joined during setup, so its link loss is critical and sorts first.
    expect(active.map(i => i.id)).toEqual(['robot-not-linked-slot2', 'ds-missing-slot2', 'robot-not-linked-slot1']);

    for (const status of ['CONFIGURING', 'BOOTING'] as const) {
      cfg.radioUpdate!.status = status;
      const during = detectFieldIssues(
        inputs({ driveSession: null, latest: cfg, matchState: match({ phase: 'created', stationStates: states }) }),
      );
      expect(during.map(i => i.id)).toEqual(['ds-missing-slot2']);
    }
  });

  test('a joined station with a held change is only a note', () => {
    const out = detectFieldIssues(
      inputs({
        driveSession: null,
        latest: radio({ slot1: station({ ssid: '5555' }) }),
        matchState: match({
          phase: 'created',
          stationStates: { slot1: control({ teamNumber: 1234, joined: true, dsAttached: true }) },
        }),
      }),
    );
    expect(out.find(i => i.id === 'team-mismatch-slot1')!.severity).toBe('info');
    expect(out.find(i => i.id === 'radio-out-of-sync-slot1')).toBeUndefined();
  });
});

describe('order by time on the field', () => {
  test('stationOrder puts the longest-connected robot first, unknown counts as oldest, ties by slot', () => {
    const ms = match({
      stationStates: {
        slot1: control({ teamNumber: 111, connectedAt: NOW - 1000 }),
        slot2: control({ teamNumber: 222, connectedAt: NOW - 60_000 }),
        slot3: control({ teamNumber: 333 }),
        slot5: control({ teamNumber: 555, connectedAt: NOW - 60_000 }),
      },
    });
    expect(stationOrder(ms)).toEqual(['slot3', 'slot4', 'slot6', 'slot2', 'slot5', 'slot1']);
    expect(stationOrder(null)).toEqual(['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6']);
  });

  test('issues of equal severity follow that order, and never name a slot', () => {
    const out = detectFieldIssues(
      inputs({
        driveSession: null,
        latest: radio({
          slot1: station({ ssid: '111', isLinked: false }),
          slot4: station({ ssid: '444', isLinked: false }),
        }),
        matchState: match({
          stationStates: {
            slot1: control({ teamNumber: 111, connectedAt: NOW - 1000 }),
            slot4: control({ teamNumber: 444, connectedAt: NOW - 90_000 }),
          },
        }),
      }),
    );
    expect(out.map(i => i.id)).toEqual(['robot-not-linked-slot4', 'robot-not-linked-slot1']);
    for (const i of out) expect(`${i.title} ${i.detail} ${i.fix}`).not.toMatch(/\bSlot [1-6]\b/);
  });

  test('stationLabel names a station by its robot', () => {
    const input = inputs({
      latest: radio({ slot1: station({ ssid: '4159-Comp' }) }),
      matchState: match({ stationStates: { slot2: control({ teamNumber: 972 }) } }),
    });
    expect(stationLabel(input, 'slot1')).toBe('4159-Comp');
    expect(stationLabel(input, 'slot2')).toBe('team 972');
    expect(stationLabel(input, 'slot3')).toBe('this robot');
  });

  test('held Wi-Fi changes are described by robot, not slot', () => {
    const out = detectFieldIssues(
      inputs({
        latest: radio({ slot1: station({ ssid: '111' }) }),
        pending: {
          type: 'pendingCommitState',
          pending: true,
          hold: 'admin',
          stagedChanges: { slot1: null, slot2: { ssid: '222', secured: true } },
        },
      }),
    );
    expect(out.find(i => i.id === 'wifi-held')!.detail).toContain('Waiting: 111 leaves; 222 joins.');
  });
});

describe('robots heard on 2.4 GHz', () => {
  test('a robot whose name differs only in capitals is a critical issue for its team', () => {
    const out = detectFieldIssues(
      inputs({
        robotWifi: {
          type: 'robotWifiScan',
          status: 'running',
          interfaces: [],
          stalls: [],
          broadcasts: [
            {
              ssid: 'FRC-1234-Comp',
              team: 1234,
              robotSsid: '1234-Comp',
              signal: -60,
              frequency: 2437,
              lastSeen: NOW,
              match: { kind: 'caseOnly', savedSsid: '1234-comp' },
            },
          ],
        },
      }),
    );
    const issue = out.find(i => i.id === 'robotWifi-case-FRC-1234-Comp');
    expect(issue).toMatchObject({ severity: 'critical', team: 1234 });
    expect(issue?.station).toBeUndefined();
  });

  test("another access point with a name the field is serving is critical, on that team's station", () => {
    const out = detectFieldIssues(
      inputs({
        sixGhzWatch: {
          type: 'sixGhzWatch',
          status: 'running',
          channels: 59,
          networks: [],
          clashes: [
            {
              ssid: '1234-Robot',
              team: 1234,
              kind: 'competing',
              station: 'slot2',
              others: [{ bssid: 'aa:00:00:00:00:01', frequency: 6135, signal: -60 }],
            },
          ],
        },
      }),
    );
    expect(out.find(i => i.id === 'sixGhzWatch-competing-1234-Robot')).toMatchObject({
      severity: 'critical',
      team: 1234,
      station: 'slot2',
    });
  });
});

describe('fieldControlOf', () => {
  /** Telemetry from the robot's own packets, `enabled` as given. */
  const robotSays = (enabled: boolean, eStop = false) => ({
    slot1: {
      type: 'telemetry' as const,
      station: 'slot1' as const,
      timestamp: NOW - 200,
      dsStatus: {
        eStop,
        aStop: false,
        robotComms: true,
        radioPing: true,
        rioPing: true,
        enabled,
        mode: 'teleOp' as const,
      },
    },
  });
  const withState = (over: Partial<StationControlState>, extra: Partial<FieldIssueInputs> = {}) =>
    inputs({
      latest: radio({ slot1: station() }),
      matchState: match({ stationStates: { slot1: control(over) } }),
      ...extra,
    });

  test('out of a match and not held: the team’s own control', () => {
    const fc = fieldControlOf(withState({}, { telemetry: robotSays(true) }), 'slot1');
    expect(fc.kind).toBe('team');
    expect(fc.robot).toBe('enabled');
    expect(fc.mismatch).toBe(false);
  });

  test('held by staff, robot disabled: held, no alarm', () => {
    const fc = fieldControlOf(
      withState(
        { heldReason: 'Field staff have turned off freeplay outside matches.' },
        { telemetry: robotSays(false) },
      ),
      'slot1',
    );
    expect(fc.kind).toBe('held');
    expect(fc.mismatch).toBe(false);
  });

  test('e-stopped wins over everything, and an enabled robot under it is an alarm', () => {
    const input = withState({ eStop: true, joined: true, enabled: false }, { telemetry: robotSays(true) });
    expect(fieldControlOf(input, 'slot1').kind).toBe('estop');
    expect(ids(input)).toContain('enabled-while-held-slot1');
  });

  test('in a match: enabled, or disabled with the reason', () => {
    expect(fieldControlOf(withState({ joined: true, enabled: true }), 'slot1').kind).toBe('matchEnabled');
    const off = fieldControlOf(withState({ joined: true, enabled: false, disabledBy: 'ds' }), 'slot1');
    expect(off.kind).toBe('matchDisabled');
    expect(off.why).toContain('Driver Station');
  });

  test('a stale robot sample says nothing about the robot', () => {
    const tele = robotSays(true);
    tele.slot1.timestamp = NOW - 60_000;
    expect(fieldControlOf(withState({}, { telemetry: tele }), 'slot1').robot).toBeUndefined();
  });

  test('a DS reporting to the field while the team should have control is flagged, except just after a match', () => {
    const stuck = withState({ dsAttached: true });
    expect(fieldControlOf(stuck, 'slot1').dsUnderField).toBe(true);
    expect(ids(stuck)).toContain('ds-under-field-slot1');
    const afterMatch = inputs({
      latest: radio({ slot1: station() }),
      matchState: match({ phase: 'postMatch', stationStates: { slot1: control({ dsAttached: true }) } }),
    });
    expect(fieldControlOf(afterMatch, 'slot1').dsUnderField).toBe(false);
  });
});

describe('robot link timed by the field', () => {
  const linkTele = (lossPct: number, rttMs = 3) => ({
    slot1: {
      type: 'telemetry' as const,
      station: 'slot1' as const,
      timestamp: NOW - 200,
      robotLinkLossPct: lossPct,
      robotLinkRttMs: rttMs,
      dsStatus: {
        eStop: false,
        aStop: false,
        robotComms: true,
        radioPing: true,
        rioPing: true,
        enabled: false,
        mode: 'teleOp' as const,
      },
    },
  });

  test('a lossy link out of a match is reported', () => {
    const input = inputs({
      latest: radio({ slot1: station() }),
      matchState: match({ stationStates: { slot1: control() } }),
      telemetry: linkTele(30),
    });
    expect(ids(input)).toContain('robot-link-loss-slot1');
  });

  test('not while the field itself is cutting the robot off', () => {
    const input = inputs({
      latest: radio({ slot1: station() }),
      matchState: match({ stationStates: { slot1: control({ teamStopped: true }) } }),
      telemetry: linkTele(100),
    });
    expect(ids(input)).not.toContain('robot-link-loss-slot1');
  });

  test('a slow field-to-robot round trip is reported when the DS gives no trip time', () => {
    const input = inputs({
      latest: radio({ slot1: station() }),
      matchState: match({ stationStates: { slot1: control() } }),
      telemetry: linkTele(0, 80),
    });
    expect(ids(input)).toContain('robot-link-rtt-slot1');
  });
});
