import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Container from '@mui/material/Container';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import CloseIcon from '@mui/icons-material/Close';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import RefreshIcon from '@mui/icons-material/Refresh';

import {
  StationNameList,
  type MatchPhase,
  type StationName,
  type TeamCheckResults,
  type TelemetryUpdate,
} from '../../../src/types';
import { prettyStationName, teamOfSsid } from '../../../src/utils';
import {
  getServerTime,
  sendAdminStationEnable,
  sendApplyConfig,
  sendMatchForceStationReady,
  sendMatchKickStation,
  sendNewConfig,
  sendRunTeamChecks,
  useDriveSessionState,
  useHostnames,
  useLastLinked,
  useLatest,
  useMatchState,
  useNetworkStats,
  usePendingCommitState,
  useRoutePreferenceState,
  useSubnetScan,
  useTeamCheckResults,
  useTelemetryCallback,
  useWsConnected,
} from '../hooks/useBackend';
import {
  detectFieldIssues,
  groupIssues,
  isMatchRunning,
  shortAge,
  worstSeverity,
  type FieldIssue,
  type FieldIssueInputs,
  type IssueAction,
  type IssueRow,
  type IssueSeverity,
} from '../utils/fieldIssues';
import { HostDisplay } from './HostDisplay';
import { TeamAvatar } from './TeamAvatar';
import { StatusIcon } from './TeamChecksPanel';

// ── Local hooks ──────────────────────────────────────────────────────

/** Server-clock "now", ticking once a second so ages stay honest. */
function useServerNow(intervalMs = 1000): number {
  const [now, setNow] = useState(getServerTime);
  useEffect(() => {
    const id = setInterval(() => setNow(getServerTime()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Latest telemetry sample per station (the backend has no cache to seed from). */
function useTelemetryByStation(): Partial<Record<StationName, TelemetryUpdate>> {
  const [map, setMap] = useState<Partial<Record<StationName, TelemetryUpdate>>>({});
  useTelemetryCallback(
    useCallback((u: TelemetryUpdate) => setMap(m => (m[u.station] === u ? m : { ...m, [u.station]: u })), []),
  );
  return map;
}

/** Cached team-check results for every station. Fixed hook order — the
 *  station list is a constant. */
function useTeamChecksByStation(): Partial<Record<StationName, TeamCheckResults>> {
  const s1 = useTeamCheckResults('slot1');
  const s2 = useTeamCheckResults('slot2');
  const s3 = useTeamCheckResults('slot3');
  const s4 = useTeamCheckResults('slot4');
  const s5 = useTeamCheckResults('slot5');
  const s6 = useTeamCheckResults('slot6');
  return useMemo(() => {
    const out: Partial<Record<StationName, TeamCheckResults>> = {};
    if (s1) out.slot1 = s1;
    if (s2) out.slot2 = s2;
    if (s3) out.slot3 = s3;
    if (s4) out.slot4 = s4;
    if (s5) out.slot5 = s5;
    if (s6) out.slot6 = s6;
    return out;
  }, [s1, s2, s3, s4, s5, s6]);
}

// ── Actions ──────────────────────────────────────────────────────────

const ACTION_META: Record<
  IssueAction['kind'],
  { label: string; color: 'primary' | 'warning' | 'error' | 'success' | 'inherit'; confirm: boolean }
> = {
  applyWifi: { label: 'Apply now', color: 'warning', confirm: true },
  reenable: { label: 'Re-enable', color: 'success', confirm: true },
  readyAnyway: { label: 'Ready anyway', color: 'warning', confirm: true },
  kick: { label: 'Kick from match', color: 'warning', confirm: true },
  release: { label: 'Release', color: 'error', confirm: true },
  runChecks: { label: 'Re-run checks', color: 'primary', confirm: false },
};

function runAction(a: IssueAction) {
  switch (a.kind) {
    case 'applyWifi':
      sendApplyConfig();
      break;
    case 'reenable':
      sendAdminStationEnable(a.station);
      break;
    case 'readyAnyway':
      sendMatchForceStationReady(a.station);
      break;
    case 'kick':
      sendMatchKickStation(a.station);
      break;
    case 'release':
      sendNewConfig(a.station, '', '');
      break;
    case 'runChecks':
      sendRunTeamChecks(a.station);
      break;
  }
}

/** Two-tap button for anything that changes the field: the first tap arms it
 *  for five seconds, the second fires. One tap for read-only actions. */
function ActionButton({ action }: { action: IssueAction }) {
  const meta = ACTION_META[action.kind];
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  const label =
    'station' in action && action.kind !== 'runChecks'
      ? `${meta.label} ${prettyStationName(action.station).toLowerCase()}`
      : meta.label;

  return (
    <Button
      size="small"
      variant={armed ? 'contained' : 'outlined'}
      color={meta.color}
      onClick={() => {
        if (meta.confirm && !armed) {
          setArmed(true);
          return;
        }
        runAction(action);
        setArmed(false);
      }}
      sx={{ textTransform: 'none', py: 0.25 }}
    >
      {armed ? `Tap again: ${label}` : label}
    </Button>
  );
}

// ── Issue cards ──────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<IssueSeverity, string> = {
  critical: 'error.main',
  warning: 'warning.main',
  info: 'info.main',
};

function SeverityIcon({ severity, size = 20 }: { severity: IssueSeverity; size?: number }) {
  const sx = { fontSize: size, color: SEVERITY_COLOR[severity], flexShrink: 0, mt: '1px' };
  if (severity === 'critical') return <ErrorOutlineIcon sx={sx} />;
  if (severity === 'warning') return <WarningAmberIcon sx={sx} />;
  return <InfoOutlinedIcon sx={sx} />;
}

function IssueCard({ issue, onStation }: { issue: FieldIssue; onStation: (s: StationName) => void }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        borderLeft: '5px solid',
        borderLeftColor: SEVERITY_COLOR[issue.severity],
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
      }}
    >
      <SeverityIcon severity={issue.severity} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {issue.station && (
            <Chip
              label={prettyStationName(issue.station)}
              size="small"
              variant="outlined"
              onClick={() => onStation(issue.station!)}
              sx={{ height: 20, fontSize: '0.7rem' }}
            />
          )}
          {issue.team ? <TeamAvatar teamNumber={issue.team} size={20} /> : null}
          <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
            {issue.title}
          </Typography>
        </Box>
        {issue.detail && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25 }}>
            {issue.detail}
          </Typography>
        )}
        {issue.fix && (
          <Typography variant="body2" sx={{ mt: 0.25 }}>
            <Box component="span" sx={{ fontWeight: 700 }}>
              Try:{' '}
            </Box>
            {issue.fix}
          </Typography>
        )}
        {issue.actions && issue.actions.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.75 }}>
            {issue.actions.map((a, i) => (
              <ActionButton key={i} action={a} />
            ))}
          </Box>
        )}
      </Box>
    </Paper>
  );
}

/** Several stations with the same problem: one headline, one line per
 *  robot with its own evidence, one "Try", every member's actions. */
function GroupCard({
  row,
  onStation,
}: {
  row: Extract<IssueRow, { type: 'group' }>;
  onStation: (s: StationName) => void;
}) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        borderLeft: '5px solid',
        borderLeftColor: SEVERITY_COLOR[row.severity],
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
      }}
    >
      <SeverityIcon severity={row.severity} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
          {row.title}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mt: 0.5 }}>
          {row.members.map(m => (
            <Box key={m.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
              {m.station && (
                <Chip
                  label={prettyStationName(m.station)}
                  size="small"
                  variant="outlined"
                  onClick={() => onStation(m.station!)}
                  sx={{ height: 20, fontSize: '0.7rem' }}
                />
              )}
              {m.team ? <TeamAvatar teamNumber={m.team} size={18} /> : null}
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {m.team ?? '—'}
              </Typography>
              {(m.evidence ?? m.detail) && (
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  · {m.evidence ?? m.detail}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
        {row.fix && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            <Box component="span" sx={{ fontWeight: 700 }}>
              Try:{' '}
            </Box>
            {row.fix}
          </Typography>
        )}
        {row.actions.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.75 }}>
            {row.actions.map((a, i) => (
              <ActionButton key={i} action={a} />
            ))}
          </Box>
        )}
      </Box>
    </Paper>
  );
}

function IssueRows({ rows, onStation }: { rows: IssueRow[]; onStation: (s: StationName) => void }) {
  return (
    <>
      {rows.map(r =>
        r.type === 'one' ? (
          <IssueCard key={r.issue.id} issue={r.issue} onStation={onStation} />
        ) : (
          <GroupCard key={r.key} row={r} onStation={onStation} />
        ),
      )}
    </>
  );
}

// ── Station strip ────────────────────────────────────────────────────

type DotState = 'ok' | 'bad' | 'na';

function Dot({ label, state, title }: { label: string; state: DotState; title: string }) {
  const color = state === 'ok' ? 'success.main' : state === 'bad' ? 'error.main' : 'text.disabled';
  return (
    <Tooltip title={title} arrow enterTouchDelay={0}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />
        <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.secondary', lineHeight: 1 }}>
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

interface StationFacts {
  station: StationName;
  ssid?: string;
  team: number | null;
  linked: boolean;
  wifi: DotState;
  ds: DotState;
  robot: DotState;
  enabled: boolean;
  joined: boolean;
  matchSlot: string | null;
  worst?: IssueSeverity;
}

function stationFacts(input: FieldIssueInputs, issues: FieldIssue[], station: StationName): StationFacts {
  const radio = input.latest?.radioUpdate?.stationStatuses[station] ?? null;
  const ssid = radio?.ssid || undefined;
  const control = input.matchState?.stationStates[station];
  const team = control?.teamNumber ?? teamOfSsid(ssid);
  const linked = radio?.isLinked ?? false;
  const joined = control?.joined ?? false;
  const dsConn = input.matchState?.connectedStations[station];
  const session = input.driveSession?.sessions?.[station];
  const dsAttached = control?.dsAttached ?? (dsConn ? input.now - dsConn.lastSeen <= 5000 : false);
  const tele = input.telemetry[station];
  const teleFresh = tele !== undefined && input.now - tele.timestamp <= 10_000;

  const wifi: DotState = !ssid ? 'na' : linked ? 'ok' : 'bad';
  const ds: DotState = joined ? (dsAttached ? 'ok' : 'bad') : session || dsConn ? 'ok' : 'na';
  const robot: DotState =
    teleFresh && tele.dsStatus && (dsAttached || session) ? (tele.dsStatus.robotComms ? 'ok' : 'bad') : 'na';

  return {
    station,
    ssid,
    team,
    linked,
    wifi,
    ds,
    robot,
    enabled: control?.enabled ?? false,
    joined,
    matchSlot: control?.matchSlot ?? null,
    worst: worstSeverity(issues.filter(i => i.station === station)),
  };
}

function StationTile({ facts, onClick }: { facts: StationFacts; onClick: () => void }) {
  const border = facts.worst ? SEVERITY_COLOR[facts.worst] : facts.ssid ? 'success.main' : 'divider';
  const alliance = facts.matchSlot?.startsWith('red')
    ? '#d32f2f'
    : facts.matchSlot?.startsWith('blue')
      ? '#1565c0'
      : undefined;
  return (
    <ButtonBase
      onClick={onClick}
      sx={{ display: 'block', textAlign: 'left', borderRadius: 1, width: '100%', opacity: facts.ssid ? 1 : 0.55 }}
    >
      <Paper
        variant="outlined"
        sx={{ p: 0.75, borderColor: border, borderWidth: facts.worst ? 2 : 1, height: '100%', minWidth: 0 }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.65rem', whiteSpace: 'nowrap' }}>
            {prettyStationName(facts.station)}
          </Typography>
          {facts.matchSlot && (
            <Typography
              variant="caption"
              sx={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: alliance,
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
            >
              {facts.matchSlot}
              {facts.enabled ? ' · EN' : ''}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, my: 0.25, minHeight: 20 }}>
          <TeamAvatar teamNumber={facts.team} size={18} />
          <Typography
            variant="body2"
            sx={{
              fontWeight: 700,
              fontFamily: 'monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {facts.ssid ?? 'empty'}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.9, flexWrap: 'wrap' }}>
          <Dot label="Wi-Fi" state={facts.wifi} title="Robot radio linked to the field AP" />
          <Dot label="DS" state={facts.ds} title="Driver Station talking to the field" />
          <Dot label="Robot" state={facts.robot} title="Driver Station reports robot communication" />
        </Box>
      </Paper>
    </ButtonBase>
  );
}

// ── Station detail dialog ────────────────────────────────────────────

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <Box sx={{ display: 'flex', gap: 1.5, py: 0.2 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', minWidth: 120, flexShrink: 0 }}>
        {k}
      </Typography>
      <Typography variant="body2" component="div" sx={{ fontFamily: mono ? 'monospace' : undefined, minWidth: 0 }}>
        {v}
      </Typography>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mt: 1.25 }}>
      <Typography variant="overline" sx={{ lineHeight: 1.5, color: 'text.secondary' }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function yesNo(v: boolean | undefined): string {
  return v === undefined ? '—' : v ? 'yes' : 'no';
}

function StationDialog({
  station,
  input,
  issues,
  onClose,
}: {
  station: StationName;
  input: FieldIssueInputs;
  issues: FieldIssue[];
  onClose: () => void;
}) {
  const { now } = input;
  const radio = input.latest?.radioUpdate?.stationStatuses[station] ?? null;
  const ssid = radio?.ssid || undefined;
  const control = input.matchState?.stationStates[station];
  const team = control?.teamNumber ?? teamOfSsid(ssid);
  const dsConn = input.matchState?.connectedStations[station];
  const session = input.driveSession?.sessions?.[station];
  const blocked = input.driveSession?.blockedDs?.[station] ?? [];
  const tele = input.telemetry[station];
  const scan = input.subnetScan?.stations[station];
  const checks = input.teamChecks[station];
  const lastLinked = input.lastLinked[station];
  const phase = input.matchState?.phase;
  const mine = issues.filter(i => i.station === station);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        <TeamAvatar teamNumber={team} size={28} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="div" sx={{ lineHeight: 1.2 }}>
            {prettyStationName(station)}
            {ssid ? ` · ${ssid}` : ' · empty'}
          </Typography>
          {control?.matchSlot && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {control.matchSlot} · {control.enabled ? 'enabled' : 'disabled'}
              {control.disabledBy ? ` by ${control.disabledBy}` : ''}
              {control.ready ? ' · ready' : ''}
            </Typography>
          )}
        </Box>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }} aria-label="close">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ pt: 1 }}>
        {mine.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 1 }}>
            {mine.map(i => (
              <IssueCard key={i.id} issue={i} onStation={() => {}} />
            ))}
          </Box>
        )}

        <Section title="Robot radio (from the AP)">
          {radio ? (
            <>
              <Row
                k="Linked"
                v={radio.isLinked ? 'yes' : lastLinked ? `no — last ${shortAge(now - lastLinked)} ago` : 'never'}
              />
              {radio.isLinked && (
                <>
                  <Row
                    k="Signal"
                    v={`${radio.signalDbm} dBm · noise ${radio.noiseDbm} dBm · SNR ${radio.signalNoiseRatio} dB`}
                  />
                  <Row k="Quality" v={radio.connectionQuality || '—'} />
                  <Row
                    k="Rate"
                    v={`rx ${radio.rxRateMbps} / tx ${radio.txRateMbps} Mbps · using ${radio.bandwidthUsedMbps.toFixed(2)} Mbps`}
                  />
                  <Row k="Data age" v={shortAge(radio.dataAgeMs)} />
                  <Row k="MAC" v={radio.macAddress || '—'} mono />
                </>
              )}
            </>
          ) : (
            <Row k="Config" v="not on the radio" />
          )}
        </Section>

        <Section title="Driver Station (to the field)">
          <Row k="Attached" v={yesNo(control?.dsAttached)} />
          {dsConn && (
            <>
              <Row k="Address" v={<HostDisplay ip={dsConn.ip} />} mono />
              <Row
                k="Generation"
                v={
                  dsConn.protocol === 'ds2027'
                    ? '2027 DS (SystemCore)'
                    : dsConn.protocol === 'legacy'
                      ? 'NI DS (roboRIO)'
                      : '—'
                }
              />
              <Row k="Last packet" v={`${shortAge(now - dsConn.lastSeen)} ago`} />
            </>
          )}
          {session && (
            <Row
              k="Drive session"
              v={
                <>
                  <HostDisplay ip={session.dsIp} /> · active {shortAge(now - session.lastActivity)} ago · times out in{' '}
                  {session.timeoutRemaining} s
                </>
              }
            />
          )}
          {blocked.length > 0 && (
            <Row
              k="Blocked DS"
              v={blocked.map((ip, i) => (
                <span key={ip}>
                  {i > 0 && ', '}
                  <HostDisplay ip={ip} />
                </span>
              ))}
            />
          )}
          {!dsConn && !session && <Row k="Seen" v="no Driver Station has talked to this station" />}
        </Section>

        <Section title="Driver Station report (telemetry)">
          {tele ? (
            <>
              <Row k="Sample age" v={`${shortAge(now - tele.timestamp)} ago`} />
              {tele.dsStatus && (
                <Row
                  k="Status bits"
                  v={[
                    `robot comms ${yesNo(tele.dsStatus.robotComms)}`,
                    `radio ping ${yesNo(tele.dsStatus.radioPing)}`,
                    `rio ping ${yesNo(tele.dsStatus.rioPing)}`,
                    `enabled ${yesNo(tele.dsStatus.enabled)}`,
                    tele.dsStatus.mode,
                    tele.dsStatus.eStop ? 'E-STOP' : null,
                    tele.dsStatus.aStop ? 'A-STOP' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              )}
              <Row
                k="Robot"
                v={[
                  tele.batteryVoltage !== undefined ? `${tele.batteryVoltage.toFixed(2)} V` : 'no battery reading',
                  tele.rttMs !== undefined ? `rtt ${Math.round(tele.rttMs)} ms` : null,
                  tele.lostPackets !== undefined ? `${tele.lostPackets} lost` : null,
                  tele.brownout ? 'BROWNOUT' : null,
                  tele.dsCpuPercent !== undefined ? `DS CPU ${Math.round(tele.dsCpuPercent)}%` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            </>
          ) : (
            <Row k="Sample" v="none since this page opened" />
          )}
        </Section>

        <Section title="Team subnet (pFMS scanner)">
          {scan ? (
            <>
              <Row k="Subnet" v={scan.subnet} mono />
              <Row
                k="Hosts"
                v={`${scan.hosts.filter(h => h.alive).length} up of ${scan.hosts.length} · scanned ${shortAge(now - scan.lastScanTime)} ago`}
              />
              {scan.hosts
                .filter(h => h.alive || now - h.lastSeen < 120_000)
                .slice(0, 8)
                .map(h => (
                  <Row
                    key={h.ip}
                    k={
                      h.source === 'conntrack'
                        ? 'guest'
                        : h.ip.endsWith('.1')
                          ? 'radio'
                          : h.ip.endsWith('.2')
                            ? 'roboRIO'
                            : 'host'
                    }
                    v={
                      <>
                        <HostDisplay ip={h.ip} /> ·{' '}
                        {h.alive
                          ? `up ${shortAge(now - h.onlineSince)}`
                          : `down, last ${shortAge(now - h.lastSeen)} ago`}
                      </>
                    }
                    mono
                  />
                ))}
            </>
          ) : (
            <Row k="Scan" v="no scan for this station" />
          )}
        </Section>

        <Section title="Field checks">
          {checks && checks.team === team ? (
            <>
              <Row
                k="Ran"
                v={`${shortAge(now - checks.timestamp)} ago${checks.controller ? ` · ${checks.controller}` : ''}`}
              />
              {checks.checks.map((c, i) => (
                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.15 }}>
                  <StatusIcon status={c.status} size={16} />
                  <Typography variant="body2" sx={{ minWidth: 0 }}>
                    {c.name}
                    {(c.actual || c.message) && (
                      <Box component="span" sx={{ color: 'text.secondary', ml: 0.75, fontSize: '0.8rem' }}>
                        {c.actual ?? c.message}
                      </Box>
                    )}
                  </Typography>
                </Box>
              ))}
            </>
          ) : (
            <Row k="Results" v="none for this team yet" />
          )}
        </Section>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5, justifyContent: 'flex-start' }}>
        {ssid && (
          <Button size="small" component="a" href={`/${encodeURIComponent(ssid)}`} target="_blank" rel="noopener">
            Team page
          </Button>
        )}
        {ssid && (
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => sendRunTeamChecks(station)}>
            Run checks
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        {control?.joined && phase === 'created' && <ActionButton action={{ kind: 'kick', station }} />}
        {ssid && <ActionButton action={{ kind: 'release', station }} />}
      </DialogActions>
    </Dialog>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

function phaseLabel(phase: MatchPhase | undefined): string {
  switch (phase) {
    case undefined:
    case 'idle':
      return 'No match';
    case 'created':
      return 'Match being set up';
    case 'countdown':
      return 'Countdown';
    case 'auto':
      return 'Auto';
    case 'autoPause':
      return 'Auto pause';
    case 'paused':
      return 'Match paused';
    case 'teleop':
      return 'Teleop';
    case 'endgame':
      return 'Endgame';
    case 'postMatch':
      return 'Match over';
  }
}

/** One-screen field-network triage for CSAs and field staff. Renders only
 *  what is wrong (with what to try), a six-tile station strip for a glance,
 *  and a per-station detail sheet behind a tap. */
export function CsaPage() {
  const now = useServerNow();
  const wsConnected = useWsConnected();
  const latest = useLatest();
  const matchState = useMatchState();
  const driveSession = useDriveSessionState();
  const pending = usePendingCommitState();
  const networkStats = useNetworkStats();
  const routeState = useRoutePreferenceState();
  const subnetScan = useSubnetScan();
  const telemetry = useTelemetryByStation();
  const lastLinked = useLastLinked();
  const teamChecks = useTeamChecksByStation();
  const hostnames = useHostnames();
  const [selected, setSelected] = useState<StationName | null>(null);
  const [showNotes, setShowNotes] = useState(false);

  const input = useMemo<FieldIssueInputs>(
    () => ({
      now,
      wsConnected,
      latest,
      matchState,
      driveSession,
      pending,
      networkStats,
      routeState,
      subnetScan,
      telemetry,
      lastLinked,
      teamChecks,
      hostnames,
    }),
    [
      now,
      wsConnected,
      latest,
      matchState,
      driveSession,
      pending,
      networkStats,
      routeState,
      subnetScan,
      telemetry,
      lastLinked,
      teamChecks,
      hostnames,
    ],
  );
  const issues = useMemo(() => detectFieldIssues(input), [input]);
  const problems = issues.filter(i => i.severity !== 'info');
  const notes = issues.filter(i => i.severity === 'info');
  const worst = worstSeverity(problems);

  const facts = StationNameList.map(s => stationFacts(input, issues, s));
  const robotsLinked = facts.filter(f => f.linked).length;
  const robotsConfigured = facts.filter(f => f.ssid).length;
  const dsTalking = facts.filter(f => f.ds === 'ok').length;
  const phase = matchState?.phase;

  return (
    <Container maxWidth="md" sx={{ py: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
          Field network
        </Typography>
        <Chip
          size="small"
          icon={
            worst ? (
              <SeverityIcon severity={worst} size={16} />
            ) : (
              <CheckCircleOutlineIcon sx={{ fontSize: 16, color: 'success.main' }} />
            )
          }
          label={
            worst
              ? `${problems.length} problem${problems.length === 1 ? '' : 's'}`
              : wsConnected
                ? 'All clear'
                : 'Offline'
          }
          color={worst === 'critical' ? 'error' : worst === 'warning' ? 'warning' : 'success'}
          variant={worst ? 'filled' : 'outlined'}
          sx={{ fontWeight: 700 }}
        />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {robotsLinked}/{robotsConfigured} robots on Wi-Fi · {dsTalking} DS talking · {phaseLabel(phase)}
          {isMatchRunning(phase) && matchState?.matchNumber ? ` #${matchState.matchNumber}` : ''}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <Link href="/network" variant="caption" underline="hover">
            Network detail
          </Link>
          <Link href="/match" variant="caption" underline="hover">
            Match
          </Link>
          <Link href="/admin" variant="caption" underline="hover">
            Admin
          </Link>
        </Box>
      </Box>

      {/* Problems, or the all-clear */}
      {problems.length > 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <IssueRows rows={groupIssues(problems)} onStation={setSelected} />
        </Box>
      ) : (
        <Paper
          variant="outlined"
          sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1.5, borderColor: 'success.main', opacity: 0.9 }}
        >
          <CheckCircleOutlineIcon sx={{ fontSize: 36, color: 'success.main' }} />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
              {wsConnected ? 'Nothing wrong that the field can see' : 'Waiting for pFMS…'}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Radio, Driver Stations, robot links and host tables all look normal. Tap a station for its raw numbers.
            </Typography>
          </Box>
        </Paper>
      )}

      {/* Low-priority notes, folded */}
      {notes.length > 0 && (
        <Box>
          <Button
            size="small"
            onClick={() => setShowNotes(v => !v)}
            startIcon={<InfoOutlinedIcon sx={{ fontSize: 16 }} />}
            sx={{ textTransform: 'none', color: 'text.secondary', px: 0.5 }}
          >
            {notes.length} note{notes.length === 1 ? '' : 's'} {showNotes ? '▴' : '▾'}
          </Button>
          <Collapse in={showNotes}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 0.5 }}>
              <IssueRows rows={groupIssues(notes)} onStation={setSelected} />
            </Box>
          </Collapse>
        </Box>
      )}

      <Divider sx={{ my: 0.25 }} />

      {/* Station strip */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(3, minmax(0, 1fr))', sm: 'repeat(6, minmax(0, 1fr))' },
          gap: 0.75,
        }}
      >
        {facts.map(f => (
          <StationTile key={f.station} facts={f} onClick={() => setSelected(f.station)} />
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.disabled', textAlign: 'center' }}>
        Tap a station for its raw radio, Driver Station, telemetry and scan data.
      </Typography>

      {selected && <StationDialog station={selected} input={input} issues={issues} onClose={() => setSelected(null)} />}
    </Container>
  );
}
