import { teamLabelAmong } from '../../../src/utils';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import { QRCodeSVG } from 'qrcode.react';
import { StationName } from '../../../src/types';
import { useMatchState, useRoutePreferenceState } from '../hooks/useBackend';

/**
 * The station whose Driver Station traffic comes from this device's IP.
 * `undefined` while the answer is unknown (state not yet received), `null`
 * once this device is confirmed not to be a DS. Live: a DS starting up (or
 * going stale) on this machine flips the answer via the match-state stream.
 */
export function useDsClientStation(): StationName | null | undefined {
  const matchState = useMatchState();
  const yourIp = useRoutePreferenceState()?.yourIp;
  const connected = matchState?.connectedStations;
  if (!yourIp || !connected) return undefined;
  for (const [station, conn] of Object.entries(connected)) {
    if (conn?.ip === yourIp) return station as StationName;
  }
  return null;
}

/**
 * Full-page block shown when a Driver Station laptop opens an operator page
 * (match control, field staff). A DS must not double as the match operator —
 * the QR code hands the page off to a phone or spare device in one scan.
 */
export function DsClientBlock({ station, roleNoun }: { station: StationName; roleNoun: string }) {
  const matchState = useMatchState();
  const own = matchState?.stationStates?.[station];
  const team = own && teamLabelAmong(own, Object.values(matchState?.stationStates ?? {}));
  const url = window.location.href;

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 4 }}>
          <Typography variant="h4" sx={{ mb: 1, fontWeight: 700 }}>
            This is a Driver Station
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 1 }}>
            This device is driving {team ? `team ${team}` : station.replace('slot', 'station ')} — you can't be a Driver
            Station and {roleNoun} at the same time.
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Open this page on a different device — scan the code:
          </Typography>
          <Box sx={{ display: 'inline-block', p: 2, bgcolor: '#fff', borderRadius: 2, lineHeight: 0 }}>
            <QRCodeSVG value={url} size={200} marginSize={0} />
          </Box>
          <Typography color="text.secondary" sx={{ mt: 2, wordBreak: 'break-all', fontSize: '0.9rem' }}>
            {url}
          </Typography>
        </CardContent>
      </Card>
    </Container>
  );
}
