/**
 * HTTP to a robot out of one station's bridge. A team on two stations has the
 * same subnet on two bridges, so the routing table sends anything addressed
 * to 10.TE.AM.x to just one of its robots, and fetch() can't choose a device.
 * `curl --interface` can (SO_BINDTODEVICE): the request leaves by that bridge
 * and only that bridge's replies reach it.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** curl's exit code for "operation timed out". */
const CURL_TIMED_OUT = 28;
/** NI SysAPI answers run to a few hundred KB. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The part of a fetch Response the checks use. */
export type HttpReply = Pick<Response, 'ok' | 'status' | 'text' | 'json'>;

type RunCurl = (args: string[]) => Promise<{ stdout: string }>;

const runCurl: RunCurl = args => execFile('curl', args, { maxBuffer: MAX_REPLY_BYTES });

export function curlArgs(ifname: string, url: string, init: HttpRequest, timeoutMs: number): string[] {
  const args = ['--silent', '--show-error', '--location', '--noproxy', '*'];
  args.push('--interface', ifname, '--max-time', String(timeoutMs / 1000));
  if (init.method) args.push('--request', init.method);
  for (const [name, value] of Object.entries(init.headers ?? {})) args.push('--header', `${name}: ${value}`);
  if (init.body !== undefined) args.push('--data-raw', init.body);
  // The status goes on its own last line, after the body.
  args.push('--write-out', '\n%{http_code}', url);
  return args;
}

function parseReply(stdout: string): HttpReply {
  const split = stdout.lastIndexOf('\n');
  const body = stdout.slice(0, split);
  const status = Number(stdout.slice(split + 1));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** fetch(), out of `ifname`. Rejects like fetch does, with an AbortError on timeout. */
export async function fetchOnInterface(
  ifname: string,
  url: string,
  init: HttpRequest = {},
  timeoutMs: number,
  run: RunCurl = runCurl,
): Promise<HttpReply> {
  try {
    const { stdout } = await run(curlArgs(ifname, url, init, timeoutMs));
    return parseReply(stdout);
  } catch (err) {
    const { code, stderr } = err as { code?: number | string; stderr?: string };
    if (code === 'ENOENT') throw new Error('curl is not installed');
    const failure = new Error(stderr?.trim() || `curl failed: ${(err as Error).message}`);
    if (code === CURL_TIMED_OUT) failure.name = 'AbortError';
    throw failure;
  }
}
