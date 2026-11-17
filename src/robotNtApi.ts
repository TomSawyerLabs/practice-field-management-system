import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RobotNtReader } from './robotNt.js';
import type { StaffHttpCheck } from './staffHttp.js';
import { StationNameList, type StationName } from './types.js';

/** Which robot to read for a station, or why none. */
export type RobotNtTarget =
  | { ok: true; team: number; ifname: string; ip: string }
  | { ok: false; status: number; error: string };

/**
 * `GET /api/robot-nt?station=slot1`: what the station's robot's NetworkTables
 * server says (src/robotNt.ts), read now or a few seconds ago. On site only,
 * like the rest of the Network page.
 */
export function handleRobotNtRequest(
  req: IncomingMessage,
  res: ServerResponse,
  reader: Pick<RobotNtReader, 'read'>,
  access: Pick<StaffHttpCheck, 'readRefusal'>,
  target: (station: StationName) => RobotNtTarget,
): boolean {
  const [path, query = ''] = (req.url ?? '').split('?');
  if (path !== '/api/robot-nt') return false;
  const reply = (status: number, body: unknown): true => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  };
  if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });
  const refused = access.readRefusal(req);
  if (refused) return reply(refused.status, { error: refused.error });
  const station = new URLSearchParams(query).get('station') as StationName | null;
  if (!station || !StationNameList.includes(station)) return reply(400, { error: 'Needs station' });
  const t = target(station);
  if (!t.ok) return reply(t.status, { error: t.error });
  void reader.read(station, t.team, t.ifname, t.ip).then(reading => reply(200, reading));
  return true;
}
