import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import TerminalIcon from '@mui/icons-material/Terminal';
import VideocamIcon from '@mui/icons-material/Videocam';
import Chip from '@mui/material/Chip';
import { useEffect, useState } from 'react';

import type { HostService } from '../../../src/types';

const chipSx = { ml: 0.75, height: 18, fontSize: '0.6rem', '& .MuiChip-icon': { fontSize: '0.75rem' } } as const;

/** Copy to the clipboard, also on a plain-http page where navigator.clipboard is missing. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the old way
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function urlFor(ip: string, port: number): string {
  return port === 80 ? `http://${ip}/` : `http://${ip}:${port}/`;
}

/** Opens in a new tab. */
function LinkChip({
  href,
  label,
  icon,
  a11y,
}: {
  href: string;
  label: string;
  icon: React.ReactElement;
  a11y: string;
}) {
  return (
    <Chip
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      clickable
      label={label}
      aria-label={a11y}
      icon={icon}
      size="small"
      variant="outlined"
      color="primary"
      sx={chipSx}
    />
  );
}

/** Tap to copy `ssh <ip>`; the chip itself says when it worked. */
function SshChip({ ip }: { ip: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const command = `ssh ${ip}`;
  return (
    <Chip
      clickable
      onClick={async () => setCopied(await copyText(command))}
      label={copied === null ? 'SSH' : copied ? 'Copied' : command}
      aria-label={`SSH is open. Copy "${command}"`}
      icon={<TerminalIcon />}
      size="small"
      variant="outlined"
      color={copied ? 'success' : 'default'}
      sx={chipSx}
    />
  );
}

/** What a team device offers: named web pages, camera streams, SSH. */
export function HostServiceChips({ ip, services }: { ip: string; services: HostService[] | undefined }) {
  if (!services?.length) return null;
  return (
    <>
      {services.map(service => {
        switch (service.kind) {
          case 'web':
            return (
              <LinkChip
                key={`web-${service.port}`}
                href={urlFor(ip, service.port)}
                label={service.label}
                icon={<OpenInNewIcon />}
                a11y={`Open ${service.label} at ${urlFor(ip, service.port)} in a new tab`}
              />
            );
          case 'camera':
            return (
              <LinkChip
                key={`camera-${service.port}`}
                href={urlFor(ip, service.port)}
                label={`Camera ${service.port}`}
                icon={<VideocamIcon />}
                a11y={`Open the camera stream at ${urlFor(ip, service.port)} in a new tab`}
              />
            );
          case 'ssh':
            return <SshChip key="ssh" ip={ip} />;
        }
      })}
    </>
  );
}
