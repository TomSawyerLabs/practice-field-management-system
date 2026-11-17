import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CameraKey, CameraRelay } from './cameraRelay.js';
import type { StaffHttpCheck } from './staffHttp.js';
import { StationNameList, type StationName } from './types.js';

/**
 * Why a camera can't be relayed, or where to fetch it from. `stillsOnly` says
 * why the live stream isn't offered (the robot's bandwidth limit): stills are.
 */
export type CameraVerdict =
  | { ok: true; key: CameraKey; stillsOnly?: string }
  | { ok: false; status: number; error: string };

/**
 * `GET /api/camera?station=slot1&ip=10.28.54.2&port=1181`: a robot's camera
 * stream, relayed (src/cameraRelay.ts). Add `&still=1` for one JPEG instead,
 * fetched from the camera at most every few seconds. On site only. `allow`
 * decides whether this camera may be relayed: it must be one the device scan
 * found, and the live stream only on a robot whose radio isn't limiting its
 * bandwidth. Refused live, the reply says `still: true` when stills are offered.
 */
export function handleCameraRequest(
  req: IncomingMessage,
  res: ServerResponse,
  relay: Pick<CameraRelay, 'watch' | 'still'>,
  access: Pick<StaffHttpCheck, 'readRefusal'>,
  allow: (station: StationName, ip: string, port: number) => CameraVerdict,
): boolean {
  const [path, query = ''] = (req.url ?? '').split('?');
  if (path !== '/api/camera') return false;
  const fail = (status: number, error: string, extra: object = {}): true => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error, ...extra }));
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
  if (params.get('still') === '1') {
    relay.still(verdict.key).then(
      frame => {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': frame.length,
          'Cache-Control': 'no-store',
        });
        res.end(frame);
      },
      (err: Error) => fail(502, err.message),
    );
    return true;
  }
  if (verdict.stillsOnly) return fail(409, verdict.stillsOnly, { still: true });
  relay.watch(verdict.key, res);
  return true;
}
