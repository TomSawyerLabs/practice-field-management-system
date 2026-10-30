import { useState, useEffect, useCallback } from 'react';
import { useSecondTick } from '../hooks/useSecondTick';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import CableIcon from '@mui/icons-material/Cable';
import PowerIcon from '@mui/icons-material/Power';
import WifiIcon from '@mui/icons-material/Wifi';
import RouterIcon from '@mui/icons-material/Router';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CellTowerIcon from '@mui/icons-material/CellTower';
import TimerIcon from '@mui/icons-material/Timer';
import type { PortBridgeState } from '../../../src/types';

const TIMER_SECONDS = 30;

interface WaitingForRobotProps {
  stationSsid: string;
  lastLinkedTimestamp: number | undefined;
  portBridgeState: PortBridgeState | null;
  onStartTestPortMode: (portVlanId: number) => void;
}

export function WaitingForRobot({
  stationSsid,
  lastLinkedTimestamp,
  portBridgeState,
  onStartTestPortMode,
}: WaitingForRobotProps) {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(TIMER_SECONDS);
  const timerExpired = deadline !== null && remaining <= 0;
  const timerRunning = deadline !== null && remaining > 0;
  const wasLinkedBefore = lastLinkedTimestamp !== undefined;
  useSecondTick(wasLinkedBefore); // for the "N min ago" below

  const startTimer = useCallback(() => {
    setDeadline(Date.now() + TIMER_SECONDS * 1000);
    setRemaining(TIMER_SECONDS);
  }, []);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);

  // Available ports for test port mode (exclude already-bridged ports)
  const availablePorts = portBridgeState?.ports.filter(p => !portBridgeState.activeBridges[p.vlanId]);
  const hasPortBridge = !!availablePorts && availablePorts.length > 0;

  if (wasLinkedBefore) {
    // Previously linked but disconnected
    const agoMs = Date.now() - lastLinkedTimestamp;
    const agoText =
      agoMs < 60_000
        ? 'moments ago'
        : agoMs < 3_600_000
          ? `${Math.floor(agoMs / 60_000)} min ago`
          : `${Math.floor(agoMs / 3_600_000)}h ago`;

    return (
      <Box sx={{ px: 1, py: 1 }}>
        <Typography variant="body2" color="warning.main" sx={{ mb: 1 }}>
          Robot disconnected ({agoText}). Waiting for reconnection...
        </Typography>
        {hasPortBridge && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Not reconnecting?
            </Typography>
            <PortSelector ports={availablePorts} onSelect={onStartTestPortMode} />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ px: 1, py: 1 }}>
      {!timerExpired && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            Power on your robot and wait for it to connect to the field.
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            The robot radio should connect within 30 seconds of boot.
          </Typography>

          {timerRunning ? (
            <Box sx={{ mb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <TimerIcon fontSize="small" color="info" />
                <Typography variant="body2" color="info.main">
                  Connecting... {remaining}s remaining
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={((TIMER_SECONDS - remaining) / TIMER_SECONDS) * 100}
                sx={{ borderRadius: 1 }}
              />
            </Box>
          ) : (
            <Button variant="outlined" size="small" startIcon={<TimerIcon />} onClick={startTimer} sx={{ mb: 1 }}>
              Just powered on? Start timer
            </Button>
          )}
        </>
      )}

      {timerExpired && (
        <>
          <Typography variant="body2" color="warning.main" sx={{ mb: 1, fontWeight: 500 }}>
            Robot hasn't connected yet.
          </Typography>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Troubleshooting checklist:
          </Typography>
          <List dense disablePadding sx={{ mb: 1 }}>
            <TroubleshootItem icon={<PowerIcon fontSize="small" />} text="Is the robot powered on?" />
            <TroubleshootItem
              icon={<RouterIcon fontSize="small" />}
              text="Is the robot radio's power light solid (not blinking)?"
            />
            <TroubleshootItem
              icon={<WifiIcon fontSize="small" />}
              text={`Was the radio configured for this team? (SSID: ${stationSsid})`}
            />
            <TroubleshootItem
              icon={<HelpOutlineIcon fontSize="small" />}
              text="Has the radio been reconfigured at a recent competition?"
            />
            <TroubleshootItem
              icon={<CellTowerIcon fontSize="small" />}
              text="Is another field nearby using the same team number?"
            />
          </List>

          {hasPortBridge && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                Still stuck? Plug the robot into a field port:
              </Typography>
              <PortSelector ports={availablePorts} onSelect={onStartTestPortMode} />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

function TroubleshootItem({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <ListItem disableGutters sx={{ py: 0, minHeight: 28 }}>
      <ListItemIcon sx={{ minWidth: 28, color: 'text.secondary' }}>{icon}</ListItemIcon>
      <ListItemText primary={text} primaryTypographyProps={{ variant: 'caption' }} />
    </ListItem>
  );
}

function PortSelector({
  ports,
  onSelect,
}: {
  ports: { vlanId: number; name: string }[];
  onSelect: (vlanId: number) => void;
}) {
  if (ports.length === 1) {
    return (
      <Button
        variant="contained"
        size="small"
        startIcon={<CableIcon />}
        onClick={() => onSelect(ports[0].vlanId)}
        color="warning"
      >
        Test with cable ({ports[0].name})
      </Button>
    );
  }

  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      {ports.map(p => (
        <Button
          key={p.vlanId}
          variant="outlined"
          size="small"
          startIcon={<CableIcon />}
          onClick={() => onSelect(p.vlanId)}
          color="warning"
        >
          {p.name}
        </Button>
      ))}
    </Box>
  );
}
