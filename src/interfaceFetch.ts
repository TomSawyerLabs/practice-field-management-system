/**
 * HTTP to a robot out of one interface: a station's bridge, or a robot tester's
 * port. A team on two stations has the same subnet on two bridges, and a team
 * on a station and a test port has it there too, so the routing table sends
 * anything addressed to 10.TE.AM.x to just one of its robots, and fetch() can't
 * choose a device. `curl --interface` can (SO_BINDTODEVICE): the request leaves
 * by that interface and only that interface's replies reach it.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { dryRunRefusal } from './dryRun.js';

const execFile = promisify(execFileCb);

/** curl's exit code for "operation timed out". */
const CURL_TIMED_OUT = 28;
/** curl's exit code when it can't bind: the interface is gone, usually. */
const CURL_CANT_BIND = 45;
/** NI SysAPI answers run to a few hundred KB. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

/** A file in a multipart form. curl reads it, so it never becomes an argument. */
export interface FormFile {
  path: string;
  filename: string;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Multipart fields, sent in this order. Used instead of `body`. */
  form?: Record<string, string | FormFile>;
}

/** The part of a fetch Response the checks use. */
export type HttpReply = Pick<Response, 'ok' | 'status' | 'text' | 'json'>;

type RunCurl = (args: string[]) => Promise<{ stdout: string }>;

const runCurl: RunCurl = args => execFile('curl', args, { maxBuffer: MAX_REPLY_BYTES });

/** What a browser or fetch labels a file part with no type of its own. */
const FORM_FILE_TYPE = 'application/octet-stream';

/** Quote a path for curl's --form, where ; and , would otherwise end it. */
function formQuoted(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

export function curlArgs(ifname: string, url: string, init: HttpRequest, timeoutMs: number): string[] {
  const args = ['--silent', '--show-error', '--location', '--noproxy', '*'];
  args.push('--interface', ifname, '--max-time', String(timeoutMs / 1000));
  if (init.method) args.push('--request', init.method);
  for (const [name, value] of Object.entries(init.headers ?? {})) args.push('--header', `${name}: ${value}`);
  if (init.body !== undefined) args.push('--data-raw', init.body);
  for (const [name, value] of Object.entries(init.form ?? {})) {
    // --form-string takes the value literally. --form would read "@x" as a file.
    if (typeof value === 'string') args.push('--form-string', `${name}=${value}`);
    else
      args.push(
        '--form',
        `${name}=@${formQuoted(value.path)};filename=${formQuoted(value.filename)};type=${FORM_FILE_TYPE}`,
      );
  }
  // curl would otherwise wait a second for a "100 Continue" fetch never asks for
  if (init.form) args.push('--header', 'Expect:');
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
  // The guard on fetch can't see curl
  const writes = init.body !== undefined || init.form !== undefined;
  const refused = dryRunRefusal(url, init.method ?? (writes ? 'POST' : 'GET'));
  if (refused) throw refused;
  try {
    const { stdout } = await run(curlArgs(ifname, url, init, timeoutMs));
    return parseReply(stdout);
  } catch (err) {
    const { code, stderr } = err as { code?: number | string; stderr?: string };
    if (code === 'ENOENT') throw new Error('curl is not installed');
    const said = stderr?.trim() || `curl failed: ${(err as Error).message}`;
    const failure = new Error(
      code === CURL_CANT_BIND ? `Network interface ${ifname} is not available (${said})` : said,
    );
    if (code === CURL_TIMED_OUT) failure.name = 'AbortError';
    throw failure;
  }
}
