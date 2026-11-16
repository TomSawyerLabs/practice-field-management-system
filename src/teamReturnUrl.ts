/**
 * Where the team login page may send a browser once it's logged in: back to
 * one of that team's robots (`http://10.TE.AM.x[:port]/…`, or a
 * `roboRIO-1234-FRC.local`-style name), or somewhere on pFMS itself. Anything
 * else would make the login page an open redirect. Shared by the page and
 * its tests, so no Node or browser APIs beyond URL.
 */
export function safeReturnUrl(team: number, raw: string | null | undefined, ownOrigin: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, ownOrigin);
  } catch {
    return null;
  }
  if (url.origin === new URL(ownOrigin).origin) return url.href;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const ip = /^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) return Number(ip[1]) * 100 + Number(ip[2]) === team && Number(ip[3]) <= 255 ? url.href : null;
  const named = /^(?:roborio|systemcore)-(\d{1,5})-[a-z0-9-]*\.local$/.exec(host);
  return named && Number(named[1]) === team ? url.href : null;
}
