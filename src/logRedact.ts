/**
 * Copies of client messages that are safe to write to the log.
 *
 * The websocket server logs every message it receives, and journald keeps
 * them for weeks. Admin logins carry the passphrase, every reconnect of an
 * admin page carries its session token, and settings saves carry Slack and
 * Home Assistant tokens, webhook ids and HTTP Authorization headers — none
 * of which belong in a log anyone with shell access can read.
 */

/** Field names whose values are credentials, wherever they are nested. */
const SECRET_KEY = /token|secret|passphrase|password|webhookid|wpakey|apikey|^authorization$|^cookie$/i;

export const REDACTED = '***';

/** A deep copy of `value` with every credential-looking field replaced. */
export function redactForLog(value: unknown, depth = 0): unknown {
  // Messages are shallow; the cap only guards against something cyclic.
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redactForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Booleans such as `passphraseConfigured` say nothing secret.
    out[k] = SECRET_KEY.test(k) && v !== null && typeof v !== 'boolean' ? REDACTED : redactForLog(v, depth + 1);
  }
  return out;
}
