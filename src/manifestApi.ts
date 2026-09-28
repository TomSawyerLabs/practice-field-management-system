import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A web app manifest per team, so a team page installs as "Team 1234" and
 * opens on that page. `/api/manifest?team=1234`; without a team it is the
 * field's generic manifest.
 */
export function handleManifestRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const [path, query = ''] = (req.url ?? '').split('?');
  if (path !== '/api/manifest') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return true;
  }
  const team = Number(new URLSearchParams(query).get('team'));
  const valid = Number.isInteger(team) && team > 0;
  const manifest = {
    name: valid ? `pFMS · Team ${team}` : 'pFMS',
    short_name: valid ? `Team ${team}` : 'pFMS',
    description: 'Practice field: your robot, the match, and the queue.',
    start_url: valid ? `/${team}` : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#121212',
    theme_color: '#121212',
    icons: [{ src: '/tomsawyerlabs.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
  res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(manifest));
  return true;
}
