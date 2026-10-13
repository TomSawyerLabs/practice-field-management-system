/**
 * Connect to a running pFMS backend and print the `hostnames` broadcasts —
 * quick post-deploy check that guest-host name resolution is working.
 *
 *   bun scripts/peek-hostnames.ts [ws://host:port/ws]
 */
import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://10.0.100.5:9005/ws';
const ws = new WebSocket(url);

ws.on('open', () => console.log(`connected to ${url}`));
ws.on('message', raw => {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg?.type === 'hostnames') {
      console.log('hostnames:', JSON.stringify(msg.hostnames, null, 2));
    }
  } catch {
    // history arrays etc. — ignore
  }
});
ws.on('error', err => {
  console.error('ws error:', err.message);
  process.exit(1);
});

setTimeout(() => process.exit(0), 20_000);
