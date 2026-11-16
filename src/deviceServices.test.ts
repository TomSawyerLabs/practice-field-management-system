import { describe, expect, test } from 'bun:test';
import {
  PAGE_META,
  connectProbeArgs,
  pageProbeArgs,
  parsePageReply,
  probeServices,
  webLabel,
  type PageReply,
} from './deviceServices.js';

interface FakePage {
  status: number;
  type: string;
  server?: string;
  body?: string;
}

/** A device: its pages by port, and every port that accepts a connection. */
interface FakeDevice {
  pages?: Record<number, FakePage>;
  open?: number[];
}

/** A curl that answers like the devices on 2854's robot did on 2026-11-15. */
function fakeCurl(devices: Record<string, FakeDevice>, asked: string[] = []) {
  return async (_tool: string, args: string[]) => {
    const url = args.at(-1)!;
    asked.push(url);
    const m = url.match(/^(http|telnet):\/\/([\d.]+)(?::(\d+))?/)!;
    const [, scheme, ip, portText] = m;
    const port = Number(portText ?? 80);
    const device = devices[ip] ?? {};
    if (scheme === 'telnet') {
      // An open port connects, then curl times out (28) waiting for data
      if (device.open?.includes(port)) throw Object.assign(new Error('timeout'), { code: 28, stdout: '0.002' });
      throw Object.assign(new Error('refused'), { code: 7, stdout: '0.000000' });
    }
    const p = device.pages?.[port];
    if (!p) throw Object.assign(new Error('refused'), { code: 7, stdout: `${PAGE_META}000\t\t` });
    return { stdout: `${p.body ?? ''}${PAGE_META}${p.status}\t${p.type}\t${p.server ?? ''}` };
  };
}

const html = (title: string) => `<html><head><title>${title}</title></head><body>…</body></html>`;

const team2854: Record<string, FakeDevice> = {
  '10.28.54.1': { pages: { 80: { status: 200, type: 'text/html; charset=utf-8', body: html('Configuration') } } },
  '10.28.54.2': {
    pages: {
      80: { status: 200, type: 'text/html', server: 'Embedthis-http', body: html('HTML Device Configuration') },
    },
    open: [22, 80, 443, 1250, 1735, 1740, 5810],
  },
  '10.28.54.201': {
    pages: {
      80: { status: 200, type: 'text/html', server: 'Apache/2.4.58 (Unix)', body: html('Limelight') },
      5800: { status: 200, type: 'multipart/x-mixed-replace;boundary=frame' },
    },
    open: [22, 80, 5800, 5801],
  },
  '10.28.54.4': {},
};

describe('probe arguments', () => {
  test('pinned to the bridge when there is one', () => {
    expect(pageProbeArgs('10.28.54.2', 80, 'br-slot1').slice(0, 2)).toEqual(['--interface', 'br-slot1']);
    expect(connectProbeArgs('10.28.54.2', 22, 'br-slot1').slice(0, 2)).toEqual(['--interface', 'br-slot1']);
    expect(pageProbeArgs('10.28.54.2', 80)).not.toContain('--interface');
  });

  test('port 80 is the bare address, others name the port', () => {
    expect(pageProbeArgs('10.28.54.2', 80).at(-1)).toBe('http://10.28.54.2/');
    expect(pageProbeArgs('10.28.54.11', 5800).at(-1)).toBe('http://10.28.54.11:5800/');
  });

  test('a page probe stops early, and a connect probe sends nothing', () => {
    expect(pageProbeArgs('10.28.54.2', 80)).toContain('--max-filesize');
    expect(connectProbeArgs('10.28.54.2', 1181).at(-1)).toBe('telnet://10.28.54.2:1181');
  });
});

describe('page replies', () => {
  test('status, type, server and title are read back', () => {
    const reply = parsePageReply(`${html('Lime &amp; light\n')}${PAGE_META}200\ttext/html\tApache`);
    expect(reply).toEqual({ status: 200, contentType: 'text/html', server: 'Apache', title: 'Lime & light' });
  });

  test('nothing answered is no reply', () => {
    expect(parsePageReply(`${PAGE_META}000\t\t`)).toBeNull();
    expect(parsePageReply('')).toBeNull();
  });

  test('a page cut off by the size cap still has its title', () => {
    expect(parsePageReply(`<title>PhotonVision</title>${'x'.repeat(100)}${PAGE_META}200\ttext/html\t`)?.title).toBe(
      'PhotonVision',
    );
  });
});

describe('labels', () => {
  const reply = (title: string, server = ''): PageReply => ({ status: 200, contentType: 'text/html', server, title });

  test('known products by name', () => {
    expect(webLabel('10.28.54.201', reply('Limelight'))).toBe('Limelight');
    expect(webLabel('10.28.54.11', reply('Photon Vision'))).toBe('PhotonVision');
    expect(webLabel('10.28.54.2', reply('HTML Device Configuration', 'Embedthis-http'))).toBe('roboRIO');
    expect(webLabel('10.28.54.1', reply('Configuration'))).toBe('Radio');
  });

  test('anything else by its title, kept short, or "Web"', () => {
    expect(webLabel('10.28.54.12', reply('Elastic'))).toBe('Elastic');
    expect(webLabel('10.28.54.12', reply('A very long page title that goes on and on'))).toHaveLength(24);
    expect(webLabel('10.28.54.12', reply(''))).toBe('Web');
  });
});

describe('what each device offers', () => {
  test("2854's devices: named pages, SSH where open, nothing for a silent one", async () => {
    const asked: string[] = [];
    const run = fakeCurl(team2854, asked);
    expect(await probeServices(run, '10.28.54.1')).toEqual([{ kind: 'web', port: 80, label: 'Radio' }]);
    expect(await probeServices(run, '10.28.54.2')).toEqual([
      { kind: 'web', port: 80, label: 'roboRIO' },
      { kind: 'ssh' },
    ]);
    expect(await probeServices(run, '10.28.54.201')).toEqual([
      { kind: 'web', port: 80, label: 'Limelight' },
      { kind: 'ssh' },
    ]);
    expect(await probeServices(run, '10.28.54.4')).toEqual([]);
    // A Limelight's 5800 is its video: never asked for a page
    expect(asked).not.toContain('http://10.28.54.201:5800/');
  });

  test('PhotonVision is found on 5800 when nothing serves 80', async () => {
    const run = fakeCurl({
      '10.28.54.11': { pages: { 5800: { status: 200, type: 'text/html', body: html('Photon Vision') } }, open: [22] },
    });
    expect(await probeServices(run, '10.28.54.11')).toEqual([
      { kind: 'web', port: 5800, label: 'PhotonVision' },
      { kind: 'ssh' },
    ]);
  });

  test('a stream on 5800 is not linked as a page', async () => {
    const run = fakeCurl({ '10.28.54.12': { pages: { 5800: { status: 200, type: 'multipart/x-mixed-replace' } } } });
    expect(await probeServices(run, '10.28.54.12')).toEqual([]);
  });

  test('camera streams are found by connecting, never by asking for one', async () => {
    const asked: string[] = [];
    const run = fakeCurl({ '10.28.54.2': { open: [1181, 1182] } }, asked);
    expect(await probeServices(run, '10.28.54.2')).toEqual([
      { kind: 'camera', port: 1181 },
      { kind: 'camera', port: 1182 },
    ]);
    expect(asked.filter(u => /:118\d/.test(u)).every(u => u.startsWith('telnet://'))).toBe(true);
  });

  test('no curl at all offers nothing', async () => {
    const run = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(await probeServices(run, '10.28.54.2')).toEqual([]);
  });
});
