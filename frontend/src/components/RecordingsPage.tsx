import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { MatchRecordingSection } from './MatchRecordingSection';
import { RecordingsInventorySection } from './RecordingsInventorySection';
import { TimelapseSection } from './TimelapseSection';

/**
 * /recordings — everything pFMS films: which streams every match is recorded
 * from, the long-term field timelapse, and what is on the recordings disk.
 *
 * Its own page rather than more of /admin: these sections load dozens of
 * thumbnails and stills, and on plain-HTTP pfms.tsl the browser fetches only
 * six things at a time per host, so sharing a page with the e-stop and match
 * controls made those wait behind the pictures.
 */
export function RecordingsPage() {
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
        <Link href="/admin" underline="hover" variant="body2">
          Field Admin
        </Link>
      </Box>

      <MatchRecordingSection />
      <TimelapseSection />
      <RecordingsInventorySection />
    </Container>
  );
}
