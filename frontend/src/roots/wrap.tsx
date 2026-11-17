import { StrictMode, useEffect, useState } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider, Box } from '@mui/material';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import { useServerResponse, useVersionMismatch } from '../hooks/useBackend.js';
import { useReconfigProgress } from '../hooks/useReconfigProgress';
import { StatusBar } from '../components/StatusBar';
import { ReconfigureBanner } from '../components/ReconfigureNotice';
import { SupportWidgetProvider } from '../components/SupportChatWidget';

// Enable dark mode for the entire app (system default). Built once: a new
// theme object re-renders everything that reads the theme.
const theme = createTheme({ colorSchemes: { dark: true } });

export function WrapAll({
  children,
  reconfigBanner = false,
}: {
  children: React.ReactNode;
  /** While the radio reconfigures, open with a large banner saying what
   *  changes (the team pages), which hides into the status bar. Without it
   *  only the status bar shows it. Neither blocks the page. */
  reconfigBanner?: boolean;
}) {
  const versionMismatch = useVersionMismatch();
  const reconfig = useReconfigProgress();
  // Hidden for this reconfigure only: the next one opens the banner again.
  const [bannerHidden, setBannerHidden] = useState(false);
  useEffect(() => {
    if (!reconfig.isConfiguring) setBannerHidden(false);
  }, [reconfig.isConfiguring]);
  const showBanner = reconfigBanner && reconfig.isConfiguring && !bannerHidden;

  const serverResponse = useServerResponse();

  return (
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <SupportWidgetProvider>
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
              <StatusBar
                reconfigure={
                  reconfig.isConfiguring && !showBanner
                    ? { progress: reconfig, onShow: reconfigBanner ? () => setBannerHidden(false) : undefined }
                    : undefined
                }
              />
              {showBanner && <ReconfigureBanner progress={reconfig} onHide={() => setBannerHidden(true)} />}
              <Box sx={{ flex: 1, overflowY: 'auto' }}>{children}</Box>
            </Box>
          </SupportWidgetProvider>
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
