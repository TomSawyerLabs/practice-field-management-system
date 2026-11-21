import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStaticHandler } from './staticServer';

describe('static pages', () => {
  const root = mkdtempSync(join(tmpdir(), 'pfms-static-'));
  for (const page of ['index', 'scores', 'control', 'admin', '404']) {
    writeFileSync(join(root, `${page}.html`), page);
  }
  const handler = createStaticHandler({ webRoot: root })!;
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(599);
      res.end();
    }
  }).listen(0);
  const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = async (path: string) => {
    const res = await fetch(base() + path);
    return { status: res.status, body: await res.text() };
  };
  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ['/', 'index'],
    ['/scores', 'scores'],
    ['/matches/abc', 'scores'],
    ['/practice/abc', 'scores'],
    ['/camera-feed', 'scores'],
    ['/camera-feed?label=0', 'scores'],
    ['/1234', 'control'],
    ['/admin', 'admin'],
  ])('%s is the %s page', async (path, expected) => {
    expect(await page(path)).toEqual({ status: 200, body: expected });
  });

  test('an unknown page is the 404 page', async () => {
    expect(await page('/nope')).toEqual({ status: 404, body: '404' });
  });
});
