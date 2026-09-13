/**
 * End-to-end harness for the match recording/review integration.
 *
 * Runs the REAL MatchEngine, MatchHistoryStore, and match-review HTTP API,
 * broadcasting real match state over a WebSocket exactly like the production
 * server does — only the Driver Stations and radios are absent (team numbers
 * come from a stubbed resolver). The balls-counter e2e script connects to
 * this and exercises recording, review, and score report-back.
 *
 * Run: bun x tsx scripts/e2e-match-harness.ts
 * All state files go to a temp directory; nothing in the repo is touched.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MatchEngine } from '../src/matchEngine.js';
import { MatchHistoryStore } from '../src/matchHistoryStore.js';
import { ApiKeyStore } from '../src/apiKeyStore.js';
import { handleMatchReviewRequest } from '../src/matchReviewApi.js';
import type { ScoringEngine } from '../src/scoringEngine.js';

const PORT = 39871;
const REVIEW_WAIT_MS = 240_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pfms-e2e-'));
  console.log(`harness: state dir ${dir}`);

  const engine = new MatchEngine(station => (station === 'slot1' ? 1234 : station === 'slot4' ? 5678 : null));
  const history = new MatchHistoryStore(path.join(dir, 'match-history.json'));
  // Scoring stub: no scoring hardware in this test — live scores are 0
  const scoringStub = {
    getState: () => ({ red: { elements: {} }, blue: { elements: {} } }),
    getMatchScoreTimeline: () => [{ t: 0, red: 0, blue: 0 }],
    addStateListener: () => () => {},
  } as unknown as ScoringEngine;
  history.attach(engine, scoringStub);
  const apiKeys = new ApiKeyStore(path.join(dir, 'api-keys.json')); // no keys -> open access

  const server = createServer((req, res) => {
    if (handleMatchReviewRequest(req, res, history, apiKeys)) return;
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    console.log('harness: WS client connected');
    ws.send(JSON.stringify(engine.getState()));
  });
  engine.addStateListener(state => {
    const data = JSON.stringify(state);
    wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(data));
  });
  server.listen(PORT, () => console.log(`harness: listening on ${PORT}`));

  const phase = () => engine.getState().phase;
  const waitForPhase = async (want: string, timeoutMs = 120_000) => {
    const start = Date.now();
    while (phase() !== want) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for phase ${want} (at ${phase()})`);
      await sleep(200);
    }
    console.log(`harness: phase -> ${want}`);
  };

  // Wait for the balls-counter side to connect before starting the match so
  // the recording covers the countdown pre-roll
  const connectDeadline = Date.now() + 120_000;
  while (wss.clients.size === 0) {
    if (Date.now() > connectDeadline) throw new Error('no WS subscriber connected within 120s');
    await sleep(250);
  }
  await sleep(1000);

  engine.createMatch();
  engine.joinStationAlliance('slot1', 'red');
  engine.joinStationAlliance('slot4', 'blue');
  engine.setReady('slot1', true);
  engine.setReady('slot4', true);
  engine.startMatch();
  const matchId = engine.getState().matchId;
  console.log(`harness: match started, matchId=${matchId}`);

  await waitForPhase('auto', 15_000);
  await waitForPhase('teleop', 40_000);

  // Exercise pause/resume mid-teleop
  await sleep(4000);
  engine.pauseMatch();
  console.log('harness: paused');
  await sleep(8000);
  engine.resumeMatch();
  console.log('harness: resumed');

  // Shorten the rest of teleop so the test doesn't take 2+ minutes
  await sleep(3000);
  (engine as unknown as { remainingTime: number }).remainingTime = 35;
  await waitForPhase('endgame', 20_000);
  await waitForPhase('postMatch', 45_000);

  // Wait for the recording registration + both alliance reviews to come back
  const start = Date.now();
  let entry;
  while (Date.now() - start < REVIEW_WAIT_MS) {
    entry = history.getState().matches.find(m => m.matchId === matchId);
    if (entry?.reviewUrl && entry.review?.red && entry.review?.blue) break;
    await sleep(1000);
  }

  console.log('harness: final history entry:');
  console.log(JSON.stringify(entry, null, 2));

  const pass = !!(entry?.reviewUrl && entry.review?.red && entry.review?.blue);
  console.log(
    pass
      ? 'HARNESS RESULT: PASS — recording registered and both alliances reviewed'
      : `HARNESS RESULT: FAIL — reviewUrl=${entry?.reviewUrl} review=${JSON.stringify(entry?.review)}`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error('HARNESS RESULT: FAIL —', err);
  process.exit(1);
});
