import type { IncomingMessage } from 'node:http';
import type CIDRMatcher from 'cidr-matcher';
import type { AdminAuth } from './adminAuth.js';
import { accessCookieOf } from './externalAccessAuth.js';
import type { ExternalAccessStore } from './externalAccessStore.js';
import { isOnSite, type OnLinkChecker } from './onLink.js';
import type { OperatorAuth } from './operatorAuth.js';
import { getRealClientIp, normalizeIp } from './utils.js';
import { isCrossSite } from './wsAccess.js';

/** The tokens a page keeps for its socket, sent as headers: HTTP has no socket
 *  to remember a login on. A custom header also makes a browser ask first, so
 *  another site's page can't send one. */
export const ADMIN_TOKEN_HEADER = 'x-pfms-admin-token';
export const OPERATOR_TOKEN_HEADER = 'x-pfms-operator-token';

export interface StaffHttpDeps {
  adminAuth: Pick<AdminAuth, 'validateToken'>;
  operatorAuth: Pick<OperatorAuth, 'isRequired' | 'validateToken'>;
  externalAccessStore: Pick<ExternalAccessStore, 'isValid'>;
  /** Built with ON_SITE_IPV6_PREFIX, as for the WebSocket. */
  siteNetworks: OnLinkChecker;
  trustedProxyMatcher?: CIDRMatcher;
  /** Whether this address is a Driver Station right now. Only the address
   *  counts here: a hostname match can be waved away on a page, not on a POST. */
  isDriverStation: (ip: string) => boolean;
}

export interface HttpRefusal {
  status: number;
  error: string;
}

export interface StaffHttpCheck {
  /** Reading: on site, or off site with a credential. */
  readRefusal(req: IncomingMessage): HttpRefusal | null;
  /** The `staff` tier of src/wsAccess.ts for an HTTP request, so a CSA tool
   *  needs the same thing whichever way it reaches the server. */
  staffRefusal(req: IncomingMessage): HttpRefusal | null;
}

const header = (req: IncomingMessage, name: string): string => [req.headers[name]].flat()[0] ?? '';

export function createStaffHttpCheck(deps: StaffHttpDeps): StaffHttpCheck {
  const { adminAuth, operatorAuth, externalAccessStore, siteNetworks, trustedProxyMatcher, isDriverStation } = deps;

  const isAdmin = (req: IncomingMessage) => adminAuth.validateToken(header(req, ADMIN_TOKEN_HEADER));
  const isOperator = (req: IncomingMessage) => operatorAuth.validateToken(header(req, OPERATOR_TOKEN_HEADER)) !== null;
  const clientIp = (req: IncomingMessage) =>
    normalizeIp(getRealClientIp(req.socket.remoteAddress, req.headers, trustedProxyMatcher));

  /** The WebSocket's rule: another site's page never counts, and off site takes
   *  a credential. CORS can't do the first part: a plain POST is sent whether or
   *  not the reply may be read. */
  function placeRefusal(req: IncomingMessage): HttpRefusal | null {
    const elsewhere: HttpRefusal = { status: 403, error: 'This only works from the field network' };
    if (isCrossSite(req.headers)) return elsewhere;
    if (isOnSite(clientIp(req), siteNetworks)) return null;
    const cookie = accessCookieOf(req.headers.cookie);
    if (cookie && externalAccessStore.isValid(cookie)) return null;
    return isAdmin(req) || isOperator(req) ? null : elsewhere;
  }

  return {
    readRefusal: placeRefusal,
    staffRefusal(req) {
      const refused = placeRefusal(req);
      if (refused) return refused;
      if (isAdmin(req)) return null;
      if (isDriverStation(clientIp(req))) {
        return { status: 403, error: 'This device is a Driver Station — use a phone or another device for this' };
      }
      if (operatorAuth.isRequired() && !isOperator(req)) return { status: 401, error: 'Operator login required' };
      return null;
    },
  };
}
