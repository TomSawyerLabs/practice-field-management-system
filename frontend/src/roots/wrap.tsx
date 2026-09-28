import { StrictMode } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider, Grid, Box } from '@mui/material';
import Backdrop from '@mui/material/Backdrop';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import { useServerResponse, useVersionMismatch } from '../hooks/useBackend.js';
import { ESTIMATED_RECONFIGURATION_SECONDS, useReconfigProgress } from '../hooks/useReconfigProgress';
import { StatusBar } from '../components/StatusBar';
import { SupportWidgetProvider } from '../components/SupportChatWidget';

export function WrapAll({
  children,
  showReconfigOverlay = true,
}: {
  children: React.ReactNode;
  /** Whether to show the full-screen reconfiguration backdrop. Default true.
   *  Set to false on pages (e.g. team selection, /csa) that should remain
   *  interactive while the radio is reconfiguring. */
  showReconfigOverlay?: boolean;
}) {
  const versionMismatch = useVersionMismatch();
  const { isConfiguring, elapsedSec } = useReconfigProgress();

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

                {elapsedSec !== null && (
                  <>
                    <Typography
                      variant="h1"
                      sx={{ fontSize: '8rem', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}
                    >
                      {Math.max(0, Math.ceil(ESTIMATED_RECONFIGURATION_SECONDS - elapsedSec))}
                    </Typography>
                    <Typography variant="h6" sx={{ mb: 3, minHeight: '2em' }}>
                      {elapsedSec < ESTIMATED_RECONFIGURATION_SECONDS
                        ? 'seconds remaining'
                        : 'If this takes longer than 30 seconds, please report an issue'}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={Math.min(100, (elapsedSec / ESTIMATED_RECONFIGURATION_SECONDS) * 100)}
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
