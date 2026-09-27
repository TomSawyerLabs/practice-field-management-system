import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { TeamAvatar } from './TeamAvatar';
import { StationNameList, type RadioHoldReason, type StagedStationChange, type StationName } from '../../../src/types';
import { prettyStationName, teamOfSsid } from '../../../src/utils';
import { useLatest, useMatchState, usePendingCommitState, sendApplyConfig } from '../hooks/useBackend';

export { teamOfSsid };

/** One line for a station change, named by robot — never by slot — so the
 *  same words work for teams and staff. `current` is what the radio has now. */
export function describeStationChange(change: StagedStationChange | null, current: string | undefined): string {
  if (change === null) return current ? `${current} leaves the field` : 'nothing to release';
  if (!current) return `${change.ssid} joins the field`;
  if (current === change.ssid) return `${change.ssid} is re-applied`;
  return `${current} is replaced by ${change.ssid}`;
}

/** Why held requests are waiting, in the audience's words. */
export function holdReasonText(hold: RadioHoldReason | undefined, audience: 'team' | 'staff'): string {
  if (hold === 'admin') {
    return audience === 'team'
      ? 'Field staff are holding Wi-Fi changes right now. Yours goes through when they apply it.'
      : 'Held because "Hold Wi-Fi changes" is on. They apply when you press Apply now or turn the hold off.';
  }
  return audience === 'team'
    ? 'A match is set up on the field. Your Wi-Fi is enabled when it is over, or sooner if field staff apply it.'
    : 'Held while a match exists. They apply on their own when the match is cleared, or now if you press Apply now.';
}

export const DEFERRED_TEXT_TEAM =
  'Waiting for every robot on the field to be disabled. Your Wi-Fi is enabled right after.';
export const DEFERRED_TEXT_STAFF =
  'Applied, waiting for every robot to be disabled — the radio reconfigures right after.';

type ChangeLine = { station: StationName; change: StagedStationChange | null };

function entries(changes: Record<string, StagedStationChange | null> | undefined): ChangeLine[] {
  if (!changes) return [];
  return StationNameList.filter(s => s in changes).map(station => ({ station, change: changes[station] ?? null }));
}

function ChangeLines({ lines, showSlot }: { lines: ChangeLine[]; showSlot: boolean }) {
  const latest = useLatest();
  const radio = latest?.radioUpdate?.stationStatuses;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, my: 1 }}>
      {lines.map(({ station, change }) => {
        const current = radio?.[station]?.ssid || undefined;
        const team = teamOfSsid(change?.ssid ?? current);
        return (
          <Box key={station} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TeamAvatar teamNumber={team} size={24} />
            <Typography variant="body2">{describeStationChange(change, current)}</Typography>
            {showSlot && (
              <Chip label={prettyStationName(station)} size="small" variant="outlined" sx={{ height: 20 }} />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** Every robot the radio currently has, with its link and enable state, so
 *  staff can see who a reconfigure is about to interrupt. */
function RobotsOnField() {
  const latest = useLatest();
  const matchState = useMatchState();
  const radio = latest?.radioUpdate?.stationStatuses;
  const robots = StationNameList.flatMap(station => {
    const ssid = radio?.[station]?.ssid;
    if (!ssid) return [];
    const linked = radio?.[station]?.isLinked ?? false;
    const enabled = matchState?.stationStates[station]?.enabled ?? false;
    return [{ station, ssid, linked, enabled }];
  });
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mt: 1 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', mr: 0.5 }}>
        Robots on the field:
      </Typography>
      {robots.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.disabled' }}>
          none
        </Typography>
      ) : (
        robots.map(r => (
          <Chip
            key={r.station}
            size="small"
            label={`${r.ssid} · ${r.enabled ? 'enabled' : r.linked ? 'linked' : 'not linked'}`}
            color={r.enabled ? 'success' : r.linked ? 'default' : 'warning'}
            variant={r.enabled ? 'filled' : 'outlined'}
            sx={{ fontFamily: 'monospace' }}
          />
        ))
      )}
    </Box>
  );
}

/**
 * Staff view of everything waiting to reach the radio: held requests (with an
 * "Apply now" button), changes waiting for robots to be disabled, and the
 * robots a reconfigure would interrupt. Renders nothing when nothing waits.
 */
export function PendingRadioChangesPanel() {
  const pending = usePendingCommitState();
  const matchState = useMatchState();
  const held = entries(pending.stagedChanges);
  const deferred = entries(pending.deferredChanges);
  if (!pending.pending || (held.length === 0 && deferred.length === 0)) return null;

  const phase = matchState?.phase ?? 'idle';
  const matchRunning = phase !== 'idle' && phase !== 'created' && phase !== 'postMatch';
  const anyEnabled = StationNameList.some(s => matchState?.stationStates[s]?.enabled);

  return (
    <Card sx={{ mb: 2, borderLeft: '6px solid', borderColor: 'warning.main' }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="h6">Wi-Fi changes waiting</Typography>
          {held.length > 0 && (
            <Button variant="contained" color="warning" disabled={matchRunning} onClick={sendApplyConfig}>
              Apply now
            </Button>
          )}
        </Box>

        {held.length > 0 && (
          <>
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
              {holdReasonText(pending.hold, 'staff')}
            </Typography>
            <ChangeLines lines={held} showSlot />
          </>
        )}

        {deferred.length > 0 && (
          <>
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
              {DEFERRED_TEXT_STAFF}
            </Typography>
            <ChangeLines lines={deferred} showSlot />
          </>
        )}

        <RobotsOnField />

        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          Applying reconfigures the radio for about 30 seconds and drops every robot&apos;s Wi-Fi while it does.
          {matchRunning
            ? ' Apply now is available once the match ends.'
            : anyEnabled
              ? ' Robots are enabled right now: the radio reconfigures as soon as they are all disabled.'
              : ''}
        </Typography>
      </CardContent>
    </Card>
  );
}
