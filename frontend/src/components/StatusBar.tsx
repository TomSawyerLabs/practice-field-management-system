import { useState, useEffect } from 'react';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Button from '@mui/material/Button';
import GitHubIcon from '@mui/icons-material/GitHub';
import ScoreboardIcon from '@mui/icons-material/Scoreboard';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import { useConnectivity, ConnectivityState } from '../hooks/useConnectivity';
import {
  usePendingCommit,
  usePendingCommitState,
  useLatest,
  sendApplyConfig,
  useServerStartTime,
  serverToBrowserTime,
} from '../hooks/useBackend';
import { StationNameList, type StationName } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import { useSupportWidget } from './SupportChatWidget';

type DotColor = 'success.main' | 'error.main' | 'warning.main' | 'text.disabled';

function StatusDot({ color, label, tooltip }: { color: DotColor; label: string; tooltip: string }) {
  return (
    <Tooltip title={tooltip} arrow>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mx: 1, cursor: 'default' }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: color,
            flexShrink: 0,
          }}
        />
        <Typography variant="caption" sx={{ fontSize: '0.7rem', color: 'text.secondary', userSelect: 'none' }}>
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function UptimeDisplay({ serverStartTime }: { serverStartTime: number }) {
  const [uptime, setUptime] = useState(() => Date.now() - serverToBrowserTime(serverStartTime));

  useEffect(() => {
    setUptime(Date.now() - serverToBrowserTime(serverStartTime));
    const interval = setInterval(() => {
      setUptime(Date.now() - serverToBrowserTime(serverStartTime));
    }, 1000);
    return () => clearInterval(interval);
  }, [serverStartTime]);

  // Hide after 1 hour — uptime is only interesting shortly after a restart
  if (uptime >= 3_600_000) return null;

  return (
    <Tooltip title="Backend uptime" arrow>
      <Typography
        variant="caption"
        sx={{ fontSize: '0.7rem', color: 'text.secondary', userSelect: 'none', mx: 1, cursor: 'default' }}
      >
        {formatUptime(uptime)}
      </Typography>
    </Tooltip>
  );
}

function getInternetIndicator(state: ConnectivityState) {
  if (state.internet === 'checking') return { color: 'text.disabled' as DotColor, tooltip: 'Checking internet...' };
  if (state.internet === 'ok') return { color: 'success.main' as DotColor, tooltip: 'Internet reachable' };
  return { color: 'error.main' as DotColor, tooltip: 'Internet unreachable' };
}

function getPfmsIndicator(state: ConnectivityState) {
  if (state.wsConnected) return { color: 'success.main' as DotColor, tooltip: 'PFMS connected' };
  return { color: 'error.main' as DotColor, tooltip: 'PFMS disconnected' };
}

function SupportCalloutBubble({ onClick }: { onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'absolute',
        top: '100%',
        right: 0,
        mt: 0.75,
        px: 1.5,
        py: 0.75,
        backgroundColor: 'warning.main',
        color: 'warning.contrastText',
        borderRadius: 1.5,
        fontSize: '0.7rem',
        fontWeight: 'bold',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        boxShadow: 3,
        zIndex: 1,
        // Speech bubble arrow pointing up
        '&::before': {
          content: '""',
          position: 'absolute',
          top: -6,
          right: 4,
          width: 0,
          height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderBottom: '6px solid',
          borderBottomColor: 'warning.main',
        },
        animation: 'supportBubblePulse 2s ease-in-out infinite',
        '@keyframes supportBubblePulse': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.03)' },
        },
      }}
    >
      Click here for immediate help!
    </Box>
  );
}

function SupportButton() {
  const [noticed, setNoticed] = useState(() => localStorage.getItem('support-noticed') === 'true');

  try {
    const { openWidget, unreadCount } = useSupportWidget();
    const handleClick = () => {
      if (!noticed) {
        localStorage.setItem('support-noticed', 'true');
        setNoticed(true);
      }
      openWidget();
    };
    return (
      <Box sx={{ position: 'relative' }}>
        <Tooltip title="Get Help / Report Issue" arrow disableHoverListener={!noticed}>
          <IconButton onClick={handleClick} size="small" sx={{ p: 0, color: 'warning.main' }}>
            <Badge
              badgeContent={unreadCount || undefined}
              color="error"
              invisible={!unreadCount}
              sx={{ '& .MuiBadge-badge': { fontSize: '0.55rem', minWidth: 14, height: 14 } }}
            >
              <SupportAgentIcon sx={{ fontSize: 14 }} />
            </Badge>
          </IconButton>
        </Tooltip>
        {!noticed && <SupportCalloutBubble onClick={handleClick} />}
      </Box>
    );
  } catch {
    // No SupportWidgetProvider — fall back to link
    const handleClick = () => {
      localStorage.setItem('support-noticed', 'true');
      setNoticed(true);
    };
    return (
      <Box sx={{ position: 'relative' }}>
        <Tooltip title="Get Help / Report Issue" arrow disableHoverListener={!noticed}>
          <IconButton
            component="a"
            href="/support"
            size="small"
            sx={{ p: 0, color: 'warning.main' }}
            onClick={handleClick}
          >
            <SupportAgentIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        {!noticed && <SupportCalloutBubble onClick={handleClick} />}
      </Box>
    );
  }
}

/** One line per staged station change, plus the deferred re-apply if owed.
 *  High level only: which slot, which SSID goes/comes — never a passphrase. */
function PendingChangeList() {
  const pending = usePendingCommitState();
  const latest = useLatest();
  const active = latest?.radioUpdate?.stationStatuses;
  const lines: string[] = [];
  for (const station of StationNameList) {
    const staged = pending.stagedChanges?.[station as StationName];
    if (staged === undefined) continue;
    const label = prettyStationName(station);
    const current = active?.[station as StationName]?.ssid || undefined;
    if (staged === null) {
      lines.push(`${label}: clear${current ? ` ${current}` : ''}`);
      continue;
    }
    let text: string;
    if (!current) text = `${label}: configure ${staged.ssid}`;
    else if (current === staged.ssid) text = `${label}: re-apply ${staged.ssid}`;
    else text = `${label}: ${current} → ${staged.ssid}`;
    if (staged.internetAccess !== undefined) text += ` · internet ${staged.internetAccess ? 'on' : 'off'}`;
    lines.push(text);
  }
  if (pending.deferred) lines.push('Re-apply the current configuration (held back while a match was running)');
  return (
    <Box sx={{ fontSize: '0.75rem' }}>
      <Box sx={{ fontWeight: 700, mb: lines.length ? 0.5 : 0 }}>
        {lines.length ? 'Apply to the radio:' : 'Configuration changes are staged but not yet applied to the radio.'}
      </Box>
      {lines.map(l => (
        <Box key={l} sx={{ whiteSpace: 'nowrap' }}>
          • {l}
        </Box>
      ))}
    </Box>
  );
}

export function StatusBar() {
  const connectivity = useConnectivity();
  const internet = getInternetIndicator(connectivity);
  const pfms = getPfmsIndicator(connectivity);
  const pendingCommit = usePendingCommit();
  const showApply = pendingCommit;
  const serverStartTime = useServerStartTime();

  const handleApply = () => {
    // Backend already has staged changes — just commit them
    sendApplyConfig();
  };

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        px: 1,
        backgroundColor: showApply ? 'warning.dark' : 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
        transition: 'background-color 0.3s',
      }}
    >
      <StatusDot color={internet.color} label="Internet" tooltip={internet.tooltip} />
      <StatusDot color={pfms.color} label="PFMS" tooltip={pfms.tooltip} />
      {serverStartTime != null && <UptimeDisplay serverStartTime={serverStartTime} />}
      {showApply && (
        <Tooltip title={<PendingChangeList />} arrow enterTouchDelay={0} leaveTouchDelay={4000}>
          <Button
            size="small"
            variant="contained"
            color="warning"
            onClick={handleApply}
            sx={{
              ml: 1,
              py: 0,
              px: 1,
              minHeight: 18,
              fontSize: '0.65rem',
              lineHeight: 1.2,
              textTransform: 'none',
            }}
          >
            Apply pending changes
          </Button>
        </Tooltip>
      )}
      <Box sx={{ position: 'absolute', right: 4, display: 'flex', gap: 0.5, alignItems: 'center' }}>
        <SupportButton />
        <Tooltip title="Scoreboard" arrow>
          <IconButton component="a" href="/scores" target="_blank" size="small" sx={{ p: 0, color: 'text.secondary' }}>
            <ScoreboardIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="View source on GitHub" arrow>
          <IconButton
            component="a"
            href="https://github.com/TomSawyerLabs/practice-field-management-system"
            target="_blank"
            rel="noopener"
            size="small"
            sx={{ p: 0, color: 'text.secondary' }}
          >
            <GitHubIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
