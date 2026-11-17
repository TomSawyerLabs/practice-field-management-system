import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import type { RobotNtReading, StationName } from '../../../src/types';
import { staffAuthHeaders } from '../hooks/useBackend';
import { HostDisplay } from './HostDisplay';

const POLL_MS = 10_000;
const MATCH_TYPES = ['No match', 'Practice', 'Qualification', 'Elimination'];
/** WPILib's FMSControlData bit for "FMS attached". */
const FMS_ATTACHED = 0x10;

/**
 * What the station's robot's NetworkTables server says (src/robotNt.ts):
 * robot code running, the match info the robot's code received, and which
 * dashboards are connected. pFMS reads it only while this is on screen.
 */
export function RobotNtLine({ station, team }: { station: StationName; team: number }) {
  const [reading, setReading] = useState<RobotNtReading | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch(`/api/robot-nt?station=${station}`, {
            cache: 'no-store',
            headers: staffAuthHeaders(),
          });
          // Off site, or no robot: show nothing
          if (!stopped) setReading(res.ok ? ((await res.json()) as RobotNtReading) : null);
        } catch {
          if (!stopped) setReading(null);
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [station, team]);

  if (!reading || reading.team !== team) return null;
  const fms = reading.fms;
  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="body2">
        Robot code:{' '}
        <Box
          component="strong"
          sx={{
            color:
              reading.code === 'running'
                ? 'success.main'
                : reading.code === 'not running'
                  ? 'warning.main'
                  : 'text.secondary',
          }}
        >
          {reading.code === 'running'
            ? 'running'
            : reading.code === 'not running'
              ? 'not running'
              : "can't reach the roboRIO"}
        </Box>
        {reading.code !== 'running' && reading.error && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
            {reading.error}
          </Typography>
        )}
      </Typography>
      {fms && (
        <Typography variant="body2" color="text.secondary">
          Robot sees: {MATCH_TYPES[fms.matchType ?? 0] ?? `Match type ${fms.matchType}`}
          {fms.matchNumber ? ` ${fms.matchNumber}` : ''}
          {fms.stationNumber !== undefined && fms.isRedAlliance !== undefined && (
            <>
              ,{' '}
              <Box component="span" sx={{ color: fms.isRedAlliance ? 'error.main' : 'info.main', fontWeight: 'bold' }}>
                {fms.isRedAlliance ? 'Red' : 'Blue'} {fms.stationNumber}
              </Box>
            </>
          )}
          {fms.controlData !== undefined && (fms.controlData & FMS_ATTACHED ? ', FMS attached' : ', no FMS')}
        </Typography>
      )}
      {reading.clients && (
        <Typography variant="body2" color="text.secondary">
          Dashboards:{' '}
          {reading.clients.length === 0
            ? 'none'
            : reading.clients.map((c, i) => {
                const ip = c.address.replace(/:\d+$/, '');
                return (
                  <span key={`${c.name}-${c.address}`}>
                    {i > 0 && ', '}
                    {c.name.replace(/@\d+$/, '')} (<HostDisplay ip={ip} />)
                  </span>
                );
              })}
        </Typography>
      )}
    </Box>
  );
}
