import { lookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * What a device on the field network actually gets when it opens the LAN URL.
 *
 * A reverse proxy in front of pFMS decides "internal or external" from the
 * client's address, and a device reaches that proxy on whichever address its
 * resolver handed it. So for every address the LAN name resolves to, fetch the
 * page the way a browser would and read which page came back.
 *
 * One address serving the public-only page means some devices on the field
 * network are shut out. That is exactly how pfms.tsl broke in August 2026: the
 * name gained an AAAA record, devices that prefer IPv6 connected from a global
 * address, and the proxy's private-range test sent them the public page.
 *
 * A refused connection is fine — browsers move on to the next address at once —
 * which is why this stays correct for a proxy that listens on IPv4 only.
 */

/** Which pFMS page a response is, read from its `<meta name="pfms-page">` tag. */
export type PageKind = 'internal' | 'public' | 'unknown';

const PAGE_META = /<meta\b[^>]*\bname=["']?pfms-page["']?[^>]*\bcontent=["']?([a-z]+)/i;

export function pageKind(html: string): PageKind {
  const kind = PAGE_META.exec(html)?.[1]?.toLowerCase();
  return kind === 'internal' || kind === 'public' ? kind : 'unknown';
}

export type ProbeOutcome = 'internal' | 'public' | 'unexpected' | 'refused' | 'timeout' | 'error';

export interface AddressProbe {
  family: 4 | 6;
  outcome: ProbeOutcome;
  /** HTTP status, when a response came back */
  status?: number;
  /** Error code, when the connection failed */
  error?: string;
}

export interface LanAccessResult {
  url: string;
  ok: boolean;
  /** One line a human can act on */
  summary: string;
  probes: AddressProbe[];
}

export interface SiteHealth {
  ok: boolean;
  /** Absent when LAN_URL isn't set — the check then only proves the backend is up. */
  lan?: LanAccessResult;
  checkedAt: string;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SiteHealthOptions {
  /** How long a result is reused. The endpoint is public, so a hit must not always mean fresh probes. */
  cacheMs?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to the system resolver, which is what the field's devices use too. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
}

const MAX_BODY = 256 * 1024;

const DESCRIBE: Record<ProbeOutcome, string> = {
  internal: 'serves the internal UI',
  public: 'serves the public-only page',
  unexpected: 'serves something that is not a pFMS page',
  refused: 'refuses connections (browsers fall back)',
  timeout: 'times out',
  error: 'fails to connect',
};

function probeAddress(url: URL, address: string, family: 4 | 6, timeoutMs: number): Promise<AddressProbe> {
  return new Promise(resolve => {
    let settled = false;
    const done = (probe: AddressProbe) => {
      if (settled) return;
      settled = true;
      resolve(probe);
    };
    const secure = url.protocol === 'https:';
    const req: ClientRequest = (secure ? httpsRequest : httpRequest)(
      {
        host: address,
        family,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, Accept: 'text/html', 'User-Agent': 'pfms-site-health' },
        ...(secure ? { servername: url.hostname } : {}),
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= MAX_BODY) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => {
          const kind = pageKind(Buffer.concat(chunks).toString('utf8'));
          const status = res.statusCode ?? 0;
          if (kind === 'public') done({ family, outcome: 'public', status });
          else if (kind === 'internal' && status >= 200 && status < 300) done({ family, outcome: 'internal', status });
          else done({ family, outcome: 'unexpected', status });
        });
        res.on('error', (err: NodeJS.ErrnoException) =>
          done({ family, outcome: 'error', error: err.code ?? err.message }),
        );
      },
    );
    req.on('timeout', () => {
      done({ family, outcome: 'timeout' });
      req.destroy();
    });
    req.on('error', (err: NodeJS.ErrnoException) =>
      done({ family, outcome: err.code === 'ECONNREFUSED' ? 'refused' : 'error', error: err.code ?? err.message }),
    );
    req.end();
  });
}

/**
 * Healthy means at least one address serves the internal UI and none serves
 * anything else. Refusals and timeouts are reported but tolerated while
 * another address works, since browsers fall back past them.
 */
export function assessLanAccess(url: string, probes: AddressProbe[]): LanAccessResult {
  const shutOut = probes.some(p => p.outcome === 'public' || p.outcome === 'unexpected');
  const reachable = probes.some(p => p.outcome === 'internal');
  const summary =
    probes.length === 0
      ? 'resolves to no addresses'
      : probes
          .map(p => `IPv${p.family} ${DESCRIBE[p.outcome]}${p.outcome === 'unexpected' ? ` (HTTP ${p.status})` : ''}`)
          .join('; ');
  return { url, ok: reachable && !shutOut, summary, probes };
}

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

export class SiteHealthChecker {
  private readonly url?: URL;
  private readonly configError?: string;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  private cached?: { at: number; result: SiteHealth };
  private inFlight?: Promise<SiteHealth>;
  private lastOk?: boolean;

  constructor(
    private readonly lanUrl: string | undefined,
    options: SiteHealthOptions = {},
  ) {
    if (lanUrl) {
      try {
        this.url = new URL(lanUrl);
      } catch {
        this.configError = `LAN_URL is not a valid URL: ${lanUrl}`;
      }
    }
    this.cacheMs = options.cacheMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.resolve = options.resolve ?? systemResolve;
  }

  check(): Promise<SiteHealth> {
    if (this.cached && Date.now() - this.cached.at < this.cacheMs) return Promise.resolve(this.cached.result);
    if (!this.inFlight) {
      this.inFlight = this.run()
        .then(result => {
          this.cached = { at: Date.now(), result };
          if (result.lan && result.ok !== this.lastOk) {
            const log = result.ok ? console.log : console.warn;
            log(
              `Site health: LAN access ${result.ok ? 'OK' : 'FAILING'} for ${result.lan.url} — ${result.lan.summary}`,
            );
          }
          this.lastOk = result.ok;
          return result;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    return this.inFlight;
  }

  private async run(): Promise<SiteHealth> {
    const checkedAt = new Date().toISOString();
    if (this.configError) {
      return {
        ok: false,
        lan: { url: this.lanUrl ?? '', ok: false, summary: this.configError, probes: [] },
        checkedAt,
      };
    }
    const url = this.url;
    if (!url) return { ok: true, checkedAt };

    // URL keeps the brackets on an IPv6 literal; the resolver wants them off.
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: ResolvedAddress[];
    try {
      addresses = await this.resolve(hostname);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      return {
        ok: false,
        lan: { url: url.href, ok: false, summary: `can't resolve ${hostname} (${code})`, probes: [] },
        checkedAt,
      };
    }

    const unique = [...new Map(addresses.map(a => [a.address, a])).values()];
    const probes = await Promise.all(
      unique.map(a => probeAddress(url, a.address, a.family === 6 ? 6 : 4, this.timeoutMs)),
    );
    const lan = assessLanAccess(url.href, probes);
    return { ok: lan.ok, lan, checkedAt };
  }
}
