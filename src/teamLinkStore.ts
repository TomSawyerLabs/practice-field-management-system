/**
 * Stand-in team numbers: a team's extra robot running as 99xx (5940's spare
 * as 9940), linked to the real team for one practice day.
 *
 * Teams do this because other software can't tell two identical
 * `10.TE.AM.x` subnets apart. pFMS could, but the robot is set up as 9940,
 * so on the network it stays 9940: its own SSID, subnet, station and routes.
 * The link only decides where the day's records are filed: 9940's practice
 * runs, and the matches it played, show up on 5940's practice day.
 *
 * Records keep the robot's own number. The link is applied when reading, so
 * it covers the whole day whenever it is made, and undoing it puts
 * everything back.
 *
 * The real team's saved robot Wi-Fi passphrase guards a link: with one saved,
 * linking needs it, or a stand-in robot already set up with it (which is
 * also how a link is made automatically). See plans/stand-in-team-links.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { practiceDayOf } from './practiceStore.js';
import { isLinkableTeam, isStandInTeam, type TeamLink, type TeamLinkVia, type TeamLinksState } from './types.js';
import { teamOfSsid } from './utils.js';

const DEFAULT_FILE = 'team-links.json';
/** Links are small, but there is one per robot per day: keep about a season. */
const MAX_LINKS = 2000;

export class TeamLinkStore {
  private links: TeamLink[] = [];
  private listeners: ((state: TeamLinksState) => void)[] = [];
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(opts: { filePath?: string; now?: () => number } = {}) {
    this.filePath = opts.filePath ?? process.env.TEAM_LINKS_FILE ?? DEFAULT_FILE;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  today(): string {
    return practiceDayOf(this.now());
  }

  /** The day's entry for a stand-in robot, tombstone included. */
  entryFor(robotTeam: number, day = this.today()): TeamLink | undefined {
    return this.links.find(l => l.robotTeam === robotTeam && l.day === day);
  }

  /** The team a robot's records are filed under on a day: its link, or itself. */
  teamFor(robotTeam: number, day = this.today()): number {
    if (!isStandInTeam(robotTeam)) return robotTeam;
    return this.entryFor(robotTeam, day)?.team ?? robotTeam;
  }

  /** Stand-in robots linked to a team on a day. */
  standInsFor(team: number, day = this.today()): number[] {
    return this.links
      .filter(l => l.day === day && l.team === team)
      .map(l => l.robotTeam)
      .sort((a, b) => a - b);
  }

  /** Every number whose records a team's day holds: its own and its stand-ins'. */
  teamsFiledUnder(team: number, day = this.today()): number[] {
    return [team, ...this.standInsFor(team, day)];
  }

  link(robotTeam: number, team: number, via: TeamLinkVia): TeamLink {
    if (!isStandInTeam(robotTeam)) throw new Error(`${robotTeam} is not a 99xx team number`);
    if (!isLinkableTeam(team)) throw new Error(`${team} can't be linked to`);
    return this.put({ robotTeam, team, day: this.today(), at: this.now(), via });
  }

  /** Keep a stand-in apart again today, and stop auto-link redoing it. */
  unlink(robotTeam: number): void {
    const entry = this.entryFor(robotTeam);
    if (!entry || entry.team === null) return;
    this.put({ robotTeam, team: null, day: entry.day, at: this.now(), via: 'unlinked' });
  }

  getState(): TeamLinksState {
    const day = this.today();
    return {
      type: 'teamLinksState',
      day,
      links: this.links.filter((l): l is TeamLink & { team: number } => l.day === day && l.team !== null),
    };
  }

  addListener(fn: (state: TeamLinksState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private put(entry: TeamLink): TeamLink {
    this.links = this.links.filter(l => !(l.robotTeam === entry.robotTeam && l.day === entry.day));
    this.links.push(entry);
    if (this.links.length > MAX_LINKS) this.links = this.links.slice(-MAX_LINKS);
    this.persist();
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('Error in TeamLinkStore listener:', err);
      }
    }
    return entry;
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { links?: unknown };
      const links = Array.isArray(parsed.links) ? parsed.links : [];
      this.links = links.filter(
        (l): l is TeamLink =>
          !!l &&
          typeof l === 'object' &&
          isStandInTeam((l as TeamLink).robotTeam) &&
          ((l as TeamLink).team === null || isLinkableTeam((l as TeamLink).team)) &&
          typeof (l as TeamLink).day === 'string',
      );
      console.log(`Loaded ${this.links.length} team link(s) from ${this.filePath}`);
    } catch (err) {
      console.warn(`Failed to load team links from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify({ version: 1, links: this.links }, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save team links to ${this.filePath}:`, (err as Error).message);
    }
  }
}

/** A saved robot: its SSID and Wi-Fi passphrase. */
export type SavedKey = { ssid: string; wpaKey: string };

/**
 * May a stand-in be linked to `team`?
 *
 * - `open`: the team has no saved passphrase, so there is nothing to check.
 * - `passphrase`: the one given is one of the team's saved robots'.
 * - `auto`: the stand-in robot is already saved with one of them.
 * - `staff`: field staff asked; they don't need it.
 * - otherwise refused: `passphraseRequired` (none given) or `wrongPassphrase`.
 */
export function linkAuthorization(opts: {
  teamKeys: readonly string[];
  robotKeys: readonly string[];
  passphrase?: string;
  staff?: boolean;
}): { ok: true; via: TeamLinkVia } | { ok: false; error: 'passphraseRequired' | 'wrongPassphrase' } {
  if (opts.teamKeys.length === 0) return { ok: true, via: 'open' };
  if (opts.passphrase && opts.teamKeys.includes(opts.passphrase)) return { ok: true, via: 'passphrase' };
  if (opts.robotKeys.some(k => opts.teamKeys.includes(k))) return { ok: true, via: 'auto' };
  if (opts.staff) return { ok: true, via: 'staff' };
  return { ok: false, error: opts.passphrase ? 'wrongPassphrase' : 'passphraseRequired' };
}

/**
 * The real team a stand-in robot belongs to, judged by its passphrase: the
 * one team whose saved robots use a passphrase the stand-in is saved with.
 * None, or more than one (a shared default passphrase), is no answer.
 */
export function autoLinkTarget(robotTeam: number, saved: readonly SavedKey[]): number | undefined {
  const robotKeys = new Set(saved.filter(s => teamOfSsid(s.ssid) === robotTeam).map(s => s.wpaKey));
  if (robotKeys.size === 0) return undefined;
  const teams = new Set<number>();
  for (const s of saved) {
    const team = teamOfSsid(s.ssid);
    if (team !== null && isLinkableTeam(team) && robotKeys.has(s.wpaKey)) teams.add(team);
  }
  return teams.size === 1 ? [...teams][0] : undefined;
}
