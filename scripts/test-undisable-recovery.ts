/**
 * Engine-level test for mid-match stop recovery (`bun scripts/test-undisable-recovery.ts`).
 *
 * Replays the 2026-07-19 team-1678 incident (station-console E-Stop 10s into
 * auto latched the robot out for the whole match) and verifies every recovery
 * path added afterwards:
 *   - e-stop survives the teleop transition, then clear + re-enable works
 *   - re-enable in teleop re-stamps mode (a robot stopped in auto must not
 *     re-run its auto routine)
 *   - DS-reported disables latch, but not inside the post-enable grace window
 *   - teams can self-recover from 'ds'/'self' disables but not 'admin' ones
 *   - A-Stop cannot be bypassed via re-enable and still releases at teleop
 *
 * Runs against MatchEngine directly — no sockets, no DS needed. Uses short
 * unofficial durations (private-field poke) so the whole run is ~12s.
 */
import { MatchEngine } from '../src/matchEngine.js';
import type { StationName } from '../src/types.js';

const engine = new MatchEngine(station => (station === 'slot3' ? 1678 : station === 'slot1' ? 5940 : null));

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

function station(name: StationName) {
  const s = engine.getState().stationStates[name];
  if (!s) throw new Error(`no state for ${name}`);
  return s;
}

function phase() {
  return engine.getState().phase;
}

function waitFor(desc: string, pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${desc} (phase=${phase()})`));
      }
    }, 50);
  });
}

/** Expire the post-enable grace window so a DS disable report is honored. */
function expireGrace(name: StationName) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (engine as any).lastFmsEnable.set(name, Date.now() - 10_000);
}

engine.createMatch();
// Short durations for the test run — the public API only accepts official ones
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(engine as any).pendingConfig = {
  autoDuration: 2,
  teleopDuration: 4,
  endgameDuration: 2,
  pauseDuration: 1,
  skipAuto: false,
  autoWinner: 'red',
};
engine.joinStationAlliance('slot3', 'red');
engine.joinStationAlliance('slot1', 'blue');

// Re-enable is refused before the match starts
engine.undisable('slot3', false);
check('undisable refused in created phase', !station('slot3').enabled);

engine.setReady('slot3', true);
engine.setReady('slot1', true);
engine.startMatch();

await waitFor('auto', () => phase() === 'auto');
check('slot3 enabled in auto', station('slot3').enabled && station('slot3').mode === 'auto');

// ── The 1678 incident: console E-Stop 10s into auto ──────────────────
engine.stationEStop('slot3', 'staff');
check('e-stop latched, robot disabled', station('slot3').eStop && !station('slot3').enabled);

// A-Stop on the other robot: must not be bypassable via re-enable
engine.stationAStop('slot1');
engine.undisable('slot1', false);
check('undisable refused while a-stopped', !station('slot1').enabled && station('slot1').aStop);

await waitFor('teleop', () => phase() === 'teleop');
check('e-stop survives teleop transition (1678 bug)', station('slot3').eStop && !station('slot3').enabled);
check('a-stop released at teleop, robot re-enabled', !station('slot1').aStop && station('slot1').enabled);
check('re-enabled a-stop robot is in teleOp mode', station('slot1').mode === 'teleOp');

// ── Recovery path: staff clears the e-stop, team re-enables ──────────
engine.undisable('slot3', false);
check('undisable refused while e-stopped', !station('slot3').enabled);
engine.clearEStop('slot3');
check('cleared e-stop leaves robot disabled', !station('slot3').eStop && !station('slot3').enabled);
engine.undisable('slot3', false);
check('re-enable after cleared e-stop', station('slot3').enabled);
check('re-enable in teleop stamps teleOp mode (not auto)', station('slot3').mode === 'teleOp');

// ── DS disable: grace window, then latch, then self-recovery ─────────
engine.dsReportedStatus('slot3', false, false, false);
check('DS disable ignored inside post-enable grace', station('slot3').enabled);
expireGrace('slot3');
engine.dsReportedStatus('slot3', false, false, false);
check('DS disable latches after grace', !station('slot3').enabled && station('slot3').disabledBy === 'ds');
engine.undisable('slot3', false);
check('team self-recovers from DS disable', station('slot3').enabled);

// ── Console self-disable is also recoverable ─────────────────────────
engine.stationDisable('slot3', 'self');
check('self disable latches', !station('slot3').enabled && station('slot3').disabledBy === 'self');
engine.undisable('slot3', false);
check('team self-recovers from console disable', station('slot3').enabled);

// ── Admin disable needs the admin console to lift ────────────────────
engine.stationDisable('slot3', 'admin');
check('admin disable latches', !station('slot3').enabled && station('slot3').disabledBy === 'admin');
engine.undisable('slot3', false);
check('team cannot lift an admin disable', !station('slot3').enabled);
engine.undisable('slot3', true);
check('admin re-enable lifts it', station('slot3').enabled && station('slot3').disabledBy === null);

await waitFor('postMatch', () => phase() === 'postMatch');
engine.undisable('slot3', false);
check('undisable refused in postMatch', !station('slot3').enabled);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
