import { StrictMode, useEffect, useRef, useState } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider, Grid, Box } from '@mui/material';
import Backdrop from '@mui/material/Backdrop';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import {
  useHistory,
  useLatest,
  serverToBrowserTime,
  useServerResponse,
  useVersionMismatch,
} from '../hooks/useBackend.js';
import { StatusBar } from '../components/StatusBar';
import { SupportWidgetProvider } from '../components/SupportChatWidget';

const EstimatedReconfigurationTime = 40; // seconds

export function WrapAll({
  children,
  showReconfigOverlay = true,
}: {
  children: React.ReactNode;
  /** Whether to show the full-screen reconfiguration backdrop. Default true.
   *  Set to false on pages (e.g. team selection) that should remain interactive
   *  while the radio is reconfiguring. */
  showReconfigOverlay?: boolean;
}) {
  const latest = useLatest();
  const versionMismatch = useVersionMismatch();
  // .slice() to avoid mutating the state array — .reverse() is in-place and
  // would cause lastActive to oscillate between the first and last ACTIVE
  // entries on alternating renders.
  const hist = useHistory();
  const lastActive =
    hist
      .slice()
      .reverse()
      .find(h => h.radioUpdate?.status === 'ACTIVE')?.timestamp || null;

  // When the page is refreshed mid-reconfiguration, the server's history window
  // (default 60 s) may have already pruned all ACTIVE entries.  Fall back to the
  // first CONFIGURING entry so the countdown still has an anchor point.
  const firstConfiguring = hist.find(h => h.radioUpdate?.status === 'CONFIGURING')?.timestamp || null;
  const reconfigStart = lastActive ?? firstConfiguring;

  const { status } = latest?.radioUpdate || {};
  const isConfiguring = status === 'CONFIGURING';
  const isRadioConnected = latest?.radioUpdate !== undefined;

  // Track elapsed seconds since configuration started, using a stable browser-local
  // anchor so the countdown doesn't jitter as the server time offset shifts.
  // The ref ensures we compute startBrowserTime exactly once per reconfiguration
  // cycle — surviving brief status flickers (radio momentarily reporting ACTIVE
  // mid-reconfig) and timeOffset drift between effect re-runs.
  const [elapsedSec, setElapsedSec] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  // Only clear the anchor when the radio is definitively done configuring
  // (connected with a non-CONFIGURING status), not on transient flickers.
  const isDefinitelyDone = isRadioConnected && !isConfiguring;
  useEffect(() => {
    if (isDefinitelyDone) {
      startTimeRef.current = null;
      setElapsedSec(0);
    }
  }, [isDefinitelyDone]);

  useEffect(() => {
    if (!isConfiguring || !reconfigStart) return;

    // Compute the browser-local anchor only once per reconfiguration cycle
    if (startTimeRef.current === null) {
      startTimeRef.current = serverToBrowserTime(reconfigStart);
    }

    const startBrowserTime = startTimeRef.current;
    const update = () => setElapsedSec((Date.now() - startBrowserTime) / 1000);
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [isConfiguring, reconfigStart]);

  const serverResponse = useServerResponse();

  // Enable dark mode for the entire app (system default)
  const theme = createTheme({ colorSchemes: { dark: true } });

  return (
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <SupportWidgetProvider>
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
              <StatusBar />
              <Box sx={{ flex: 1, overflowY: 'auto' }}>{children}</Box>
            </Box>
          </SupportWidgetProvider>
          {showReconfigOverlay && (
            <Backdrop open={isConfiguring} sx={{ zIndex: 9999 }}>
              <Grid
                container
                direction="column"
                justifyContent="center"
                alignItems="center"
                sx={{ height: '100%', userSelect: 'none' }}
              >
                <Typography variant="h4" sx={{ mb: 2 }}>
                  Reconfiguration in progress...
                </Typography>

                {reconfigStart && (
                  <>
                    <Typography
                      variant="h1"
                      sx={{ fontSize: '8rem', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}
                    >
                      {Math.max(0, Math.ceil(EstimatedReconfigurationTime - elapsedSec))}
                    </Typography>
                    <Typography variant="h6" sx={{ mb: 3, minHeight: '2em' }}>
                      {elapsedSec < EstimatedReconfigurationTime
                        ? 'seconds remaining'
                        : 'If this takes longer than 30 seconds, please report an issue'}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={Math.min(100, (elapsedSec / EstimatedReconfigurationTime) * 100)}
                      sx={{ width: '100%', maxWidth: 500, height: 10, borderRadius: 5 }}
                    />
                  </>
                )}
              </Grid>
            </Backdrop>
          )}
          {versionMismatch && (
            <Alert severity="warning" square sx={{ borderRadius: 0 }}>
              This page is running an old version ({versionMismatch.frontend}); the server is on{' '}
              {versionMismatch.server}. Reloading did not pick up the new one — the deploy likely did not publish the
              frontend. Tell field staff; everything still works.
            </Alert>
          )}
          <Snackbar open={serverResponse !== null} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
            <Alert severity={serverResponse?.severity ?? 'info'} variant="filled" sx={{ width: '100%' }}>
              {serverResponse?.message}
            </Alert>
          </Snackbar>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
