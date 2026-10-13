import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dryRunAllowsRequest, installDryRunFetchGuard, skippedInDryRun, skippedInDryRunUnlessLocal } from './dryRun.js';

const realFetch = globalThis.fetch;
const savedDryRun = process.env.DRY_RUN;

/** Requests that reached "the network" — a spy standing in for fetch, so
 *  nothing here can leave the machine. */
let sent: string[];

beforeEach(() => {
  sent = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
    return new Response('{}');
  }, realFetch);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedDryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = savedDryRun;
});

describe('outside a dry run', () => {
  test('nothing is skipped', () => {
    delete process.env.DRY_RUN;
    expect(skippedInDryRun('configure the radio')).toBe(false);
    expect(skippedInDryRunUnlessLocal('http://10.0.100.2', 'configure the radio')).toBe(false);
  });
});

describe('in a dry run', () => {
  beforeEach(() => {
    process.env.DRY_RUN = '1';
  });

  test('writes are skipped', () => {
    expect(skippedInDryRun('configure the radio')).toBe(true);
  });

  test('a write to real hardware is skipped, one to a fake on this machine is not', () => {
    expect(skippedInDryRunUnlessLocal('http://10.0.100.2', 'configure the radio')).toBe(true);
    expect(skippedInDryRunUnlessLocal('http://127.0.0.1:43791', 'configure the radio')).toBe(false);
    expect(skippedInDryRunUnlessLocal('http://localhost:8080', 'configure the radio')).toBe(false);
  });

  test('reads go anywhere; writes only to this machine', () => {
    expect(dryRunAllowsRequest('http://10.0.100.2/status', 'GET')).toBe(true);
    expect(dryRunAllowsRequest('http://10.0.100.2/status', undefined)).toBe(true);
    expect(dryRunAllowsRequest('http://10.0.100.2/configuration', 'POST')).toBe(false);
    expect(dryRunAllowsRequest('http://10.59.40.1/configuration', 'post')).toBe(false);
    expect(dryRunAllowsRequest('https://hooks.slack.com/x', 'POST')).toBe(false);
    expect(dryRunAllowsRequest('http://127.0.0.1:3000/x', 'POST')).toBe(true);
    expect(dryRunAllowsRequest('http://[::1]:3000/x', 'DELETE')).toBe(true);
  });

  test('the fetch backstop refuses a write before it is sent', async () => {
    installDryRunFetchGuard();
    await expect(fetch('http://10.0.100.2/configuration', { method: 'POST', body: '{}' })).rejects.toThrow('dry run');
    await fetch('http://10.0.100.2/status');
    await fetch('http://127.0.0.1:9/configuration', { method: 'POST' });
    expect(sent).toEqual(['GET http://10.0.100.2/status', 'POST http://127.0.0.1:9/configuration']);
  });
});
