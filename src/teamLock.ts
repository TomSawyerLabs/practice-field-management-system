import type { NetworkBackend } from './node-ip/index.js';
import type { TeamAuth } from './teamAuth.js';
import { StationNameList, type StationName } from './types.js';
import { appInfo, appWarn } from './appLogger.js';

const prefix = process.env.IPTABLES_COMMENT_PREFIX || 'pfms-';

/** Chains and comments. Every name starts with the comment prefix, so the
 *  startup flush and `clear all` take the jumps with everything else. */
export const lockChain = (team: number) => `${prefix}lock-${team}`;
export const lockWebChain = (team: number) => `${prefix}lockweb-${team}`;
const forwardJumpComment = (station: StationName) => `${prefix}lock-${station}`;
const portalComment = `${prefix}lockportal`;

/** A team's subnet, `10.TE.AM.0/24`. */
export function teamSubnet(team: number): string {
  return `10.${Math.floor(team / 100)}.${team % 100}.0/24`;
}

/**
 * The rules of a locked team's filter chain. Every packet from a laptop to the
 * team's robots passes through it (not only new connections: a Driver
 * Station's UDP stream never looks new to conntrack, and unbinding an address
 * has to cut its open flows too).
 *
 * - Packets answering something a robot started go through.
 * - The team's own subnet goes through: one team with robots on two stations.
 * - Each bound address goes through. Its rule's counter is the traffic clock
 *   that keeps the binding alive.
 * - Everything else is refused at once, so tools fail fast instead of hanging.
 */
export function lockRules(team: number, allowed: string[]): string[][] {
  return [
    ['-m', 'conntrack', '--ctdir', 'REPLY', '-j', 'RETURN'],
    ['-s', teamSubnet(team), '-j', 'RETURN'],
    ...allowed.map(address => ['-s', `${address}/32`, '-j', 'RETURN']),
    ['-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset'],
    ['-j', 'REJECT', '--reject-with', 'icmp-admin-prohibited'],
  ];
}

/** The rules of a locked team's nat chain: plain HTTP to its robots from
 *  anyone not let through goes to the login portal instead. */
export function lockWebRules(team: number, allowed: string[], portalPort: number): string[][] {
  return [
    ['-s', teamSubnet(team), '-j', 'RETURN'],
    ...allowed.map(address => ['-s', `${address}/32`, '-j', 'RETURN']),
    ['-p', 'tcp', '-j', 'REDIRECT', '--to-ports', String(portalPort)],
  ];
}

export interface TeamLockOptions {
  auth: TeamAuth;
  net: () => NetworkBackend;
  /** The team on each station's bridge right now. */
  teamsOnBridges: () => Partial<Record<StationName, number>>;
  bridgeName: (station: StationName) => string;
  portalPort: number;
  /** How long a binding lasts with no traffic: the guest DHCP lease. */
  idleMs: () => number;
}

/**
 * Puts each locked team's firewall in place and keeps it matching TeamAuth:
 * which teams are locked, which stations they're on, and which addresses
 * their logged-in devices are at. Nothing here decides who may log in.
 *
 * Every change goes through reconcile(), one at a time, and builds the whole
 * picture from scratch, so a missed event can only delay a fix, never leave a
 * wrong rule behind for good.
 */
export class TeamLock {
  /** What each chain was last written as, to skip identical rewrites. */
  private written = new Map<string, string>();
  /** Packets each bound address had passed at the last poll, per team. */
  private lastCounts = new Map<number, Map<string, number>>();
  private running: Promise<void> = Promise.resolve();
  private queued = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;

  constructor(private readonly opts: TeamLockOptions) {}

  /**
   * Start acting on the firewall. Until then reconcile() does nothing: at
   * startup the bridges aren't known yet, and reading them as empty would
   * tear down the locks a graceful reload kept. Call once the bridges are
   * known (a commit finished, or a reload's recovery did).
   */
  activate(): Promise<void> {
    this.active = true;
    return this.reconcile();
  }

  /** Bring the firewall in line. Calls made while one runs fold into one more. */
  reconcile(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.queued) return this.running;
    this.queued = true;
    this.running = this.running.then(async () => {
      this.queued = false;
      try {
        await this.apply();
      } catch (err) {
        appWarn(`Team network lock: could not update the firewall: ${(err as Error).message}`);
      }
    });
    return this.running;
  }

  /** Read the traffic counters, keep bindings with traffic alive, and end
   *  the rest once idle. Every minute while running. */
  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    const { auth, net } = this.opts;
    try {
      for (const team of auth.lockedTeams()) {
        const rows = await net().chainCounters('filter', lockChain(team));
        const before = this.lastCounts.get(team) ?? new Map<string, number>();
        const now = new Map<string, number>();
        const seen: string[] = [];
        for (const row of rows) {
          if (row.target !== 'RETURN') continue;
          const address = row.source.replace(/\/32$/, '');
          if (address.includes('/')) continue; // the team's subnet
          now.set(address, row.packets);
          if (row.packets > (before.get(address) ?? 0)) seen.push(address);
        }
        this.lastCounts.set(team, now);
        if (seen.length) auth.sawTraffic(team, seen);
      }
    } catch (err) {
      appWarn(`Team network lock: could not read traffic counters: ${(err as Error).message}`);
    }
    // Ending a binding is a change, which reconciles.
    auth.expireBindings(this.opts.idleMs());
  }

  /** Remove every lock rule and chain: a full shutdown. */
  async removeAll(): Promise<void> {
    const net = this.opts.net();
    await net.flushRulesByComment(`${prefix}lock`);
    for (const table of ['filter', 'nat']) {
      for (const chain of await net.listChains(table, `${prefix}lock`)) await net.deleteChain(table, chain);
    }
    this.written.clear();
  }

  private async apply(): Promise<void> {
    const { auth, teamsOnBridges, bridgeName, portalPort } = this.opts;
    const net = this.opts.net();

    const stationsOf = new Map<number, StationName[]>();
    const onBridges = teamsOnBridges();
    for (const station of StationNameList) {
      const team = onBridges[station];
      if (team && auth.isLocked(team)) stationsOf.set(team, [...(stationsOf.get(team) ?? []), station]);
    }

    // 1. Chains first, so no jump ever points at one that is missing or stale.
    for (const [team] of stationsOf) {
      const allowed = auth.allowedAddresses(team).sort();
      await this.write('filter', lockChain(team), lockRules(team, allowed), team);
      await this.write('nat', lockWebChain(team), lockWebRules(team, allowed, portalPort));
    }

    // 2. Jumps. Inserted at the top, ahead of the station's own ACCEPT.
    const wantForward = new Map<string, { station: StationName; team: number }>();
    for (const [team, stations] of stationsOf) {
      for (const station of stations) wantForward.set(forwardJumpComment(station), { station, team });
    }
    const existing = await net.listRulesByComment(`${prefix}lock`);
    for (const rule of existing) {
      const jump = rule.spec[rule.spec.indexOf('-j') + 1];
      const keep =
        rule.comment === portalComment
          ? stationsOf.size > 0
          : rule.table === 'filter'
            ? wantForward.get(rule.comment) && jump === lockChain(wantForward.get(rule.comment)!.team)
            : stationsOf.has(Number(rule.comment.slice(`${prefix}lockweb-`.length))) &&
              jump === lockWebChain(Number(rule.comment.slice(`${prefix}lockweb-`.length)));
      if (!keep) await net.deleteRule(rule);
    }
    for (const [comment, { station, team }] of wantForward) {
      await net.iptables({
        action: '-I',
        chain: 'FORWARD',
        outInterface: bridgeName(station),
        jump: lockChain(team),
        comment,
      });
    }
    for (const team of stationsOf.keys()) {
      await net.iptables({
        action: '-I',
        table: 'nat',
        chain: 'PREROUTING',
        destination: teamSubnet(team),
        protocol: 'tcp',
        destinationPort: 80,
        jump: lockWebChain(team),
        comment: lockWebChain(team),
      });
    }
    // The portal answers on the host itself; let what the REDIRECT sent
    // there in, whatever the host's own INPUT policy is.
    if (stationsOf.size > 0) {
      await net.iptables({
        action: '-I',
        chain: 'INPUT',
        protocol: 'tcp',
        destinationPort: portalPort,
        ctState: 'DNAT',
        jump: 'ACCEPT',
        comment: portalComment,
      });
    }

    // 3. Chains nothing jumps to any more.
    for (const [table, chainOf] of [
      ['filter', lockChain],
      ['nat', lockWebChain],
    ] as const) {
      const want = new Set([...stationsOf.keys()].map(chainOf));
      for (const chain of await net.listChains(table, chainOf(0).slice(0, -1))) {
        if (want.has(chain)) continue;
        await net.deleteChain(table, chain);
        this.written.delete(`${table}/${chain}`);
        appInfo(`Team network lock: removed ${chain}`);
      }
    }
  }

  private async write(table: string, chain: string, rules: string[][], countsFor?: number): Promise<void> {
    const key = `${table}/${chain}`;
    const text = JSON.stringify(rules);
    if (this.written.get(key) === text) return;
    await this.opts.net().replaceChain(table, chain, rules);
    this.written.set(key, text);
    // A rewrite starts the counters again.
    if (countsFor !== undefined) this.lastCounts.delete(countsFor);
    appInfo(`Team network lock: ${chain} lets through ${rules.length - (table === 'filter' ? 4 : 2)} laptop(s)`);
  }
}
