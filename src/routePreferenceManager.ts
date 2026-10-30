import { isIPv4, isIPv6 } from 'node:net';
import { StationName, StationNameList } from './types.js';
import { networkBackend as net, vlanMap } from './networkManager.js';
import { teamSubnet } from './utils.js';
import { appInfo, appWarn } from './appLogger.js';
import type { IpRuleOptions } from './node-ip/types.js';

type Preference = {
  station: StationName;
  team: number;
  subnet: string;
  /** Which `ip rule` is this one, so removing it can't take another. */
  priority: number;
};

/** In-memory map of laptopIP → active routing preference */
const preferences = new Map<string, Preference>();

/** Just above `from all lookup main` (32766). New rules take the first number
 *  free from here down, so they stay in a band as wide as the laptops on the
 *  field, instead of the kernel's next-lowest, which only ever falls. */
const HIGHEST_RULE_PRIORITY = 32765;

function freeRulePriority(): number {
  const used = new Set([...preferences.values()].map(p => p.priority));
  let priority = HIGHEST_RULE_PRIORITY;
  while (used.has(priority)) priority--;
  return priority;
}

function kernelRule(laptopIp: string, pref: Pick<Preference, 'station' | 'subnet' | 'priority'>): IpRuleOptions {
  return { from: laptopIp, to: pref.subnet, table: vlanMap[pref.station], priority: pref.priority };
}

/** Rule changes run one at a time: the UI, a drive session and the scanner's
 *  auto-connect can all pick the same laptop at once, and each step reads what
 *  the one before it left. */
let lastChange: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(change: () => Promise<T>): Promise<T> {
  const result = lastChange.then(change);
  lastChange = result.catch(() => undefined);
  return result;
}

async function dropPreference(laptopIp: string): Promise<void> {
  const old = preferences.get(laptopIp);
  if (!old) return;
  // The map entry goes last: it's how a rule that wouldn't go gets retried.
  await net().removeIpRule(kernelRule(laptopIp, old));
  preferences.delete(laptopIp);
}

export async function setRoutePreference(laptopIp: string, station: StationName, team: number): Promise<void> {
  // The rule matches the laptop's packets to an IPv4 robot subnet, so it
  // needs the laptop's IPv4 address. The kernel's answer for an IPv6 one is
  // "Invalid source address"; say what is actually wrong instead.
  if (isIPv6(laptopIp)) {
    throw new Error(
      `this device reached pFMS over IPv6 (${laptopIp}) and its IPv4 address isn't known yet — reload the page, or connect over IPv4`,
    );
  }
  const subnet = `${teamSubnet(team)}.0/24`;

  await oneAtATime(async () => {
    const old = preferences.get(laptopIp);
    if (old?.station === station && old.subnet === subnet) return;
    await dropPreference(laptopIp);
    const priority = freeRulePriority();
    await net().addIpRule(kernelRule(laptopIp, { station, subnet, priority }));
    preferences.set(laptopIp, { station, team, subnet, priority });
  });
}

export function clearRoutePreference(laptopIp: string): Promise<void> {
  return oneAtATime(() => dropPreference(laptopIp));
}

export function getPreference(laptopIp: string): StationName | null {
  return preferences.get(laptopIp)?.station ?? null;
}

/**
 * Called when station configuration changes. Clears preferences for any station
 * whose team has changed (including cleared), since the routing table entries
 * for those stations are being torn down.
 */
export function onConfigChange(getTeamForStation: (s: StationName) => number | null): Promise<void> {
  return oneAtATime(async () => {
    for (const [ip, pref] of [...preferences]) {
      if (getTeamForStation(pref.station) !== pref.team) await dropPreference(ip);
    }
  });
}

/**
 * Computes which teams are assigned to more than one station.
 * Returns a map of teamNumber → [station1, station2, ...].
 */
export function getConflictingTeams(
  getTeamForStation: (s: StationName) => number | null,
): Record<string, StationName[]> {
  const teamToStations = new Map<number, StationName[]>();
  for (const station of StationNameList) {
    const team = getTeamForStation(station);
    if (team === null) continue;
    const existing = teamToStations.get(team) ?? [];
    existing.push(station);
    teamToStations.set(team, existing);
  }

  const result: Record<string, StationName[]> = {};
  for (const [team, stations] of teamToStations) {
    if (stations.length >= 2) result[String(team)] = stations;
  }
  return result;
}

/** Remove all active ip rules (for graceful shutdown). */
export function cleanupAllPreferences(): Promise<void> {
  return oneAtATime(async () => {
    for (const ip of [...preferences.keys()]) await dropPreference(ip);
  });
}

/**
 * Makes the kernel's per-laptop `ip rule` entries and the in-memory preferences
 * agree, on startup, before anything can ask for a route. A rule is stale if
 * its station no longer has the team of the rule's subnet; pass `() => null`
 * after a full restart, when none of them should have survived.
 *
 * A laptop keeps one rule: the first live one in priority order, which is the
 * one its traffic follows now, so getPreference() places it where it really
 * goes even when both robots of a team are on the field. Every other rule for
 * it is a leftover: a duplicate, or a slot it has since left.
 */
export function syncPreferencesWithKernel(
  getTeamForStation: (s: StationName) => number | null,
): Promise<{ restored: number; removed: number }> {
  const stationOfTable = new Map(Object.entries(vlanMap).map(([s, table]) => [table, s as StationName]));

  return oneAtATime(async () => {
    const rules = await net().listIpRules();
    let restored = 0;
    let removed = 0;

    for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
      const { src, dst, priority } = rule;
      const station = stationOfTable.get(Number(rule.table));
      const match = dst?.match(/^10\.(\d+)\.(\d+)\.0\/24$/);
      const team = match ? Number(match[1]) * 100 + Number(match[2]) : 0;
      // Only what setRoutePreference writes. Not ours: the system rules, and
      // anything else someone has put on this host.
      if (!src || !isIPv4(src) || !dst || !station || !team || `${teamSubnet(team)}.0/24` !== dst) continue;

      if (getTeamForStation(station) === team && !preferences.has(src)) {
        preferences.set(src, { station, team, subnet: dst, priority });
        restored++;
        console.log(`Restored route preference: ${src} → ${station} (team ${team})`);
        continue;
      }

      try {
        await net().removeIpRule(kernelRule(src, { station, subnet: dst, priority }));
        removed++;
      } catch (err) {
        appWarn(`Could not remove stale ip rule ${priority} (${src} → ${dst}): ${(err as Error).message}`);
      }
    }

    if (removed > 0) appInfo(`Removed ${removed} stale per-laptop ip rule(s)`);
    return { restored, removed };
  });
}
