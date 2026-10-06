import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { MatchRecordingStreamStatus, RecordingStreamConfig, RecordingStreamTestResult } from '../../../src/types';
import {
  sendUpdateSetupSettings,
  testRecordingStream,
  useMatchRecordingState,
  useSetupConfig,
} from '../hooks/useBackend';

/** GB = 1024³ bytes, the unit of the free-space floor set on this page. */
function formatRecordingBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

/** The stream's state, separate from the Enable/Disable action: is it saved on
 *  the server, is it recording right now, did its last run fail. */
function StreamStateChip({
  stream,
  savedStream,
  live,
}: {
  stream: RecordingStreamConfig;
  savedStream: RecordingStreamConfig | undefined;
  live: MatchRecordingStreamStatus | undefined;
}) {
  if (live?.status === 'recording') {
    return (
      <Chip
        size="small"
        color="error"
        label={`● Recording${live.bytes ? ` · ${formatRecordingBytes(live.bytes)}` : ''}`}
      />
    );
  }
  if (live?.status === 'finalizing') return <Chip size="small" color="info" label="Finalizing…" />;
  if (!savedStream) return <Chip size="small" variant="outlined" label="Not saved" />;
  if (savedStream.enabled !== stream.enabled)
    return <Chip size="small" color="warning" variant="outlined" label="Unsaved change" />;
  if (!stream.enabled) return <Chip size="small" variant="outlined" label="Disabled" />;
  if (live?.error && live.status !== 'idle')
    return <Chip size="small" color="error" variant="outlined" label="Error" />;
  if (live?.error)
    return <Chip size="small" color="warning" variant="outlined" label="Enabled · last run had errors" />;
  return <Chip size="small" color="success" variant="outlined" label="Enabled" />;
}

/**
 * Which video streams pFMS records for every match. Streams are saved as a
 * setup setting (admin-gated, persisted, env-seeded); the recorder picks them
 * up on the next match. A stream can be probed before it is saved.
 */
export function MatchRecordingSection() {
  const setupConfig = useSetupConfig();
  const recording = useMatchRecordingState();
  const saved = setupConfig?.config.settings.recordingStreams;
  const [streams, setStreams] = useState<RecordingStreamConfig[]>([]);
  const [retention, setRetention] = useState<string>('');
  const [clipRetention, setClipRetention] = useState<string>('');
  const [minFree, setMinFree] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState<Record<string, RecordingStreamTestResult | 'pending'>>({});

  // Follow the server until the operator starts editing.
  useEffect(() => {
    if (dirty) return;
    setStreams(saved ?? recording?.streams.map(s => ({ name: s.name, url: s.url, enabled: s.enabled })) ?? []);
    setRetention(String(setupConfig?.config.settings.recordingRetentionDays ?? recording?.retentionDays ?? 30));
    setClipRetention(
      String(setupConfig?.config.settings.practiceRetentionDays ?? recording?.practiceRetentionDays ?? 7),
    );
    setMinFree(
      String(
        setupConfig?.config.settings.recordingMinFreeGb ??
          (recording ? Math.round(recording.minFreeBytes / 1024 ** 3) : 25),
      ),
    );
  }, [saved, recording, setupConfig, dirty]);

  const edit = (i: number, patch: Partial<RecordingStreamConfig>) => {
    setDirty(true);
    setStreams(prev => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const remove = (i: number) => {
    setDirty(true);
    setStreams(prev => prev.filter((_, j) => j !== i));
  };
  const add = () => {
    setDirty(true);
    setStreams(prev => [...prev, { name: prev.length === 0 ? 'all-field' : '', url: 'rtsp://', enabled: true }]);
  };
  const save = () => {
    const days = Number.parseInt(retention, 10);
    const clipDays = Number.parseInt(clipRetention, 10);
    const freeGb = Number.parseInt(minFree, 10);
    const within = (n: number, max: number) => (Number.isInteger(n) && n >= 1 && n <= max ? n : undefined);
    sendUpdateSetupSettings({
      recordingStreams: streams.map(s => ({ ...s, name: s.name.trim(), url: s.url.trim() })),
      recordingRetentionDays: within(days, 365),
      practiceRetentionDays: within(clipDays, 365),
      recordingMinFreeGb: within(freeGb, 10000),
    });
    setDirty(false);
  };
  const test = async (url: string) => {
    setTesting(prev => ({ ...prev, [url]: 'pending' }));
    const result = await testRecordingStream(url);
    setTesting(prev => ({ ...prev, [url]: result }));
  };

  const invalid = streams.some(s => !s.name.trim() || !/^(rtsps?|https?|rtmp|srt|udp):\/\/.+/.test(s.url.trim()));
  const statusFor = (name: string) => recording?.streams.find(s => s.name === name);

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="h5">Match Video Recording</Typography>
          {recording && !recording.available && (
            <Chip size="small" color="error" label={recording.unavailableReason ?? 'ffmpeg not available'} />
          )}
          {recording?.activeMatchId && <Chip size="small" color="error" label="● Recording" />}
        </Box>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          Every match is captured from these streams (copied as-is, no transcoding) and offered for download on the
          station pages and in match history. Anything ffmpeg can read works — for stitchd/MediaMTX that is{' '}
          <code>rtsp://host:8554/&lt;stream&gt;</code>.
          {recording && (
            <>
              {' '}
              Recordings and timelapse use {formatRecordingBytes(recording.usedBytes)};{' '}
              <strong>{formatRecordingBytes(recording.diskFreeBytes)} free</strong>
              {recording.diskTotalBytes ? ` of ${formatRecordingBytes(recording.diskTotalBytes)}` : ''} (the breakdown
              is on the <Link href="/recordings">Recordings page</Link>). Match videos are kept{' '}
              {recording.retentionDays} days and teams&apos; practice clips {recording.practiceRetentionDays}; the
              timelapse keeps its own, longer schedule (Field Timelapse, below).
            </>
          )}
        </Typography>
        {recording && recording.space !== 'ok' && (
          <Alert severity={recording.space === 'critical' ? 'error' : 'warning'} sx={{ mb: 2 }}>
            {recording.space === 'critical' ? (
              <>
                Only {formatRecordingBytes(recording.diskFreeBytes)} free — <strong>nothing is being recorded</strong>,
                matches included, until space is made (on the <Link href="/recordings">Recordings page</Link>).
              </>
            ) : (
              <>
                {formatRecordingBytes(recording.diskFreeBytes)} free, under the{' '}
                {formatRecordingBytes(recording.minFreeBytes)} floor — <strong>practice clips are paused</strong>.
                Matches are still recorded. Clips resume by themselves as old ones pass their{' '}
                {recording.practiceRetentionDays} days, or delete some now (on the{' '}
                <Link href="/recordings">Recordings page</Link>).
              </>
            )}
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {streams.map((s, i) => {
            const live = statusFor(s.name);
            const t = testing[s.url];
            return (
              <Box key={i} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <TextField
                    size="small"
                    label="Name"
                    value={s.name}
                    onChange={e => edit(i, { name: e.target.value })}
                    sx={{ width: 160 }}
                  />
                  <TextField
                    size="small"
                    label="Stream URL"
                    value={s.url}
                    onChange={e => edit(i, { url: e.target.value })}
                    sx={{ flex: 1, minWidth: 260 }}
                  />
                  <StreamStateChip
                    stream={s}
                    savedStream={saved?.find(x => x.name === s.name && x.url === s.url)}
                    live={live}
                  />
                  <Button
                    size="small"
                    variant="outlined"
                    color={s.enabled ? 'warning' : 'success'}
                    onClick={() => edit(i, { enabled: !s.enabled })}
                  >
                    {s.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button size="small" variant="outlined" onClick={() => test(s.url)} disabled={t === 'pending'}>
                    {t === 'pending' ? 'Testing…' : 'Test'}
                  </Button>
                  <Button size="small" color="inherit" onClick={() => remove(i)} sx={{ opacity: 0.6 }}>
                    Remove
                  </Button>
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', pl: 0.5 }}>
                  {t && t !== 'pending' && (
                    <Chip
                      size="small"
                      color={t.ok ? 'success' : 'error'}
                      variant="outlined"
                      label={
                        t.ok
                          ? `OK: ${t.codec} ${t.width}×${t.height} @ ${t.fps ?? '?'} fps (${(t.ms / 1000).toFixed(1)} s to first frame)`
                          : `Failed: ${t.error}`
                      }
                    />
                  )}
                  {live?.reconnects ? (
                    <Chip
                      size="small"
                      color="warning"
                      variant="outlined"
                      label={`${live.reconnects} reconnect(s) this match`}
                    />
                  ) : null}
                  {live?.error && live.status !== 'recording' && (
                    <Typography variant="caption" sx={{ color: 'warning.main' }}>
                      Last error: {live.error}
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          })}

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" onClick={add}>
              Add stream
            </Button>
            <TextField
              size="small"
              label="Keep match videos (days)"
              value={retention}
              onChange={e => {
                setDirty(true);
                setRetention(e.target.value.replace(/[^0-9]/g, ''));
              }}
              sx={{ width: 190 }}
            />
            <TextField
              size="small"
              label="Keep practice clips (days)"
              value={clipRetention}
              onChange={e => {
                setDirty(true);
                setClipRetention(e.target.value.replace(/[^0-9]/g, ''));
              }}
              sx={{ width: 200 }}
            />
            <TextField
              size="small"
              label="Pause clips below (GB free)"
              value={minFree}
              onChange={e => {
                setDirty(true);
                setMinFree(e.target.value.replace(/[^0-9]/g, ''));
              }}
              sx={{ width: 210 }}
            />
            <Button size="small" variant="contained" onClick={save} disabled={!dirty || invalid}>
              Save
            </Button>
            {dirty && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Unsaved changes — applies from the next match.
              </Typography>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}
