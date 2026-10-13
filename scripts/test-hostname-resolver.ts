/**
 * Manual smoke test for HostnameResolver — resolves a few IPs from the local
 * network and prints what each strategy + the combined resolver returns.
 *
 *   bun scripts/test-hostname-resolver.ts <ip> [ip...]
 */
import { HostnameResolver } from '../src/hostnameResolver.js';

const ips = process.argv.slice(2);
if (ips.length === 0) {
  console.error('Usage: bun scripts/test-hostname-resolver.ts <ip> [ip...]');
  process.exit(1);
}

const resolver = new HostnameResolver(state => {
  console.log('broadcast:', JSON.stringify(state.hostnames));
});

for (const ip of ips) resolver.track(ip);

setTimeout(() => {
  console.log('final state:', JSON.stringify(resolver.getState().hostnames, null, 2));
  process.exit(0);
}, 4000);
