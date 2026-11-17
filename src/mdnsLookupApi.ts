import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MdnsLookupLog } from './mdnsLookupLog.js';
import type { StaffHttpCheck } from './staffHttp.js';

/**
 * `GET /api/mdns-lookups?limit=200`: the newest lookups the mDNS reflector saw
 * and what became of each (src/mdnsLookupLog.ts), newest last. On site only,
 * like the rest of the Network page: it names laptops and robot devices.
 */
export function handleMdnsLookupsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  log: Pick<MdnsLookupLog, 'getRecent'>,
  access: Pick<StaffHttpCheck, 'readRefusal'>,
): boolean {
  const [path, query = ''] = (req.url ?? '').split('?');
  if (path !== '/api/mdns-lookups') return false;
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const refused = access.readRefusal(req);
  if (req.method !== 'GET') {
    reply(405, { error: 'Method not allowed' });
  } else if (refused) {
    reply(refused.status, { error: refused.error });
  } else {
    const asked = Number(new URLSearchParams(query).get('limit'));
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 1000) : 200;
    reply(200, { events: log.getRecent(limit) });
  }
  return true;
}
