import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { getServerTime, usePendingCommitState, useRobotWifiScan } from '../hooks/useBackend';
import { fieldWifiNotice } from '../utils/fieldWifiNotice';

/**
 * A strip along the scoreboard's bottom edge when the field's Wi-Fi is
 * about to reconfigure (every robot drops for ~30 s): robots that connected
 * by themselves, counted down live; a change waiting for robots to be
 * disabled; changes held by staff, a match, or the admin. Nothing otherwise.
 */
export function FieldWifiNote() {
  const scan = useRobotWifiScan();
  const pending = usePendingCommitState();
  const [now, setNow] = useState(getServerTime);
  const counting = !!scan?.upcoming;
  useEffect(() => {
    if (!counting) return;
    setNow(getServerTime());
    const timer = setInterval(() => setNow(getServerTime()), 250);
    return () => clearInterval(timer);
  }, [counting]);

  const notice = fieldWifiNotice(scan, pending, counting ? now : getServerTime());
  if (!notice) return null;
  return (
    <Box
      sx={{
        position: 'absolute',
        left: '50%',
        bottom: '2vh',
        transform: 'translateX(-50%)',
        maxWidth: '90vw',
        zIndex: 3,
        pointerEvents: 'none',
        bgcolor: 'rgba(0,0,0,0.78)',
        border: '2px solid #ffb300',
        borderRadius: 2,
        px: '2vw',
        py: '1vh',
        textAlign: 'center',
      }}
    >
      <Typography sx={{ fontSize: '3.2vh', fontWeight: 800, color: '#ffb300', lineHeight: 1.2 }}>
        {notice.text}
      </Typography>
      {notice.details.map(d => (
        <Typography key={d} sx={{ fontSize: '2.2vh', color: '#fff', lineHeight: 1.3 }}>
          {d}
        </Typography>
      ))}
    </Box>
  );
}
