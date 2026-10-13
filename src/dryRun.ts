/**
 * DRY_RUN: run pFMS without changing anything outside this machine.
 *
 * Reads stay live — the radio's status, team checks, subnet scans — so the
 * UI shows real data. Every write to something real is logged as
 * "[dry-run] Would …" and skipped: the field radio and robot radios, Driver
 * Stations, the host's network and Wi-Fi cards, lights, Slack, push. A dev
 * machine on the field network can reach all of those (2026-10-12: local
 * dry runs wiped the field radio twice, because DRY_RUN only covered the
 * host's own network commands).
 *
 * Each write site checks `skippedInDryRun()`. As a backstop for any it
 * misses, `installDryRunFetchGuard()` makes every non-GET HTTP request to a
 * non-loopback host fail. Fakes on this machine (a stand-in radio on
 * 127.0.0.1 in scripts/test-radio-reconcile.ts) still get their writes —
 * see `skippedInDryRunUnlessLocal()`.
 */

export function isDryRun(): boolean {
  return !!process.env.DRY_RUN;
}

/** In a dry run, log what would have happened and return true — the caller
 *  skips it. Outside a dry run, false. */
export function skippedInDryRun(what: string): boolean {
  if (!isDryRun()) return false;
  console.log(`[dry-run] Would ${what} — skipped`);
  return true;
}

const reported = new Set<string>();

/** skippedInDryRun for paths that run constantly (control packets at
 *  50 Hz): logs the first time per `key`, skips every time. */
export function skippedInDryRunOnce(key: string, what: string): boolean {
  if (!isDryRun()) return false;
  if (!reported.has(key)) {
    reported.add(key);
    console.log(`[dry-run] Would ${what} — skipped (logged once)`);
  }
  return true;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

/** skippedInDryRun for a write to `url`, letting it through when `url` is
 *  on this machine (a local fake, not real hardware). */
export function skippedInDryRunUnlessLocal(url: string, what: string): boolean {
  if (!isDryRun() || isLoopbackUrl(url)) return false;
  return skippedInDryRun(what);
}

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Whether a dry run lets this request through: reads anywhere, anything
 *  to this machine (local test fakes). */
export function dryRunAllowsRequest(url: string, method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  return isLoopbackUrl(url);
}

/** In a dry run, refuse every write over HTTP to another machine. */
export function installDryRunFetchGuard(): void {
  if (!isDryRun()) return;
  const realFetch = globalThis.fetch;
  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (!dryRunAllowsRequest(url, method)) {
      console.log(`[dry-run] Blocked ${method.toUpperCase()} ${url}`);
      return Promise.reject(new Error(`dry run: ${method.toUpperCase()} ${url} not sent`));
    }
    return realFetch(input, init);
  };
  globalThis.fetch = Object.assign(guarded, realFetch);
}
