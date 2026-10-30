/**
 * Minimal fake backend for eyeballing the DS-client operator guard
 * (`bun scripts/fake-backend-ds-guard.ts [ds|hostname|clean]`).
 *
 * Serves /ws on :3000 (the vite dev proxy target) and feeds every client a
 * MatchEngine-built matchState plus a dsClientState. In `ds` mode (default)
 * the client is slot3's connected DS by address, so /match and /staff must show
 * the "This is a Driver Station" block; in `hostname` mode it only shares the
 * DS's name, so the block must offer "This isn't a Driver Station" and clear
 * when pressed; in `clean` mode the pages must render normally.
 */
import { WebSocketServer } from 'ws';
import { MatchEngine } from '../src/matchEngine.js';
import type { DsClientState, RoutePreferenceState } from '../src/types.js';

const mode = process.argv[2] === 'clean' || process.argv[2] === 'hostname' ? process.argv[2] : 'ds';
const DS_IP = '10.16.78.101';
const YOUR_IP = mode === 'ds' ? DS_IP : '10.255.0.99';
const verdict: DsClientState =
  mode === 'clean'
    ? { type: 'dsClientState', station: null }
    : { type: 'dsClientState', station: 'slot3', by: mode === 'ds' ? 'ip' : 'hostname' };

const engine = new MatchEngine(s => (s === 'slot3' ? 1678 : null));

const wss = new WebSocketServer({ port: 3000, path: '/ws' });
wss.on('connection', ws => {
  const state = {
    ...engine.getState(),
    connectedStations: { slot3: { ip: DS_IP, lastSeen: Date.now() } },
  };
  ws.send(JSON.stringify(state));
  ws.send(
    JSON.stringify({
      type: 'routePreferenceState',
      yourIp: YOUR_IP,
      preference: null,
      conflictingTeams: {},
    } satisfies RoutePreferenceState),
  );
  ws.send(JSON.stringify(verdict));
  console.log(`client connected — mode=${mode} yourIp=${YOUR_IP} dsIp=${DS_IP}`);
  // Log inbound messages — the staff page must NOT send staffHeartbeat while blocked
  ws.on('message', raw => {
    console.log(`recv: ${raw.toString()}`);
    if (mode === 'hostname' && raw.toString().includes('dsClientDismiss')) {
      ws.send(JSON.stringify({ type: 'dsClientState', station: null } satisfies DsClientState));
    }
  });
});
console.log(`fake backend on :3000 (mode=${mode})`);
