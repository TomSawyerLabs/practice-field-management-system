import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import ErrorBoundary from '../components/ErrorBoundary';
import { ScoreboardPage } from '../components/ScoreboardPage';
import { MatchSummaryPage } from '../components/MatchSummaryPage';

// `/scores?match=<token>` is the post-match summary a team scanned off the TV;
// it shares this bundle because the reverse proxy already lets everyone reach /scores.
const summaryToken = new URLSearchParams(window.location.search).get('match');

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
        {summaryToken ? <MatchSummaryPage token={summaryToken} /> : <ScoreboardPage />}
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
