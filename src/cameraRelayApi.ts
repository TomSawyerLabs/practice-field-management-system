import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CameraKey, CameraRelay } from './cameraRelay.js';
import type { StaffHttpCheck } from './staffHttp.js';
import { StationNameList, type StationName } from './types.js';

/** Why a camera can't be relayed, or where to fetch it from. */
export type CameraVerdict = { ok: true; key: CameraKey } | { ok: false; status: number; error: string };

/**
 * `GET /api/camera?station=slot1&ip=10.28.54.2&port=1181`: a robot's camera
 * stream, relayed (src/cameraRelay.ts). On site only. `allow` decides whether
 * this camera may be relayed: it must be one the device scan found, on a
 * robot whose radio isn't limiting its bandwidth.
 */
export function handleCameraRequest(
  req: IncomingMessage,
  res: ServerResponse,
  relay: Pick<CameraRelay, 'watch'>,
  access: Pick<StaffHttpCheck, 'readRefusal'>,
  allow: (station: StationName, ip: string, port: number) => CameraVerdict,
): boolean {
  const [path, query = ''] = (req.url ?? '').split('?');
  if (path !== '/api/camera') return false;
  const fail = (status: number, error: string): true => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error }));
    return true;
  };
  if (req.method !== 'GET') return fail(405, 'Method not allowed');
  const refused = access.readRefusal(req);
  if (refused) return fail(refused.status, refused.error);

  const params = new URLSearchParams(query);
  const station = params.get('station') as StationName | null;
  const ip = params.get('ip') ?? '';
  const port = Number(params.get('port'));
  if (!station || !StationNameList.includes(station) || !/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !Number.isInteger(port)) {
    return fail(400, 'Needs station, ip and port');
  }
  const verdict = allow(station, ip, port);
  if (!verdict.ok) return fail(verdict.status, verdict.error);
  relay.watch(verdict.key, res);
  return true;
}
