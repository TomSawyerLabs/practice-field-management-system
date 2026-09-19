import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePublicMatchRequest } from './publicMatchApi.js';

const req = (url: string) => ({ url, method: 'GET', headers: {} }) as unknown as IncomingMessage;
const res = () => {
  const r = { statusCode: 0, writeHead: (code: number) => (r.statusCode = code), setHeader() {}, end() {} };
  return r as unknown as ServerResponse & { statusCode: number };
};
const none = {} as never;

describe('handlePublicMatchRequest', () => {
  test('leaves other /api/public/ routes to their own handlers (2026-09-19: it swallowed /api/public/practice)', () => {
    expect(handlePublicMatchRequest(req('/api/public/practice/abc'), res(), none, none)).toBe(false);
    expect(handlePublicMatchRequest(req('/api/public/other'), res(), none, none)).toBe(false);
  });
  test('still answers its own prefix, including malformed paths', () => {
    const r = res();
    expect(handlePublicMatchRequest(req('/api/public/match/'), r, none, none)).toBe(true);
    expect(r.statusCode).toBe(404);
  });
});
