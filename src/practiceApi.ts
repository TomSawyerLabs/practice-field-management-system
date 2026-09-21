/**
 * Share-token access to one team's practice day: every match and practice
 * run the team was part of on that day, with videos, metadata and one zip
 * of the lot.
 *
 *   GET /api/public/practice/<token>                       PublicPracticeDay JSON
 *   GET /api/public/practice/<token>/video/<id>/<file>     an MP4 (Range; ?download=1)
 *   GET /api/public/practice/<token>/meta/<id>/<file>      metadata.json / scores.csv / telemetry.csv
 *   GET /api/public/practice/<token>/zip                   everything, as one store-only zip
 *
 * The token is the whole credential (32 random base64url characters minted
 * with the day's first recording), so the page works from anywhere without a
 * login. It unlocks that team's recordings for that day and nothing else:
 * `<id>` must be one of the day's entries, and `<file>` one of that entry's
 * listed files.
 */
import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { json, serveSidecar } from './httpApiUtils.js';
import type { MatchHistoryStore } from './matchHistoryStore.js';
import type { MatchRecorder } from './matchRecorder.js';
import { practiceDayLabel, practiceDayOf, type PracticeStore } from './practiceStore.js';
import { isShareToken } from './publicMatchApi.js';
import { serveRecordingFile } from './recordingsApi.js';
import {
  METADATA_FILE,
  SCORES_CSV,
  TELEMETRY_CSV,
  activityFor,
  readMetadata,
  summarizeMetadata,
} from './sessionMetadata.js';
import type { MatchHistoryEntry, PracticeRunEntry, PublicPracticeDay, PublicPracticeItem } from './types.js';
import { ZipWriter, zipSizeEstimate } from './zipStream.js';

const SIDECARS = new Set([METADATA_FILE, SCORES_CSV, TELEMETRY_CSV]);

export interface PracticeApiDeps {
  practiceStore: PracticeStore;
  historyStore: MatchHistoryStore;
  recorder: MatchRecorder;
  /** Where the field is reachable from anywhere, for absolute links in the JSON. */
  publicUrl: () => string | undefined;
}

export function handlePracticeRequest(req: IncomingMessage, res: ServerResponse, deps: PracticeApiDeps): boolean {
  const [path] = (req.url ?? '').split('?');
  if (!path.startsWith('/api/public/practice/')) return false;
  const m = /^\/api\/public\/practice\/([^/]+)(?:\/(zip|video|meta)(?:\/([^/]+)\/([^/]+))?)?\/?$/.exec(path);
  if (!m) {
    json(res, 404, { error: 'Unknown practice route' });
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const token = decodeURIComponent(m[1]);
  const day = isShareToken(token) ? deps.practiceStore.findByToken(token) : undefined;
  if (!day) {
    json(res, 404, { error: 'No such practice day' });
    return true;
  }
  const items = collectDay(deps, day.teamNumber, day.day);

  if (!m[2]) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    json(res, 200, summarizeDay(deps, token, day.teamNumber, day.day, items));
    return true;
  }

  if (m[2] === 'zip') {
    void serveZip(req, res, deps, day.teamNumber, day.day, items);
    return true;
  }

  const id = decodeURIComponent(m[3] ?? '');
  const file = decodeURIComponent(m[4] ?? '');
  const item = items.find(i => i.id === id);
  if (!item) {
    json(res, 404, { error: 'No such recording on this day' });
    return true;
  }
  if (m[2] === 'video') {
    if (!item.recordings.some(r => r.file === file && r.status !== 'failed')) {
      json(res, 404, { error: 'No such recording' });
      return true;
    }
    serveRecordingFile(req, res, deps.recorder, id, file);
    return true;
  }
  // meta
  const dir = deps.recorder.matchDirectory(id);
  if (!dir || !SIDECARS.has(file)) {
    json(res, 404, { error: 'No such file' });
    return true;
  }
  serveSidecar(req, res, join(dir, file), file, `${prefixFor(day.teamNumber, day.day, item)}_${file}`);
  return true;
}

/** How many recordings a team's day link lists right now. */
export function countPracticeDayItems(deps: PracticeApiDeps, teamNumber: number, day: string): number {
  return collectDay(deps, teamNumber, day).length;
}

/** Everything filed under a team's practice day, oldest first. */
interface DayItem {
  kind: 'match' | 'practice';
  id: string;
  /** Match number, or the run's position within the day (1-based). */
  number: number;
  startedAt: number;
  endedAt: number;
  match?: MatchHistoryEntry;
  run?: PracticeRunEntry;
  recordings: NonNullable<MatchHistoryEntry['recordings']>;
}

function collectDay(deps: PracticeApiDeps, teamNumber: number, day: string): DayItem[] {
  const items: DayItem[] = [];
  for (const match of deps.historyStore.getState().matches) {
    if (!match.matchId || !match.recordings?.length) continue;
    if (practiceDayOf(match.startedAt) !== day) continue;
    if (!match.teams.some(t => t.teamNumber === teamNumber)) continue;
    // Only what is still on disk — the sweep may have removed it.
    const dir = deps.recorder.matchDirectory(match.matchId);
    if (!dir || !exists(dir)) continue;
    items.push({
      kind: 'match',
      id: match.matchId,
      number: match.matchNumber,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      match,
      recordings: match.recordings,
    });
  }
  for (const run of deps.practiceStore.runsFor(teamNumber, day)) {
    const dir = deps.recorder.matchDirectory(run.id);
    if (!dir || !exists(dir)) continue;
    items.push({
      kind: 'practice',
      id: run.id,
      number: 0,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      run,
      recordings: run.recordings,
    });
  }
  items.sort((a, b) => a.startedAt - b.startedAt);
  let runNumber = 0;
  for (const item of items) if (item.kind === 'practice') item.number = ++runNumber;
  return items;
}

function exists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileSize(path: string): number | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

function summarizeDay(
  deps: PracticeApiDeps,
  token: string,
  teamNumber: number,
  day: string,
  items: DayItem[],
): PublicPracticeDay {
  const base = `/api/public/practice/${encodeURIComponent(token)}`;
  const publicUrl = deps.publicUrl();
  const out: PublicPracticeItem[] = [];
  for (const item of items) {
    const dir = deps.recorder.matchDirectory(item.id)!;
    const meta = readMetadata(dir);
    const summary = meta ? summarizeMetadata(meta, teamNumber) : undefined;
    const sidecar = (file: string) =>
      fileSize(join(dir, file)) !== undefined ? `${base}/meta/${encodeURIComponent(item.id)}/${file}` : undefined;
    const teams = item.match
      ? item.match.teams.map(t => ({ station: t.station, teamNumber: t.teamNumber, alliance: t.alliance }))
      : [{ station: item.run!.station, teamNumber: item.run!.teamNumber }];
    out.push({
      kind: item.kind,
      id: item.id,
      number: item.number,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      durationSeconds: Math.round((item.endedAt - item.startedAt) / 1000),
      teams,
      redScore: item.match?.redScore,
      blueScore: item.match?.blueScore,
      summaryUrl:
        item.match?.shareToken && publicUrl
          ? `${publicUrl}/matches/${encodeURIComponent(item.match.shareToken)}`
          : undefined,
      scored: summary?.scored,
      battery: summary?.battery,
      activity: meta ? activityFor(meta, teamNumber) : undefined,
      recordings: item.recordings
        .filter(r => r.status !== 'failed')
        .map(r => ({
          name: r.name,
          file: r.file,
          bytes: r.bytes,
          durationSeconds: r.durationSeconds,
          status: r.status === 'partial' ? 'partial' : 'ok',
          url: `${base}/video/${encodeURIComponent(item.id)}/${encodeURIComponent(r.file)}`,
          downloadUrl: `${base}/video/${encodeURIComponent(item.id)}/${encodeURIComponent(r.file)}?download=1`,
        })),
      metadataUrl: sidecar(METADATA_FILE),
      telemetryCsvUrl: sidecar(TELEMETRY_CSV),
      scoresCsvUrl: sidecar(SCORES_CSV),
    });
  }
  return {
    teamNumber,
    day,
    dayLabel: practiceDayLabel(day),
    retentionDays: deps.recorder.effectiveRetentionDays(),
    zipUrl: `${base}/zip`,
    zipBytes: zipSizeEstimate(zipEntries(deps, teamNumber, day, items).map(e => ({ name: e.name, size: e.size }))),
    items: out,
  };
}

interface ZipEntry {
  name: string;
  path: string;
  size: number;
  mtime: Date;
}

/** `team5940_2026-09-18_run-03` / `…_match-12` — the folder each recording gets in the zip. */
function prefixFor(teamNumber: number, day: string, item: { kind: 'match' | 'practice'; number: number }): string {
  const n = String(item.number).padStart(2, '0');
  return `team${teamNumber}_${day}_${item.kind === 'match' ? 'match' : 'run'}-${n}`;
}

function zipEntries(deps: PracticeApiDeps, teamNumber: number, day: string, items: DayItem[]): ZipEntry[] {
  const entries: ZipEntry[] = [];
  for (const item of items) {
    const dir = deps.recorder.matchDirectory(item.id)!;
    const folder = prefixFor(teamNumber, day, item);
    const files = [
      ...item.recordings.filter(r => r.status !== 'failed').map(r => r.file),
      METADATA_FILE,
      SCORES_CSV,
      TELEMETRY_CSV,
      'recording.json',
    ];
    for (const file of files) {
      const path = join(dir, file);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      entries.push({ name: `${folder}/${file}`, path, size: st.size, mtime: st.mtime });
    }
  }
  return entries;
}

async function serveZip(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PracticeApiDeps,
  teamNumber: number,
  day: string,
  items: DayItem[],
): Promise<void> {
  const entries = zipEntries(deps, teamNumber, day, items);
  if (entries.length === 0) {
    json(res, 404, { error: 'Nothing to download yet' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="team${teamNumber}_${day}_practice.zip"`,
    'Content-Length': String(zipSizeEstimate(entries.map(e => ({ name: e.name, size: e.size })))),
    'Cache-Control': 'private, no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const zip = new ZipWriter(res);
  try {
    for (const e of entries) await zip.addFile(e.name, e.path, e.size, e.mtime);
    await zip.finish();
    res.end();
  } catch (err) {
    // The client went away or a file changed underneath us: nothing to send
    // back on a half-written stream, just cut it.
    console.warn(`Practice zip for team ${teamNumber} ${day} aborted: ${(err as Error).message}`);
    res.destroy();
  }
}
