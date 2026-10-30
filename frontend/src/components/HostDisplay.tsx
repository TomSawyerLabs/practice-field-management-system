import Tooltip from '@mui/material/Tooltip';

import { useHostnameFor } from '../hooks/useBackend';

/** Resolved device name for a guest-network host, or null if not (yet) known. */
export function useHostname(ip: string | undefined): string | null {
  return useHostnameFor(ip);
}

/**
 * Label for a guest-network host: shows its device name when the backend has
 * resolved one (hover / long-press reveals the IP), falls back to the bare IP.
 */
export function HostDisplay({ ip }: { ip: string }) {
  const name = useHostname(ip);
  if (!name) return <>{ip}</>;
  return (
    <Tooltip title={ip} arrow>
      <span style={{ textDecoration: 'underline dotted', textUnderlineOffset: 2, cursor: 'help' }}>{name}</span>
    </Tooltip>
  );
}
