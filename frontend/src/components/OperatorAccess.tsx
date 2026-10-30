import { useEffect, useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { QRCodeSVG } from 'qrcode.react';
import {
  sendOperatorLogin,
  sendOperatorLogout,
  sendOperatorPairStart,
  sendOperatorRevokeDevice,
  sendOperatorSetCode,
  useIsAdmin,
  useOperatorAuth,
  useOperatorDevices,
  useOperatorLocked,
  useOperatorPairing,
} from '../hooks/useBackend';

const MIN_CODE_LENGTH = 8;

/**
 * The part of an operator page that needs a login. Locked, it stays visible
 * but can't be used. Never put a stop inside one, and never swap this for
 * something that replaces the page: stops work with no login (see
 * src/wsAccess.ts), and that's no use if they aren't on screen. The server
 * refuses these actions whatever this shows.
 */
export function OperatorOnly({ children }: { children: ReactNode }) {
  const locked = useOperatorLocked();
  // `inert` isn't in React 18's types, but it passes through to the DOM.
  return (
    <Box {...(locked ? { inert: '' } : {})} sx={locked ? { opacity: 0.55 } : undefined}>
      {children}
    </Box>
  );
}

/** A one-time QR code that logs another device in. Inline, not a dialog: on
 *  /match a dialog would cover the E-STOP. */
function AddDevicePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const pairing = useOperatorPairing();
  const [name, setName] = useState('');
  const [asked, setAsked] = useState(false);

  // Don't show a code from an earlier press: it may be spent.
  const [before] = useState(pairing);
  const shown = asked && pairing !== before ? pairing : null;
  const url = shown ? `${window.location.origin}${path}#pair=${shown.secret}` : '';

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(onClose, shown.expiresAt - Date.now());
    return () => clearTimeout(t);
  }, [shown?.secret]);

  return (
    <Box sx={{ mt: 1.5, textAlign: 'center' }}>
      {shown ? (
        <>
          <Box sx={{ display: 'inline-block', p: 2, bgcolor: '#fff', borderRadius: 2, lineHeight: 0 }}>
            <QRCodeSVG value={url} size={200} marginSize={0} />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Scan this on the new device. It works once, for 5 minutes.
          </Typography>
        </>
      ) : (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label="Name (optional)"
            placeholder="e.g. Head ref's phone"
            value={name}
            onChange={e => setName(e.target.value)}
            sx={{ flex: 1, minWidth: 180 }}
          />
          <Button
            variant="contained"
            size="small"
            onClick={() => {
              setAsked(true);
              sendOperatorPairStart(name);
            }}
          >
            Show QR code
          </Button>
        </Box>
      )}
      <Button size="small" sx={{ mt: 1 }} onClick={onClose}>
        Done
      </Button>
    </Box>
  );
}

/**
 * The login on an operator page: asks for the code while locked, and once
 * logged in says who this device is and offers to add another. Nothing at all
 * on a field with no operator logins.
 */
export function OperatorBar() {
  const auth = useOperatorAuth();
  const isAdmin = useIsAdmin();
  const locked = useOperatorLocked();
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!locked) setCode('');
  }, [locked]);

  if (!auth?.required) return null;

  if (locked) {
    const unlock = () => code && sendOperatorLogin(code);
    return (
      <Alert severity="info" sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }}>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Enter the operator code to run the field, or scan a QR code from a logged-in device. Stop buttons work without
          logging in.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <TextField
            size="small"
            type="password"
            label="Operator code"
            autoComplete="current-password"
            value={code}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && unlock()}
            inputProps={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
            sx={{ flex: 1 }}
          />
          <Button variant="contained" onClick={unlock} disabled={!code}>
            Unlock
          </Button>
        </Box>
        {auth.error && (
          <Typography variant="body2" color="error" sx={{ mt: 1 }}>
            {auth.error}
          </Typography>
        )}
      </Alert>
    );
  }

  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Typography variant="caption" color="text.secondary">
          {auth.device ? `Operator: ${auth.device.name}` : isAdmin ? 'Operator: admin login' : ''}
        </Typography>
        <Button size="small" onClick={() => setAdding(a => !a)}>
          Add a device
        </Button>
        {auth.device && (
          <Button size="small" color="inherit" onClick={sendOperatorLogout}>
            Log out
          </Button>
        )}
      </Box>
      {adding && (
        <AddDevicePanel
          path={`${window.location.pathname}${window.location.search}`}
          onClose={() => setAdding(false)}
        />
      )}
    </Box>
  );
}

/** Admin → Access: the operator code, and every device that can run the field. */
export function OperatorAccessSection() {
  const state = useOperatorDevices();
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);

  const devices = state?.devices ?? [];
  const save = () => {
    if (code.length < MIN_CODE_LENGTH) return;
    sendOperatorSetCode(code);
    setCode('');
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h5" sx={{ mb: 1 }}>
          Operator Access
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Who can run the field from /match, /staff, /csa and /test.{' '}
          {state?.hasCode
            ? 'A device needs the operator code, or a QR code from a logged-in device.'
            : 'Right now anyone on the network can. Set a code to lock these pages.'}{' '}
          Stop buttons always work without logging in, for everyone.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, my: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            type="password"
            autoComplete="new-password"
            label={state?.hasCode ? 'New operator code' : 'Operator code'}
            helperText={`At least ${MIN_CODE_LENGTH} characters. Changing it logs out devices that used the old one.`}
            value={code}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            sx={{ flex: 1, minWidth: 220 }}
          />
          <Button variant="contained" onClick={save} disabled={code.length < MIN_CODE_LENGTH}>
            {state?.hasCode ? 'Change code' : 'Set code'}
          </Button>
          {state?.hasCode && (
            <>
              <Button color="warning" onClick={() => sendOperatorSetCode(null)}>
                Remove code and logins
              </Button>
              <Button onClick={() => setAdding(a => !a)}>Add a device</Button>
            </>
          )}
        </Box>
        {adding && <AddDevicePanel path="/match" onClose={() => setAdding(false)} />}

        {devices.length > 0 && (
          <>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Device</TableCell>
                  <TableCell>Added by</TableCell>
                  <TableCell>Last seen</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {devices.map(d => (
                  <TableRow key={d.id}>
                    <TableCell>{d.name}</TableCell>
                    <TableCell>{d.via === 'code' ? 'Operator code' : `QR from ${d.pairedBy}`}</TableCell>
                    <TableCell>{new Date(d.lastSeenAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" color="error" onClick={() => sendOperatorRevokeDevice(d.id)}>
                        Log out
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button size="small" color="error" sx={{ mt: 1 }} onClick={() => sendOperatorRevokeDevice()}>
              Log out every device
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
