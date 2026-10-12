/**
 * Harness for the match recorder's pre-roll adopt
 * (`bun scripts/test-recorder-adopt.ts`). No camera or real ffmpeg needed.
 *
 * Real ffmpeg opens its output file only after probing the input stream,
 * which takes seconds on RTSP. A pre-roll whose match started inside that
 * window used to have its directory renamed under it: ffmpeg then failed
 * with "Error opening output files" and dropped into a reconnect. This
 * builds a stand-in ffmpeg that opens its output only after a delay, starts
 * a pre-roll, starts the match at once, and checks the recording ends up in
 * the match directory with no drop.
 *
 * The stand-in is compiled to a real executable (`bun build --compile`)
 * because spawn() without a shell can't run a script on Windows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchRecorder } from '../src/matchRecorder.js';
import type { MatchEngine } from '../src/matchEngine.js';
import type { MatchHistoryStore } from '../src/matchHistoryStore.js';
import type { MatchState } from '../src/types.js';

const OPEN_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), 'pfms-recorder-adopt-'));
const recordings = join(root, 'recordings');

// ── Stand-in ffmpeg ─────────────────────────────────────────────────
const fakeSource = join(root, 'fake-ffmpeg.ts');
writeFileSync(
  fakeSource,
  `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) {
  console.log('ffmpeg version fake');
  process.exit(0);
}
const out = args.at(-1)!;
// "Probing" the stream, then opening the output — a missing directory
// fails just as ffmpeg does.
setTimeout(() => {
  try {
    writeFileSync(out, 'x');
  } catch (err) {
    console.error('Error opening output files: ' + (err as Error).message);
    process.exit(1);
  }
}, ${OPEN_DELAY_MS});
// 'q' (or the pipe closing) stops it, as with ffmpeg.
process.stdin.on('data', d => { if (String(d).includes('q')) process.exit(0); });
process.stdin.on('end', () => process.exit(0));
`,
);
const fakeExe = join(root, process.platform === 'win32' ? 'fake-ffmpeg.exe' : 'fake-ffmpeg');
execFileSync(process.execPath, ['build', '--compile', fakeSource, '--outfile', fakeExe], { stdio: 'ignore' });

// ── Recorder against a scripted match engine ────────────────────────
const warnings: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
  warn(...args);
};

let listener: ((state: MatchState) => void) | undefined;
const engine = { addStateListener: (fn: (s: MatchState) => void) => (listener = fn) } as unknown as MatchEngine;
const history = { setRecordings: () => true } as unknown as MatchHistoryStore;

const recorder = new MatchRecorder({
  directory: recordings,
  ffmpegPath: fakeExe,
  ffprobePath: fakeExe,
  getStreams: () => [{ name: 'Field cam', url: 'rtsp://127.0.0.1:1/none', enabled: true }],
  getRetentionDays: () => 30,
  freeBytes: async () => 1e12,
});
await recorder.start(engine, history);

const station = { joined: true, ready: true, teamNumber: 5940, alliance: 'red' };
const state = (over: Partial<MatchState>) =>
  ({
    phase: 'created',
    readyRequested: true,
    stationStates: { slot1: station },
    staffStates: {},
    matchNumber: 1,
    ...over,
  }) as unknown as MatchState;

// Everyone ready: the pre-roll starts...
listener!(state({}));
await sleep(100);
// ...and the match starts well before ffmpeg has opened its output.
const matchId = 'adopt-race-test';
listener!(state({ phase: 'countdown', matchId }));
listener!(state({ phase: 'auto', matchId }));
await sleep(OPEN_DELAY_MS + 1500);

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
};

const matchDir = join(recordings, matchId);
check(
  'no recording dropped while the pre-roll was adopted',
  !warnings.some(w => w.includes('dropped')),
  warnings.join(' | '),
);
check('recording moved under the match id', existsSync(matchDir));
check(
  'its first part is there and nothing is left in a pending- directory',
  existsSync(join(matchDir, 'field-cam.part1.mp4')) && !readdirSync(recordings).some(n => n.startsWith('pending-')),
  readdirSync(recordings).join(', ') + (existsSync(matchDir) ? ` | ${readdirSync(matchDir).join(', ')}` : ''),
);

console.warn = warn;
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
// Exiting closes the stand-in's stdin, which stops it.
setTimeout(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // the stand-in may still hold its exe for a moment on Windows
  }
  process.exit(failures ? 1 : 0);
}, 200);
