import { useState, useEffect, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { CheckResult } from '../../../src/types';
import { CopyToClipboard } from './CopyToClipboard';
import { StatusIcon } from './TeamChecksPanel';

/**
 * Display a single check result with status icon and details.
 * @param compact - Use smaller typography and tighter spacing for inline views.
 */
export function CheckResultRow({ check, compact }: { check: CheckResult; compact?: boolean }) {
  const failed = check.status === 'fail' || check.status === 'error' || check.status === 'warn';
  const variant = compact ? ('caption' as const) : ('body2' as const);
  const detailSize = compact ? '0.7rem' : '0.75rem';
  const nameSize = compact ? undefined : '0.85rem';
  const gap = compact ? 0.5 : 1;
  const iconSize = compact ? 16 : undefined;

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap, py: 0.25 }}>
      <StatusIcon status={check.status} size={iconSize} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant={variant} sx={{ fontSize: nameSize, fontWeight: 500 }}>
          {check.name}
        </Typography>
        {check.status === 'pass' && (check.actual || check.message) && (
          <Typography
            variant="caption"
            sx={{
              color: 'text.secondary',
              fontFamily: check.actual ? 'monospace' : undefined,
              fontSize: detailSize,
              display: compact ? 'block' : undefined,
            }}
          >
            {check.actual ?? check.message}
          </Typography>
        )}
        {failed && (
          <Box>
            {check.expected && check.actual && (
              <Typography variant="caption" sx={{ fontSize: detailSize, display: 'block' }}>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  expected{' '}
                </Box>
                <Box component="span" sx={{ fontFamily: 'monospace' }}>
                  {check.expected}
                </Box>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  , got{' '}
                </Box>
                <Box component="span" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                  {check.actual}
                </Box>
              </Typography>
            )}
            {check.message && !check.expected && (
              <Typography variant="caption" sx={{ fontSize: detailSize, color: 'text.secondary' }}>
                {check.message}
              </Typography>
            )}
            {check.helpUrl && (
              <Link href={check.helpUrl} target="_blank" rel="noopener" sx={{ fontSize: detailSize, display: 'block' }}>
                How to fix
              </Link>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * Banner shown after radio reconfiguration or firmware update while the network settles.
 * @param compact - Use smaller typography for inline views.
 */
export function SettlingBanner({
  reconfiguredAt,
  timeoutMs,
  type,
  compact,
}: {
  reconfiguredAt: number;
  timeoutMs: number;
  type?: 'radio' | 'firmware';
  compact?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Date.now() - reconfiguredAt);
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [reconfiguredAt]);

  const label = type === 'firmware' ? 'firmware update' : 'reconfiguration';
  const expectedMs = type === 'firmware' ? 60_000 : 40_000;
  const secs = Math.round(elapsed / 1000);
  const variant = compact ? ('caption' as const) : ('body2' as const);
  const mbVal = compact ? 1 : 1.5;
  const pyVal = compact ? 0 : 0.5;
  const fontSize = compact ? undefined : '0.85rem';

  if (elapsed > timeoutMs) {
    return (
      <Alert severity="error" sx={{ mb: mbVal, py: pyVal }}>
        <Typography variant={variant} sx={{ fontSize }}>
          Network did not stabilize after {label} ({secs}s). Try power-cycling the robot.
        </Typography>
      </Alert>
    );
  }

  if (elapsed > expectedMs) {
    return (
      <Alert severity="warning" sx={{ mb: mbVal, py: pyVal }}>
        <Typography variant={variant} sx={{ fontSize }}>
          Network settling after {label} ({secs}s). Please wait...
        </Typography>
      </Alert>
    );
  }

  return (
    <Alert severity="info" sx={{ mb: mbVal, py: pyVal }}>
      <Typography variant={variant} sx={{ fontSize }}>
        Radio {type === 'firmware' ? 'updated' : 'reconfigured'}. Network settling ({secs}s)...
      </Typography>
    </Alert>
  );
}

// ── Robot addresses ─────────────────────────────────────────────────

export type ControllerKind = 'roboRIO' | 'systemcore' | null;

/** `10.TE.AM` for a team — the first three octets every robot-side address hangs off. */
export function teamSubnet(team: number): string {
  return `10.${Math.floor(team / 100)}.${team % 100}`;
}

/**
 * Which controller the checks found. The roboRIO checks are all named
 * "roboRIO …" (the not-found error is also named "roboRIO", so it is skipped);
 * a SystemCore announces itself in the "Robot Controller" check's value.
 */
export function controllerFromChecks(checks: CheckResult[]): ControllerKind {
  if (checks.some(c => c.name === 'Robot Controller' && c.actual?.startsWith('SystemCore'))) return 'systemcore';
  if (checks.some(c => c.name.startsWith('roboRIO') && c.status !== 'error')) return 'roboRIO';
  return null;
}

function AddressLink({ href, small }: { href: string; small?: boolean }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener"
      sx={{ fontFamily: 'monospace', fontSize: small ? '0.7rem' : undefined }}
    >
      {href}
    </Link>
  );
}

/**
 * The addresses a mentor reaches for once the robot is on the network: the
 * radio and controller web pages, and the Driver Station's static IP. Every
 * row names the alternative (.local name, factory address) inline rather than
 * behind a hover, and the full variant says when the links actually answer —
 * they are on the robot's subnet, so a laptop on the guest Wi‑Fi only gets
 * there while driving that station, on a field port, or wired to the radio.
 *
 * With no controller identified yet both roboRIO and SystemCore rows show, so
 * the page is useful before (or without) the controller probe succeeding.
 */
export function RobotAddresses({
  team,
  controller,
  compact,
}: {
  team: number;
  controller: ControllerKind;
  compact?: boolean;
}) {
  const subnet = teamSubnet(team);
  const radio = `http://${subnet}.1`;
  const rio = `http://${subnet}.2`;
  const core = `http://${subnet}.2/configure`;
  const showRio = controller !== 'systemcore';
  const showCore = controller !== 'roboRIO';

  if (compact) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontSize: '0.7rem' }}>
        Radio <AddressLink href={radio} small />
        {showRio && (
          <>
            {' · '}roboRIO <AddressLink href={rio} small />
          </>
        )}
        {showCore && (
          <>
            {' · '}SystemCore <AddressLink href={core} small />
          </>
        )}
      </Typography>
    );
  }

  const rows: { label: string; main: ReactNode; also: string }[] = [
    {
      label: 'Radio config',
      main: <AddressLink href={radio} />,
      also: 'http://radio.local from the robot’s network; http://192.168.69.1 on a factory-fresh radio',
    },
  ];
  if (showRio) {
    rows.push({
      label: 'roboRIO web config',
      main: <AddressLink href={rio} />,
      also: `http://roborio-${team}-frc.local`,
    });
  }
  if (showCore) {
    rows.push({
      label: 'SystemCore dashboard',
      main: <AddressLink href={core} />,
      also: 'http://robot.local/configure',
    });
  }
  rows.push({
    label: 'Driver Station static IP',
    main: (
      <CopyToClipboard text={`${subnet}.5`} tooltipText="Copy">
        <Box component="span" sx={{ fontFamily: 'monospace', cursor: 'pointer' }}>
          {subnet}.5
        </Box>
      </CopyToClipboard>
    ),
    also: 'mask 255.0.0.0 — only if the laptop is not on DHCP',
  });

  return (
    <Box sx={{ pt: 1, borderTop: 1, borderColor: 'divider' }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
        Handy addresses
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 1.5, rowGap: 0.25 }}>
        {rows.map(row => (
          <Box key={row.label} sx={{ display: 'contents' }}>
            <Typography variant="caption" color="text.secondary">
              {row.label}
            </Typography>
            <Typography variant="caption" sx={{ minWidth: 0 }}>
              {row.main}
              <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.7rem', display: 'block' }}>
                {row.also}
              </Box>
            </Typography>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontSize: '0.7rem' }}>
        These answer from the robot's network — while driving it from its station page, on a field port, or wired to the
        radio.
      </Typography>
    </Box>
  );
}
