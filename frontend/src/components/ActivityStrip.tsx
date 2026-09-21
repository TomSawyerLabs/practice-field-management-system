import ButtonBase from '@mui/material/ButtonBase';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { RecordingActivity } from '../../../src/types';

const RED = '#ef5350';
const BLUE = '#42a5f5';
const ENABLED = '#66bb6a';

/** Same alliance colours as the match summary, so the two pages agree. */
const LANE_TOP = 0;
const LANE_H = 8;
const TRACK_Y = 18;
const TRACK_H = 4;
const VIEW_H = 22;

/**
 * A thin map of one recording: where the balls went in and when the robot
 * was actually enabled, laid out along the video's own timeline so a row of
 * these can be compared at a glance. Clicking jumps the video to that moment.
 *
 * Two lanes of scoring density (red above, blue below) rather than one
 * blended lane: at this size a blend of two alliances is unreadable, and
 * which alliance was scoring is usually the question. The enabled track
 * underneath is what makes a practice clip legible — the gaps are where the
 * driver stopped, including the ones a merged clip keeps (a disable and a
 * re-enable within six seconds stay one video).
 */
export function ActivityStrip({
  activity,
  durationSeconds,
  onSeek,
}: {
  activity: RecordingActivity;
  durationSeconds: number;
  onSeek?: (seconds: number) => void;
}) {
  const bins = activity.red.length;
  const totalRed = activity.red.reduce((a, b) => a + b, 0);
  const totalBlue = activity.blue.reduce((a, b) => a + b, 0);
  const enabledFor = activity.enabled.reduce((a, s) => a + (s.to - s.from), 0);
  if (bins === 0 || (totalRed + totalBlue === 0 && activity.enabled.length === 0)) return null;

  // Both lanes share one scale so their heights are comparable.
  const peak = Math.max(1, ...activity.red, ...activity.blue);
  // The bins tile the video; the last one can reach just past the end.
  const axis = Math.max(durationSeconds, bins * activity.binSeconds) || 1;
  const binW = (activity.binSeconds / axis) * 100;

  const cell = (v: number, i: number, y: number, fill: string) =>
    v > 0 ? (
      <rect
        key={`${fill}-${i}`}
        x={i * binW}
        y={y}
        width={binW}
        height={LANE_H}
        fill={fill}
        opacity={0.25 + 0.75 * (v / peak)}
      />
    ) : null;

  const seek = (e: React.MouseEvent<HTMLElement>) => {
    // detail 0 = activated from the keyboard, where there is no x to read.
    if (!onSeek || e.detail === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(Math.min(durationSeconds, frac * axis));
  };

  const label =
    `Activity: ${totalRed + totalBlue} ball${totalRed + totalBlue === 1 ? '' : 's'} scored, ` +
    `robot enabled for ${Math.round(enabledFor)} of ${Math.round(durationSeconds)} seconds`;

  return (
    <Box sx={{ mb: 1.5 }}>
      <ButtonBase
        onClick={seek}
        disabled={!onSeek}
        sx={{ display: 'block', width: '100%', borderRadius: 1, p: 0.25, '&:hover': { opacity: 0.85 } }}
      >
        <svg
          viewBox={`0 0 100 ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          style={{ width: '100%', height: 44, display: 'block' }}
        >
          <rect x={0} y={LANE_TOP} width={100} height={LANE_H * 2} fill="rgba(255,255,255,0.06)" rx={0.5} />
          {activity.red.map((v, i) => cell(v, i, LANE_TOP, RED))}
          {activity.blue.map((v, i) => cell(v, i, LANE_TOP + LANE_H, BLUE))}
          <rect x={0} y={TRACK_Y} width={100} height={TRACK_H} fill="rgba(255,255,255,0.06)" rx={0.5} />
          {activity.enabled.map((s, i) => (
            <rect
              key={i}
              x={(s.from / axis) * 100}
              y={TRACK_Y}
              width={Math.max(0.6, ((s.to - s.from) / axis) * 100)}
              height={TRACK_H}
              fill={ENABLED}
              rx={0.5}
            />
          ))}
        </svg>
      </ButtonBase>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', lineHeight: 1.4 }}>
        <Swatch color={RED} /> {totalRed} <Swatch color={BLUE} /> {totalBlue} <Swatch color={ENABLED} /> enabled{' '}
        {activity.enabled.length === 0 ? 'never' : describeSpans(activity.enabled)}
        {onSeek ? ' · tap the strip to jump the video there' : ''}
      </Typography>
    </Box>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <Box
      component="span"
      sx={{ display: 'inline-block', width: 8, height: 8, borderRadius: '2px', bgcolor: color, mr: 0.5, ml: 0.5 }}
    />
  );
}

/** "0:03–0:19, 0:24–0:41" — the first few spans, then a count. */
function describeSpans(spans: { from: number; to: number }[]): string {
  const shown = spans.slice(0, 3).map(s => `${clock(s.from)}–${clock(s.to)}`);
  const rest = spans.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` +${rest} more` : '');
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
