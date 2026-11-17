import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import TerminalIcon from '@mui/icons-material/Terminal';
import VideocamIcon from '@mui/icons-material/Videocam';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { Fragment, useEffect, useState } from 'react';

import type { HostService, StationName } from '../../../src/types';

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

/**
 * A camera stream, relayed by pFMS (src/cameraRelay.ts) so it shows on the
 * https site too. pFMS refuses when the robot's radio limits its bandwidth;
 * the reason is shown in place of the picture.
 */
function CameraView({
  station,
  ip,
  port,
  onClose,
}: {
  station: StationName;
  ip: string;
  port: number;
  onClose: () => void;
}) {
  const src = `/api/camera?${new URLSearchParams({ station, ip, port: String(port) })}`;
  const [problem, setProblem] = useState<string | null>(null);
  const onError = async () => {
    // An <img> can't say why; a refusal is a short JSON reply, so ask again for the reason
    const controller = new AbortController();
    try {
      const res = await fetch(src, { signal: controller.signal, cache: 'no-store' });
      if (res.ok) setProblem('The stream ended.');
      else setProblem(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
    } catch {
      setProblem("Couldn't reach pFMS for the stream.");
    } finally {
      controller.abort();
    }
  };
  return (
    <Box sx={{ mt: 0.5, position: 'relative', maxWidth: 480 }}>
      {problem ? (
        <Typography variant="body2" color="text.secondary" sx={{ pr: 4 }}>
          Camera {port}: {problem}
        </Typography>
      ) : (
        <Box
          component="img"
          src={src}
          alt={`Camera ${port} on ${ip}`}
          onError={() => void onError()}
          sx={{ display: 'block', width: '100%', borderRadius: 1, bgcolor: 'black' }}
        />
      )}
      <IconButton
        size="small"
        aria-label={`Close camera ${port}`}
        onClick={onClose}
        sx={{ position: 'absolute', top: 0, right: 0, bgcolor: 'background.paper' }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

/** What a team device offers: named web pages, camera streams (opened in a
 *  tab, or watched inline), SSH. */
export function HostServiceChips({
  station,
  ip,
  services,
}: {
  station: StationName;
  ip: string;
  services: HostService[] | undefined;
}) {
  const [watching, setWatching] = useState<number | null>(null);
  if (!services?.length) return null;
  const watched = services.some(s => s.kind === 'camera' && s.port === watching) ? watching : null;
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
              <Fragment key={`camera-${service.port}`}>
                <LinkChip
                  href={urlFor(ip, service.port)}
                  label={`Camera ${service.port}`}
                  icon={<VideocamIcon />}
                  a11y={`Open the camera stream at ${urlFor(ip, service.port)} in a new tab`}
                />
                <Chip
                  clickable
                  onClick={() => setWatching(watched === service.port ? null : service.port)}
                  label={watched === service.port ? 'Hide' : 'Watch'}
                  aria-label={`${watched === service.port ? 'Hide' : 'Watch'} camera ${service.port} here`}
                  icon={<PlayArrowIcon />}
                  size="small"
                  variant={watched === service.port ? 'filled' : 'outlined'}
                  color="primary"
                  sx={chipSx}
                />
              </Fragment>
            );
          case 'ssh':
            return <SshChip key="ssh" ip={ip} />;
        }
      })}
      {watched !== null && (
        <CameraView key={watched} station={station} ip={ip} port={watched} onClose={() => setWatching(null)} />
      )}
    </>
  );
}
