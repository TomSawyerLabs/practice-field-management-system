import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import WifiIcon from '@mui/icons-material/Wifi';
import type { ReconfigProgress } from '../hooks/useReconfigProgress';
import { describeReconfigureChanges, type ReconfigureLine } from '../utils/reconfigureChanges';
import { TeamAvatar } from './TeamAvatar';

/** Seconds left on the countdown, and how far along it is (0–100). Null
 *  until the start of the reconfigure is known. */
export function reconfigureCountdown(
  progress: ReconfigProgress,
): { left: number; percent: number; over: boolean } | null {
  if (progress.elapsedSec === null) return null;
  const { elapsedSec, estimatedSec } = progress;
  return {
    left: Math.max(0, Math.ceil(estimatedSec - elapsedSec)),
    percent: Math.min(100, (elapsedSec / estimatedSec) * 100),
    over: elapsedSec >= estimatedSec,
  };
}

const KIND_COLOR: Record<ReconfigureLine['kind'], string> = {
  join: 'success.main',
  move: 'info.main',
  leave: 'text.secondary',
};

function ChangeList({ lines, size }: { lines: ReconfigureLine[]; size: 'small' | 'large' }) {
  const large = size === 'large';
  return (
    <Box
      component="ul"
      sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: large ? 1.5 : 0.5 }}
    >
      {lines.map(l => (
        <Box component="li" key={`${l.kind}-${l.ssid}`} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box
            sx={{
              width: large ? 14 : 8,
              height: large ? 14 : 8,
              borderRadius: '50%',
              backgroundColor: KIND_COLOR[l.kind],
              flexShrink: 0,
            }}
          />
          <TeamAvatar teamNumber={l.team} size={large ? 56 : 24} />
          <Typography sx={{ fontSize: large ? '2.4rem' : '0.95rem', fontWeight: l.kind === 'join' ? 700 : 400 }}>
            {l.text}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

const REJOIN_HINT = 'Every robot drops off the field Wi-Fi until it finishes, then reconnects on its own.';

/** The scoreboard TVs while the radio reconfigures: what is changing and
 *  how long it takes, in place of the scoreboard. */
export function ReconfigureTvScreen({ progress }: { progress: ReconfigProgress }) {
  const countdown = reconfigureCountdown(progress);
  const lines = describeReconfigureChanges(progress.changes);
  return (
    <Box
      role="status"
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        bgcolor: 'background.default',
        color: 'text.primary',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        p: '4vh 6vw',
        userSelect: 'none',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <WifiIcon sx={{ fontSize: '5rem', color: 'warning.main' }} />
        <Typography sx={{ fontSize: '4.5rem', fontWeight: 800, lineHeight: 1 }}>Field Wi-Fi is updating</Typography>
      </Box>

      {countdown && (
        <Box sx={{ width: '100%', maxWidth: 1100, textAlign: 'center' }}>
          <Typography
            sx={{
              fontSize: countdown.over ? '7rem' : '11rem',
              fontWeight: 800,
              lineHeight: 1,
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {countdown.over ? 'Almost done' : countdown.left}
          </Typography>
          <Typography sx={{ fontSize: '2rem', color: 'text.secondary', mb: 3 }}>
            {countdown.over ? 'Taking a little longer than usual' : 'seconds remaining'}
          </Typography>
          <LinearProgress
            variant={countdown.over ? 'indeterminate' : 'determinate'}
            value={countdown.percent}
            color="warning"
            sx={{ height: 18, borderRadius: 9 }}
          />
        </Box>
      )}

      <Box sx={{ minHeight: '20vh', display: 'flex', alignItems: 'center' }}>
        {lines.length > 0 ? (
          <ChangeList lines={lines} size="large" />
        ) : (
          <Typography sx={{ fontSize: '2.4rem', color: 'text.secondary' }}>
            Re-applying the field&apos;s Wi-Fi settings
          </Typography>
        )}
      </Box>

      <Typography sx={{ fontSize: '1.8rem', color: 'text.secondary', textAlign: 'center', maxWidth: 1400 }}>
        {REJOIN_HINT} Driver Stations can take up to a minute more to talk to their robot.
      </Typography>
    </Box>
  );
}

/** The team page's banner while the radio reconfigures. Hide collapses it
 *  into the progress bar across the status bar. */
export function ReconfigureBanner({ progress, onHide }: { progress: ReconfigProgress; onHide: () => void }) {
  const countdown = reconfigureCountdown(progress);
  const lines = describeReconfigureChanges(progress.changes);
  return (
    <Alert
      severity="warning"
      icon={<WifiIcon fontSize="large" />}
      square
      sx={{
        borderRadius: 0,
        alignItems: 'flex-start',
        '& .MuiAlert-message': { width: '100%' },
      }}
    >
      <AlertTitle sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap', fontSize: '1.25rem' }}>
        Field Wi-Fi is updating
        {countdown && (
          <Typography
            component="span"
            sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: '1.25rem' }}
          >
            {countdown.over ? 'almost done…' : `${countdown.left} s left`}
          </Typography>
        )}
      </AlertTitle>
      {countdown && (
        <LinearProgress
          variant={countdown.over ? 'indeterminate' : 'determinate'}
          value={countdown.percent}
          color="warning"
          sx={{ height: 8, borderRadius: 4, mb: 1.5 }}
        />
      )}
      {lines.length > 0 ? (
        <ChangeList lines={lines} size="small" />
      ) : (
        <Typography variant="body2">Re-applying the field&apos;s Wi-Fi settings.</Typography>
      )}
      <Typography variant="body2" sx={{ mt: 1 }}>
        {REJOIN_HINT} The page still works meanwhile.
        {countdown?.over && ' If this goes on for more than another minute, use Get Help at the top right.'}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
        <Button color="inherit" variant="outlined" size="small" onClick={onHide}>
          Hide to the top bar
        </Button>
      </Box>
    </Alert>
  );
}

/** The hidden banner, part 1: a fill across the whole status bar, behind
 *  its contents. The bar's contents must be positioned to sit above it. */
export function ReconfigureHeaderFill({ progress }: { progress: ReconfigProgress }) {
  const countdown = reconfigureCountdown(progress);
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        bgcolor: 'rgba(237, 108, 2, 0.15)',
      }}
    >
      <Box
        sx={{
          height: '100%',
          width: `${countdown ? countdown.percent : 100}%`,
          bgcolor: 'rgba(237, 108, 2, 0.45)',
          transition: 'width 0.1s linear',
        }}
      />
    </Box>
  );
}

/** The hidden banner, part 2: its label in the status bar, which brings
 *  the banner back when there is one. */
export function ReconfigureHeaderLabel({ progress, onShow }: { progress: ReconfigProgress; onShow?: () => void }) {
  const countdown = reconfigureCountdown(progress);
  return (
    <Box
      component={onShow ? 'button' : 'span'}
      onClick={onShow}
      sx={{
        ml: 1,
        px: 0.75,
        border: 0,
        borderRadius: 0.5,
        bgcolor: 'transparent',
        color: 'text.primary',
        font: 'inherit',
        fontSize: '0.7rem',
        fontWeight: 700,
        whiteSpace: 'nowrap',
        cursor: onShow ? 'pointer' : 'default',
        '&:hover': onShow ? { bgcolor: 'action.hover' } : undefined,
        '@media (pointer: coarse)': { py: 1 },
      }}
    >
      📡 Field Wi-Fi updating
      {countdown && (countdown.over ? ' — almost done' : ` — ${countdown.left} s`)}
      {onShow && ' · Details'}
    </Box>
  );
}
