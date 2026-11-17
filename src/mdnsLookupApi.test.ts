import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMdnsLookupsRequest } from './mdnsLookupApi.js';
import type { MdnsLookupEvent } from './types.js';

function call(url: string, { method = 'GET', refuse = false } = {}) {
  const out = { status: 0, body: undefined as unknown, limit: 0 };
  const req = { url, method } as IncomingMessage;
  const res = {
    writeHead(status: number) {
      out.status = status;
    },
    end(body: string) {
      out.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  const log = {
    getRecent(limit: number): MdnsLookupEvent[] {
      out.limit = limit;
      return [];
    },
  };
  const access = {
    readRefusal: () => (refuse ? { status: 403, error: 'This only works from the field network' } : null),
  };
  const handled = handleMdnsLookupsRequest(req, res, log, access);
  return { handled, ...out };
}

describe('GET /api/mdns-lookups', () => {
  test('other paths are left alone', () => {
    expect(call('/api/mdns-lookupsx').handled).toBe(false);
  });

  test('on site: the newest lookups, 200 by default, at most 1000', () => {
    expect(call('/api/mdns-lookups')).toMatchObject({ handled: true, status: 200, body: { events: [] }, limit: 200 });
    expect(call('/api/mdns-lookups?limit=50').limit).toBe(50);
    expect(call('/api/mdns-lookups?limit=99999').limit).toBe(1000);
    expect(call('/api/mdns-lookups?limit=nope').limit).toBe(200);
  });

  test('off site without a credential: refused', () => {
    expect(call('/api/mdns-lookups', { refuse: true })).toMatchObject({ status: 403, limit: 0 });
  });

  test('only GET', () => {
    expect(call('/api/mdns-lookups', { method: 'POST' }).status).toBe(405);
  });
});
