/**
 * What a device on a team subnet offers that a person can open: its web page
 * (a radio, roboRIO, Limelight or PhotonVision UI), robot-code camera streams,
 * and SSH. The Network page turns these into links.
 *
 * Every probe is curl pinned to the station's bridge, for the same reason as the
 * fping sweep: a team on two stations has its subnet on two bridges. Stream ports
 * are only ever connected to, never asked for a page, so no probe makes a robot
 * encode video.
 */
import type { HostService } from './types.js';

type RunTool = (tool: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

/** Robot-code CameraServer streams: WPILib numbers them up from 1181. */
export const CAMERA_PORTS = Array.from({ length: 10 }, (_, i) => 1181 + i);
/** PhotonVision's UI. On a Limelight it is the camera stream instead. */
export const PHOTONVISION_PORT = 5800;
/** Most of a page's <title> is in its first few KB. Also cuts off a stream. */
const MAX_PAGE_BYTES = 65_536;
/** Separates the page body from curl's --write-out summary. */
export const PAGE_META = '\n@@pfms-probe@@';

const pinned = (ifname?: string) => (ifname ? ['--interface', ifname] : []);

/** curl arguments fetching the start of a page, with its status, type and server. */
export function pageProbeArgs(ip: string, port: number, ifname?: string): string[] {
  return [
    ...pinned(ifname),
    '--silent',
    '--noproxy',
    '*',
    '--location',
    '--max-redirs',
    '2',
    '--connect-timeout',
    '1',
    '--max-time',
    '2',
    '--max-filesize',
    String(MAX_PAGE_BYTES),
    '--write-out',
    `${PAGE_META}%{http_code}\t%{content_type}\t%header{server}`,
    port === 80 ? `http://${ip}/` : `http://${ip}:${port}/`,
  ];
}

/** curl arguments that only open a TCP connection and say how long it took. */
export function connectProbeArgs(ip: string, port: number, ifname?: string): string[] {
  return [
    ...pinned(ifname),
    '--silent',
    '--connect-timeout',
    '1',
    '--max-time',
    '1',
    '--output',
    '/dev/null',
    '--write-out',
    '%{time_connect}',
    `telnet://${ip}:${port}`,
  ];
}

export interface PageReply {
  status: number;
  contentType: string;
  server: string;
  title: string;
}

/** Undo the handful of entities that show up in device page titles. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function parsePageReply(stdout: string): PageReply | null {
  const at = stdout.lastIndexOf(PAGE_META);
  if (at < 0) return null;
  const [code, contentType = '', server = ''] = stdout.slice(at + PAGE_META.length).split('\t');
  const status = Number(code);
  if (!Number.isInteger(status) || status === 0) return null;
  const title = stdout.slice(0, at).match(/<title[^>]*>([^<]*)/i)?.[1] ?? '';
  return {
    status,
    contentType: contentType.trim().toLowerCase(),
    server: server.trim(),
    title: decodeEntities(title).replace(/\s+/g, ' ').trim(),
  };
}

const isHtml = (reply: PageReply) => reply.contentType.startsWith('text/html');

/** A short name for what serves this page: the product when we know it. */
export function webLabel(ip: string, reply: PageReply): string {
  const { title, server } = reply;
  if (/limelight/i.test(title)) return 'Limelight';
  if (/photon\s*vision/i.test(title)) return 'PhotonVision';
  if (/embedthis/i.test(server) || /^HTML Device Configuration$/i.test(title)) return 'roboRIO';
  const octet = Number(ip.split('.')[3]);
  if (octet === 1) return 'Radio';
  if (title) return title.length > 24 ? `${title.slice(0, 23)}…` : title;
  return 'Web';
}

/** Run curl; a non-zero exit still carries its --write-out output. */
async function curl(run: RunTool, args: string[]): Promise<string> {
  try {
    return (await run('curl', args, { timeout: 5_000 })).stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? '';
  }
}

async function page(run: RunTool, ip: string, port: number, ifname?: string) {
  return parsePageReply(await curl(run, pageProbeArgs(ip, port, ifname)));
}

/** Open: the connection was made, whether or not curl then timed out waiting. */
async function isOpen(run: RunTool, ip: string, port: number, ifname?: string): Promise<boolean> {
  return Number((await curl(run, connectProbeArgs(ip, port, ifname))).trim()) > 0;
}

/** Everything `ip` offers, in the order the Network page shows it. */
export async function probeServices(run: RunTool, ip: string, ifname?: string): Promise<HostService[]> {
  const [main, ssh, cameras] = await Promise.all([
    page(run, ip, 80, ifname),
    isOpen(run, ip, 22, ifname),
    Promise.all(CAMERA_PORTS.map(async port => ((await isOpen(run, ip, port, ifname)) ? port : null))),
  ]);
  const services: HostService[] = [];
  if (main) services.push({ kind: 'web', port: 80, label: webLabel(ip, main) });
  // A Limelight's 5800 is its camera stream, and its UI is already on 80
  if (!main || webLabel(ip, main) !== 'Limelight') {
    const photon = await page(run, ip, PHOTONVISION_PORT, ifname);
    if (photon && isHtml(photon) && photon.status < 400) {
      services.push({ kind: 'web', port: PHOTONVISION_PORT, label: webLabel(ip, photon) });
    }
  }
  for (const port of cameras) if (port !== null) services.push({ kind: 'camera', port });
  if (ssh) services.push({ kind: 'ssh' });
  return services;
}
