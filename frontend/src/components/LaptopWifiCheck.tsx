import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import DownloadIcon from '@mui/icons-material/Download';

const SCRIPT_URL = '/api/diag/wifi.ps1';

/**
 * Lets a team run the Driver Station Wi-Fi check on this laptop: a
 * PowerShell script pFMS serves (diag/ds-wifi-report.ps1) that reads what
 * Windows recorded about the laptop's Wi-Fi and uploads it for the field
 * staff to review.
 *
 * Download + "Run with PowerShell" rather than a copy-paste one-liner:
 * Microsoft Defender blocks `irm <url> | iex` as a trojan (2026-09-28).
 */
export function LaptopWifiCheck() {
  const onWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Wi-Fi check for this laptop
        </Typography>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          If this laptop drops off the field&apos;s Wi-Fi, run this check. It reads what Windows recorded about the
          laptop&apos;s Wi-Fi and sends it to the field staff. It changes nothing on the laptop and never reads Wi-Fi
          passwords.
        </Typography>
        {!onWindows && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            The check is for Windows Driver Station laptops. Open this page on that laptop to run it.
          </Typography>
        )}
        <Box component="ol" sx={{ pl: 2.5, my: 0, '& li': { mb: 0.75 } }}>
          <li>
            <Button
              variant="outlined"
              size="small"
              startIcon={<DownloadIcon />}
              href={`${SCRIPT_URL}?download`}
              download="pfms-wifi-check.ps1"
            >
              Download the check
            </Button>
          </li>
          <li>
            <Typography variant="body2">
              In your Downloads folder, right-click <strong>pfms-wifi-check.ps1</strong> and choose{' '}
              <strong>Run with PowerShell</strong>. On Windows 11 it is under <strong>Show more options</strong>.
            </Typography>
          </li>
          <li>
            <Typography variant="body2">
              Wait until the window says <strong>Sent to pFMS</strong>, then press Enter to close it.
            </Typography>
          </li>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Curious what it does?{' '}
          <Link href={SCRIPT_URL} target="_blank" rel="noopener">
            Read the script
          </Link>
          .
        </Typography>
      </CardContent>
    </Card>
  );
}
