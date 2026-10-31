import { teamLabelAmong } from '../../../src/utils';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import { QRCodeSVG } from 'qrcode.react';
import { StationName } from '../../../src/types';
import { sendDsClientDismiss, useDsClientState, useMatchState } from '../hooks/useBackend';
import { FieldEStopControl } from './FieldEStop';

/**
 * The station this device appears to be the Driver Station of. `undefined`
 * while the answer is unknown (state not yet received), `null` once this
 * device is confirmed not to be a DS. The server decides, on the device's
 * address or hostname, and refuses the same actions itself: see
 * src/wsAccess.ts.
 */
export function useDsClientStation(): StationName | null | undefined {
  return useDsClientState()?.station;
}

/**
 * Full-page block shown when a Driver Station laptop opens an operator page
 * (match control, field staff). A DS must not double as the match operator —
 * the QR code hands the page off to a phone or spare device in one scan. The
 * E-STOP stays: the match may be false, and a stop works from any device.
 */
export function DsClientBlock({ station, roleNoun }: { station: StationName; roleNoun: string }) {
  const matchState = useMatchState();
  const unsure = useDsClientState()?.by === 'hostname';
  const own = matchState?.stationStates?.[station];
  const team = own && teamLabelAmong(own, Object.values(matchState?.stationStates ?? {}));
  const url = window.location.href;

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <FieldEStopControl />
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 4 }}>
          <Typography variant="h4" sx={{ mb: 1, fontWeight: 700 }}>
            {unsure ? 'This looks like a Driver Station' : 'This is a Driver Station'}
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 1 }}>
            {unsure ? 'This device has the same name as the one' : 'This device is'} driving{' '}
            {team ? `team ${team}` : station.replace('slot', 'station ')} — you can't be a Driver Station and {roleNoun}{' '}
            at the same time.
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
          {unsure && (
            <Button sx={{ mt: 2 }} onClick={sendDsClientDismiss}>
              This isn't a Driver Station
            </Button>
          )}
        </CardContent>
      </Card>
    </Container>
  );
}

/**
 * For the staff pages that are still useful to look at on a Driver Station
 * (`/csa`, `/test`, `/overview`): a warning instead of a block, because the
 * server refuses their actions from this device. Stops aren't refused.
 */
export function DsClientNotice() {
  const ds = useDsClientState();
  if (!ds?.station) return null;
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2 }}
      action={
        ds.by === 'hostname' ? (
          <Button color="inherit" size="small" onClick={sendDsClientDismiss}>
            This isn't a Driver Station
          </Button>
        ) : undefined
      }
    >
      {ds.by === 'hostname' ? 'This device looks like a Driver Station' : 'This device is a Driver Station'}, so staff
      actions on this page are turned off, apart from the E-Stop. Use a phone or another device for those.
    </Alert>
  );
}
