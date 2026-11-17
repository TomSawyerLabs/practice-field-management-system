import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { RobotWifiScanState } from '../../../src/types';
import { clockTime, robotWifiUnderWay, utcTime } from '../utils/robotWifiActivity';

const SHOWN = 8;
const TONE_COLOR = { info: 'text.primary', good: 'success.main', bad: 'warning.main' } as const;

/**
 * The CSA page's view of the robot Wi-Fi scan and auto-connect: what is
 * under way now (checks, searches, retries, a reconfiguration coming up),
 * and what happened lately, newest first — so staff can see why a robot
 * did or didn't connect by itself.
 */
export function RobotWifiActivityPanel({ scan, now }: { scan: RobotWifiScanState | null; now: number }) {
  const [all, setAll] = useState(false);
  if (!scan || scan.status === 'off') return null;
  const underWay = robotWifiUnderWay(scan, now);
  const activity = scan.activity ?? [];
  const shown = all ? activity : activity.slice(0, SHOWN);
  return (
    <Paper variant="outlined" sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        Robot Wi-Fi: connecting by themselves
      </Typography>
      {underWay.map(line => (
        <Typography key={line} variant="body2" sx={{ color: 'info.main' }}>
          {line}
        </Typography>
      ))}
      {activity.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.disabled' }}>
          Nothing heard yet.
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {shown.map((e, i) => (
            <Box component="li" key={`${e.at}-${i}`} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
              <Tooltip title={utcTime(e.at)} arrow enterTouchDelay={0}>
                <Typography
                  variant="caption"
                  sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                >
                  {clockTime(e.at)}
                </Typography>
              </Tooltip>
              <Typography variant="body2" sx={{ color: TONE_COLOR[e.tone], minWidth: 0 }}>
                <b>{e.robot}</b> {e.text}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
      {activity.length > SHOWN && (
        <Button size="small" onClick={() => setAll(v => !v)} sx={{ alignSelf: 'flex-start', textTransform: 'none' }}>
          {all ? 'Show fewer' : `Show all ${activity.length}`}
        </Button>
      )}
    </Paper>
  );
}
