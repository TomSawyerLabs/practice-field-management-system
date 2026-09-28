import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagReportHandler, DIAG_SCRIPT_NAME } from './diagReportApi.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A pFMS stand-in serving only the diagnostics routes, on a random port. */
async function serve(opts: { teamForIp?: (ip: string) => number | undefined; clock?: { t: number } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pfms-diag-'));
  const scriptDir = join(root, 'diag');
  const reportsDir = join(root, 'reports');
  mkdirSync(scriptDir);
  writeFileSync(join(scriptDir, DIAG_SCRIPT_NAME), "param([string]$Server = '__PFMS_SERVER__')\nWrite-Host $Server\n");
  const handler = createDiagReportHandler({
    scriptDir,
    reportsDir,
    clientIp: req => req.socket.remoteAddress ?? 'unknown',
    teamForIp: opts.teamForIp,
    now: opts.clock ? () => new Date(opts.clock!.t) : undefined,
  });
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { base, reportsDir };
}

const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 'pfms-ds-wifi-report/1',
    hours: 24,
    computer: { name: 'DESKTOP-4NJD6CG' },
    driverStation: { teamNumber: 6238 },
    events: { wlanAutoConfig: [{ id: 8001 }, { id: 8003 }, { id: 8003 }] },
    ...over,
  });

describe('the Wi-Fi check script', () => {
  test('calls back to the address the laptop used to fetch it', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/api/diag/wifi.ps1`, { headers: { host: 'pfms.tsl' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain("$Server = 'http://pfms.tsl'");
  });

  test('honours the proxy scheme, and refuses a host it could not safely quote', async () => {
    const { base } = await serve();
    const viaProxy = await fetch(`${base}/api/diag/wifi.ps1`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pfms.example.org' },
    });
    expect(await viaProxy.text()).toContain("'https://pfms.example.org'");
    const hostile = await fetch(`${base}/api/diag/wifi.ps1`, { headers: { 'x-forwarded-host': "evil';calc;'" } });
    expect(await hostile.text()).toContain("'__PFMS_SERVER__'");
  });

  test('downloads as a Windows file named for "Run with PowerShell"', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/api/diag/wifi.ps1?download`, { headers: { host: 'pfms.tsl' } });
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pfms-wifi-check.ps1"');
    const text = await res.text();
    expect(text).toContain("'http://pfms.tsl')\r\n");
    expect(text).not.toMatch(/[^\r]\n/);
  });

  test('there is no .cmd wrapper to trip Defender', async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/diag/wifi-check.cmd`)).status).toBe(404);
  });
});

describe('uploading a report', () => {
  test('stores it under the day, tagged with the team pFMS knows for that address', async () => {
    const { base, reportsDir } = await serve({ teamForIp: ip => (ip === '127.0.0.1' ? 840 : undefined) });
    const res = await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: report() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; wlanDisconnects: number };
    expect(body.wlanDisconnects).toBe(2);
    expect(body.id).toContain('_team840_127.0.0.1');

    const [day] = readdirSync(join(reportsDir, 'wifi'));
    const stored = JSON.parse(readFileSync(join(reportsDir, 'wifi', day, `${body.id}.json`), 'utf-8'));
    expect(stored.teamFromIp).toBe(840);
    expect(stored.teamFromDriverStation).toBe(6238);
    expect(stored.computerName).toBe('DESKTOP-4NJD6CG');
    expect(stored.report.schema).toBe('pfms-ds-wifi-report/1');
  });

  test('falls back to the team the Driver Station is set to', async () => {
    const { base } = await serve();
    const body = (await (await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: report() })).json()) as {
      id: string;
    };
    expect(body.id).toContain('_team6238_');
  });

  test('refuses what is not a report, and a second upload within 10 s', async () => {
    const clock = { t: Date.parse('2026-09-28T12:00:00') };
    const { base } = await serve({ clock });
    expect((await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: 'nope' })).status).toBe(400);
    expect(
      (await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: JSON.stringify({ schema: 'other' }) }))
        .status,
    ).toBe(400);
    expect((await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: report() })).status).toBe(200);
    expect((await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: report() })).status).toBe(429);
    clock.t += 11_000;
    expect((await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: report() })).status).toBe(200);
  });

  test('refuses a report over the size cap', async () => {
    const { base } = await serve();
    const huge = report({ padding: 'x'.repeat(17 * 1024 * 1024) });
    expect((await fetch(`${base}/api/diag/wifi-report`, { method: 'POST', body: huge })).status).toBe(413);
  });
});
