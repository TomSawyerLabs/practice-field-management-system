import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import ErrorBoundary from '../components/ErrorBoundary';
import { ScoreboardPage } from '../components/ScoreboardPage';
import { MatchSummaryPage } from '../components/MatchSummaryPage';
import { PracticeDayPage } from '../components/PracticeDayPage';

// `/matches/<token>` is the post-match summary a team scanned off the TV. It
// shares this bundle (the server maps that path to scores.html); the older
// `/scores?match=<token>` form still works — but only over a link that is
// already https: the reverse proxy's http→https redirect drops query strings,
// so an http `?match=` link silently lands on the plain scoreboard. That is
// why the QR code uses the path form.
const summaryToken =
  /^\/matches\/([^/?#]+)/.exec(window.location.pathname)?.[1] ??
  new URLSearchParams(window.location.search).get('match');
// `/practice/<token>` is a team's practice day: every match and practice run
// they were part of, with videos and metadata, from the link on their station
// page or the one posted to their mentors on Slack.
const practiceToken = /^\/practice\/([^/?#]+)/.exec(window.location.pathname)?.[1];

const theme = createTheme({
  colorSchemes: { dark: true },
  palette: { mode: 'dark' },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme} defaultMode="dark">
        <CssBaseline />
        {/* Match audio is mounted inside ScoreboardPage so per-display mute can gate it */}
        {practiceToken ? (
          <PracticeDayPage token={practiceToken} />
        ) : summaryToken ? (
          <MatchSummaryPage token={summaryToken} />
        ) : (
          <ScoreboardPage />
        )}
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
