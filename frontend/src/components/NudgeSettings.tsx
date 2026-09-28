import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import {
  useTeamPrefs,
  sendTeamPrefsSet,
  sendPushSubscribe,
  sendPushUnsubscribe,
  sendPushTest,
} from '../hooks/useBackend';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

/** A short name for this device, for the team's list of subscribed devices. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : '';
  return `${os}${browser ? ` · ${browser}` : ''}`;
}

type InstallPromptEvent = Event & { prompt: () => Promise<void> };

/**
 * The team's say in how it is told about the queue: the page banner (always),
 * a Slack DM, and push to this device — plus installing the page as an app,
 * which is what lets pushes arrive with the tab closed.
 */
export function NudgeSettings({ teamNumber }: { teamNumber: number }) {
  const prefs = useTeamPrefs(teamNumber);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  const pushSupported =
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const standalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as { standalone?: boolean }).standalone === true);
  const isIOS = /iPhone|iPad/.test(navigator.userAgent);

  useEffect(() => {
    if (!pushSupported) return;
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => setThisDevice(sub?.endpoint ?? null))
      .catch(() => setThisDevice(null));
  }, [pushSupported]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!prefs) return null;
  const subscribedHere = !!thisDevice && prefs.pushDevices.some(d => d.endpoint === thisDevice);
  const otherDevices = prefs.pushDevices.filter(d => d.endpoint !== thisDevice).length;

  const enablePush = async () => {
    if (!prefs.vapidPublicKey) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError('Notifications were not allowed. Allow them in the browser settings for this site to use push.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(prefs.vapidPublicKey),
        }));
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth)
        throw new Error('The browser gave an incomplete subscription');
      sendPushSubscribe(
        teamNumber,
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

  const disablePush = async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        sendPushUnsubscribe(teamNumber, sub.endpoint);
        await sub.unsubscribe();
      }
      setThisDevice(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h6">Match nudges</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
          How to tell you when you&apos;re next up, on deck, or a match is waiting on you.
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <FormControlLabel control={<Checkbox checked disabled />} label="A banner at the top of this page" />
          <FormControlLabel
            control={
              <Checkbox
                checked={prefs.nudge.slack}
                disabled={!prefs.slackAvailable}
                onChange={e => sendTeamPrefsSet(teamNumber, { slack: e.target.checked })}
              />
            }
            label={
              prefs.slackAvailable
                ? `A Slack DM to members whose display name has ${teamNumber} in it`
                : 'A Slack DM (field staff have not connected Slack)'
            }
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={subscribedHere}
                disabled={!pushSupported || !prefs.vapidPublicKey || busy}
                onChange={e => (e.target.checked ? enablePush() : disablePush())}
              />
            }
            label={
              !pushSupported
                ? 'A notification on this device (needs the site over HTTPS and a browser with notifications)'
                : !prefs.vapidPublicKey
                  ? 'A notification on this device (push is not set up on this field)'
                  : `A notification on this device${otherDevices > 0 ? ` (${otherDevices} other device${otherDevices === 1 ? '' : 's'} subscribed)` : ''}`
            }
          />
        </Box>
        {error && (
          <Typography variant="body2" sx={{ color: 'error.main', mt: 0.5 }}>
            {error}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
          {prefs.pushDevices.length > 0 && (
            <Button size="small" variant="outlined" onClick={() => sendPushTest(teamNumber)}>
              Send a test notification
            </Button>
          )}
          {!standalone && installPrompt && (
            <Button size="small" variant="outlined" onClick={() => installPrompt.prompt()}>
              Install as an app
            </Button>
          )}
        </Box>
        {!standalone && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
            {isIOS
              ? 'On an iPhone, notifications only arrive once this page is on your Home Screen: Share → Add to Home Screen, then turn them on from the app.'
              : 'Installed as an app, notifications arrive even with the tab closed.'}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
