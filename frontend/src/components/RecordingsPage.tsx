import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useIsAdmin } from '../hooks/useBackend';
import { RecordingsInventorySection } from './RecordingsInventorySection';
import { TimelapseArchiveSection } from './TimelapseSection';

/**
 * /recordings — everything pFMS has filmed, for anyone to watch: every match
 * and practice run still on disk, and the field timelapse archive.
 *
 * No login: watching is open. Nothing here changes a setting — the streams,
 * retention and timelapse configuration live in Admin → Video. A browser
 * logged in as admin also gets the delete and build-a-film controls; the
 * server checks those again whoever sends them.
 *
 * Its own page rather than part of /admin: these sections load dozens of
 * thumbnails and stills, and on plain-HTTP pfms.tsl the browser fetches only
 * six things at a time per host.
 */
export function RecordingsPage() {
  const isAdmin = useIsAdmin();
  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h3" gutterBottom>
          Recordings
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Link href="/timelapse" underline="hover" variant="body2">
          Timelapse viewer
        </Link>
        {isAdmin && (
          <Link href="/admin#video" underline="hover" variant="body2">
            Video settings
          </Link>
        )}
      </Box>

      <RecordingsInventorySection isAdmin={isAdmin} />
      <TimelapseArchiveSection isAdmin={isAdmin} />
    </Container>
  );
}
