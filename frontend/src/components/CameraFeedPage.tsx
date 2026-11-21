import Box from '@mui/material/Box';
import GlobalStyles from '@mui/material/GlobalStyles';
import Typography from '@mui/material/Typography';

import { useMainDisplayCamera } from '../hooks/useBackend';
import { CameraPicture } from './CameraPicture';

/** The feed's address, for the copy button on the Network page. */
export function cameraFeedUrl(origin = window.location.origin): string {
  return `${origin}/camera-feed`;
}

/**
 * `/camera-feed`: the camera staff put on the main display, alone and
 * filling the page, for a livestream (an OBS Browser Source, say). Transparent
 * while nothing is up, so it can sit over other sources; `?label=0` leaves out
 * the team number. A path rather than a `/scores` query, because the
 * http→https redirect drops query strings. Live or stills follows the robot's
 * radio, like the TVs.
 */
export function CameraFeedPage() {
  const camera = useMainDisplayCamera();
  const label = new URLSearchParams(window.location.search).get('label') !== '0';
  return (
    <>
      <GlobalStyles styles={{ 'html, body': { background: 'transparent !important' } }} />
      {camera && (
        <Box sx={{ position: 'fixed', inset: 0, bgcolor: '#000' }}>
          <CameraPicture
            key={`${camera.station}-${camera.ip}-${camera.port}`}
            station={camera.station}
            ip={camera.ip}
            port={camera.port}
            large
            quiet
          />
          {label && (
            <Typography
              sx={{
                position: 'absolute',
                left: '2vw',
                bottom: '2vh',
                px: '1.2vw',
                py: '0.4vh',
                fontSize: '4vh',
                fontWeight: 800,
                color: '#fff',
                bgcolor: 'rgba(0,0,0,0.6)',
                borderRadius: 1,
              }}
            >
              Team {camera.team}
            </Typography>
          )}
        </Box>
      )}
    </>
  );
}
