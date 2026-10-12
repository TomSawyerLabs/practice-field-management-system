import type { Alliance, DiscoveredHost, StationName } from './types.js';
import CIDRMatcher from 'cidr-matcher';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatAge(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function formatDuration(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function describeIp(host: DiscoveredHost): string | null {
  if (host.source === 'conntrack') return 'Guest Network';
  const lastOctet = parseInt(host.ip.split('.')[3]);
  if (lastOctet === 1) return 'Radio';
  if (lastOctet === 2) return 'roboRIO';
  if (lastOctet >= 100 && lastOctet <= 199) return 'DHCP client';
  return null;
}

export function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

/** Returns the MUI-friendly hex color for an alliance. */
export function allianceColor(alliance: Alliance): string {
  return alliance === 'red' ? '#d32f2f' : '#1565c0';
}

export function prettyStationName(station: StationName) {
  const match = station.match(/^slot(\d)$/);
  if (!match) {
    throw new Error(`Invalid station name: ${station}`);
  }
  return `Slot ${match[1]}`;
}

/** Team number out of a robot's SSID ("1234-Comp" → 1234), or null. */
export function teamOfSsid(ssid: string | null | undefined): number | null {
  if (!ssid) return null;
  const num = parseInt(ssid.split('-', 2)[0], 10);
  return Number.isNaN(num) ? null : num;
}

/**
 * Convert ip to CIDR format for CIDRMatcher
 */
export function toCidr(ip: string): string {
  ip = ip.trim();

  if (ip.includes('/')) return ip; // assume already CIDR

  // Simple IP validation - check for IPv4 or IPv6 patterns
  const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
  const isIPv6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$|::(1$|ffff:))/i.test(ip);

  if (isIPv4) return `${ip}/32`;
  if (isIPv6) return `${ip}/128`;

  throw new Error(`Invalid ip: ${ip}`);
}

/** Strips IPv4-mapped IPv6 prefix (::ffff:) so we always work with plain IPv4 strings. */
export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

/**
 * Extracts the real client IP from request headers, considering trusted proxies
 * @param socketRemoteAddress - The remote address from the socket
 * @param requestHeaders - The request headers object
 * @param trustedProxyMatcher - Trusted proxy matcher instance
 * @returns The real client IP address
 */
export function getRealClientIp(
  socketRemoteAddress: string | undefined,
  requestHeaders: Record<string, string | string[] | undefined>,
  trustedProxyMatcher?: CIDRMatcher,
): string {
  if (!socketRemoteAddress) {
    return 'unknown';
  }

  // If no trusted proxy matcher, just return the socket remote address
  if (!trustedProxyMatcher) {
    return socketRemoteAddress;
  }

  // If the client IP is not a trusted proxy, return it as-is
  if (!trustedProxyMatcher.contains(socketRemoteAddress)) {
    return socketRemoteAddress;
  }

  // Extract real IP from headers (trusted proxy scenario)
  const forwardedFor = requestHeaders['x-forwarded-for'];
  const realIp = requestHeaders['x-real-ip'];
  const cfConnectingIp = requestHeaders['cf-connecting-ip']; // Cloudflare

  // Parse X-Forwarded-For (can contain multiple IPs, the first one is the original client)
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstIp = ips.split(',')[0].trim();
    if (firstIp) {
      return firstIp;
    }
  }

  // Fall back to X-Real-IP
  if (realIp) {
    const ip = Array.isArray(realIp) ? realIp[0] : realIp;
    if (ip) {
      return ip;
    }
  }

  // Fall back to Cloudflare's CF-Connecting-IP
  if (cfConnectingIp) {
    const ip = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
    if (ip) {
      return ip;
    }
  }

  // If we can't find the real IP in headers, return the socket address
  return socketRemoteAddress || 'unknown';
}
