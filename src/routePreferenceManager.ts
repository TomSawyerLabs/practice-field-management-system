import { StationName, StationNameList } from './types.js';
import { networkBackend as net, vlanMap } from './networkManager.js';

type Preference = {
  station: StationName;
  team: number;
  subnet: string;
};

/** In-memory map of laptopIP → active routing preference */
const preferences = new Map<string, Preference>();

function teamSubnet(team: number): string {
  const high = Math.floor(team / 100);
  const low = team % 100;
  return `10.${high}.${low}.0/24`;
}

export async function setRoutePreference(laptopIp: string, station: StationName, team: number): Promise<void> {
  const subnet = teamSubnet(team);
  const old = preferences.get(laptopIp);

  // Clear map entry first so a partial failure doesn't leave stale data
  preferences.delete(laptopIp);
  if (old) {
    await net().removeIpRule({ from: laptopIp, to: old.subnet, table: vlanMap[old.station] });
  }

  await net().addIpRule({ from: laptopIp, to: subnet, table: vlanMap[station] });
  preferences.set(laptopIp, { station, team, subnet });
}

export async function clearRoutePreference(laptopIp: string): Promise<void> {
  const old = preferences.get(laptopIp);
  if (!old) return;
  await net().removeIpRule({ from: laptopIp, to: old.subnet, table: vlanMap[old.station] });
  preferences.delete(laptopIp);
}

export function getPreference(laptopIp: string): StationName | null {
  return preferences.get(laptopIp)?.station ?? null;
}

/**
 * Called when station configuration changes. Clears preferences for any station
 * whose team has changed (including cleared), since the routing table entries
 * for those stations are being torn down.
 */
export async function onConfigChange(getTeamForStation: (s: StationName) => number | null): Promise<void> {
  for (const [ip, pref] of [...preferences]) {
    const currentTeam = getTeamForStation(pref.station);
    if (currentTeam !== pref.team) {
      await clearRoutePreference(ip);
    }
  }
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
export async function cleanupAllPreferences(): Promise<void> {
  for (const ip of [...preferences.keys()]) {
    await clearRoutePreference(ip);
  }
}

/**
 * Reads existing `ip rule` entries from the kernel and restores the in-memory
 * preferences map. Call this on startup after a graceful restart so the server
 * stays in sync with rules that were left in place.
 *
 * Returns the number of preferences restored.
 */
export async function restorePreferencesFromKernel(): Promise<number> {
  const tableToStation = new Map<number, StationName>();
  for (const [station, tableId] of Object.entries(vlanMap) as [StationName, number][]) {
    tableToStation.set(tableId, station as StationName);
  }

  const rules = await net().listIpRules();
  let count = 0;

  for (const rule of rules) {
    // Skip system rules (src "all") and rules without a specific destination
    if (!rule.src || rule.src === 'all') continue;
    if (!rule.dst || rule.dst === 'all') continue;
    if (!rule.table) continue;

    const tableId = Number(rule.table);
    if (isNaN(tableId)) continue;

    const station = tableToStation.get(tableId);
    if (!station) continue; // Not one of our per-station tables

    // Parse team number from subnet 10.<high>.<low>.0/24
    const match = rule.dst.match(/^10\.(\d+)\.(\d+)\.0\/24$/);
    if (!match) continue;

    const team = Number(match[1]) * 100 + Number(match[2]);
    preferences.set(rule.src, { station, team, subnet: rule.dst });
    count++;
    console.log(`Restored route preference: ${rule.src} → ${station} (team ${team})`);
  }

  return count;
}
