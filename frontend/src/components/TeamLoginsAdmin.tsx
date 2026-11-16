import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  sendAdminPushSubscribe,
  sendAdminPushUnsubscribe,
  sendTeamAuthReset,
  sendTeamAuthRevokeDevice,
  sendTeamAuthSetLock,
  sendUpdateSetupSettings,
  useSetupConfig,
  useTeamAuthAdmin,
} from '../hooks/useBackend';
import { deviceLabel, urlBase64ToUint8Array } from './NudgeSettings';
import { seenText } from './TeamLogin';

/**
 * /admin → Access: teams that set a password, their logged-in devices, and
 * the network lock. Admin resets a forgotten password here; the team then
 * sets a new one from its page. Also where "Forgot password" alerts go.
 */
export function TeamLoginsSection() {
  const state = useTeamAuthAdmin();
  const setup = useSetupConfig();
  const [confirmReset, setConfirmReset] = useState<number | null>(null);
  const lease = setup?.config.settings.guestLeaseHours ?? 24;
  const [leaseText, setLeaseText] = useState(String(lease));
  useEffect(() => setLeaseText(String(lease)), [lease]);

  if (!state) return null;
  const idleHours = state.idleMs / 3600_000;

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h5" sx={{ mb: 1 }}>
          Team Logins
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A team may set a password on its page (Network tab). Then only its logged-in devices can change its Wi-Fi and
          settings, and it can lock its robots&apos; network to its own laptops. Devices stay logged in for a year after
          their last visit. Reset a forgotten password here, and the team sets a new one.
        </Typography>

        {state.teams.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No team has set a password.
          </Typography>
        )}

        {state.teams.map(t => (
          <Box key={t.team} sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                <a href={`/${t.team}`} target="_blank" rel="noreferrer">
                  Team {t.team}
                </a>
              </Typography>
              {t.lock && <Chip size="small" color="primary" label="Network locked" />}
              <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
                {t.lock && (
                  <Button size="small" onClick={() => sendTeamAuthSetLock(t.team, false)}>
                    Unlock network
                  </Button>
                )}
                {confirmReset === t.team ? (
                  <>
                    <Button
                      size="small"
                      color="error"
                      variant="contained"
                      onClick={() => {
                        sendTeamAuthReset(t.team);
                        setConfirmReset(null);
                      }}
                    >
                      Reset: forget password, devices and lock
                    </Button>
                    <Button size="small" onClick={() => setConfirmReset(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button size="small" color="warning" onClick={() => setConfirmReset(t.team)}>
                    Reset password
                  </Button>
                )}
              </Box>
            </Box>
            {t.devices.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No devices logged in.
              </Typography>
            )}
            {t.devices.map(d => (
              <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1 }}>
                <Typography variant="body2" sx={{ flexGrow: 1 }}>
                  {d.name}
                  <Typography component="span" variant="body2" color="text.secondary">
                    {' · '}
                    {d.address
                      ? `${d.address}${d.addressSeenAt ? `, traffic ${seenText(d.addressSeenAt)}` : ''}`
                      : 'not let through anywhere'}
                    {' · '}visited {seenText(d.lastSeenAt)}
                  </Typography>
                </Typography>
                <Button size="small" onClick={() => sendTeamAuthRevokeDevice(t.team, d.id)}>
                  Log out
                </Button>
              </Box>
            ))}
          </Box>
        ))}

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          Network lock
        </Typography>
        {!state.lockAvailable && (
          <Alert severity="info" sx={{ mb: 1 }}>
            This field doesn&apos;t manage the team VLANs (no trunk interface), so teams can&apos;t lock their networks.
          </Alert>
        )}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label="Guest Wi-Fi DHCP lease"
            value={leaseText}
            onChange={e => setLeaseText(e.target.value)}
            onBlur={() => {
              const hours = Number(leaseText);
              if (hours >= 0.5 && hours <= 720 && hours !== lease) sendUpdateSetupSettings({ guestLeaseHours: hours });
              else setLeaseText(String(lease));
            }}
            InputProps={{ endAdornment: <InputAdornment position="end">hours</InputAdornment> }}
            sx={{ width: 220 }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 240 }}>
            A locked team&apos;s laptop is let through at its current address until{' '}
            {Number.isInteger(idleHours) ? idleHours : idleHours.toFixed(1)} hours (half the lease) pass with no traffic
            from it. A device renews at half its lease, so no other device can get the address sooner. Set this to the
            lease your guest network&apos;s router hands out.
          </Typography>
        </Box>

        <Divider sx={{ my: 2 }} />

        <ForgotPasswordAlerts
          slackConfigured={state.slackConfigured}
          pushDevices={state.pushDevices}
          vapidPublicKey={state.vapidPublicKey}
        />
      </CardContent>
    </Card>
  );
}

function ForgotPasswordAlerts({
  slackConfigured,
  pushDevices,
  vapidPublicKey,
}: {
  slackConfigured: boolean;
  pushDevices: { endpoint: string; label?: string; addedAt: number }[];
  vapidPublicKey?: string;
}) {
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

  useEffect(() => {
    if (!pushSupported) return;
    navigator.serviceWorker
      .getRegistration('/')
      .then(reg => reg?.pushManager.getSubscription())
      .then(sub => setThisDevice(sub?.endpoint ?? null))
      .catch(() => setThisDevice(null));
  }, [pushSupported]);

  const subscribed = !!thisDevice && pushDevices.some(d => d.endpoint === thisDevice);

  const enable = async () => {
    if (!vapidPublicKey) return;
    setBusy(true);
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        setError('Notifications were not allowed. Allow them for this site in the browser settings.');
        return;
      }
      await navigator.serviceWorker.register('/sw.js');
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
        }));
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('Incomplete subscription');
      sendAdminPushSubscribe(
        { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
        deviceLabel(),
      );
      setThisDevice(json.endpoint);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Typography variant="subtitle1" sx={{ mb: 0.5 }}>
        &quot;Forgot password&quot; alerts
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        When a team presses Forgot password, the field tells admins in the Slack support channel
        {slackConfigured ? '' : ' (not set up)'} and with a push notification to each device below.
        {!slackConfigured && pushDevices.length === 0 && ' Right now nobody would hear: the team is told to find you.'}
      </Typography>
      {pushDevices.map(d => (
        <Box key={d.endpoint} sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1 }}>
          <Typography variant="body2" sx={{ flexGrow: 1 }}>
            {d.label ?? 'Device'}
            {d.endpoint === thisDevice && ' (this device)'}
          </Typography>
          <Button size="small" onClick={() => sendAdminPushUnsubscribe(d.endpoint)}>
            Remove
          </Button>
        </Box>
      ))}
      {pushSupported && vapidPublicKey && !subscribed && (
        <Button size="small" variant="outlined" onClick={enable} disabled={busy} sx={{ mt: 1 }}>
          Notify this device
        </Button>
      )}
      {!pushSupported && (
        <Typography variant="body2" color="text.secondary">
          Push needs the field&apos;s https address to add this device.
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
