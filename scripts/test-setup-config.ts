/**
 * Verify the setup wizard's persistence and resumability
 * (`bun scripts/test-setup-config.ts`).
 *
 * The behaviour that matters: you can get partway through setup, kill the
 * process, come back, and land on the next unfinished step with your earlier
 * answers intact. Uses a scratch file so it never touches a real deployment.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { SetupConfigStore, clearSetupConfig } from '../src/setupConfigStore.js';

const FILE = 'setup-config.test.json';
if (existsSync(FILE)) unlinkSync(FILE);

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// ── A fresh install starts at the beginning ─────────────────────────
const first = new SetupConfigStore(FILE);
check('fresh install starts at the first step', first.nextStep() === 'host');
check('fresh install is not complete', !first.isComplete());

// ── Answer a couple of steps, then "die" ────────────────────────────
first.markStep('host', 'done');
first.markStep('admin', 'done');
first.updateSettings({ vlanInterface: 'eno1', radioUrl: 'http://10.0.100.2' });
first.markStep('interfaces', 'done');
check('advances to the next unfinished step', first.nextStep() === 'fieldControl');

// ── Restart: a new store reading the same file ──────────────────────
const resumed = new SetupConfigStore(FILE);
check('resumes at the next unfinished step', resumed.nextStep() === 'fieldControl');
check('remembers earlier answers', resumed.get().settings.vlanInterface === 'eno1');
check('remembers step status', resumed.get().steps.host?.status === 'done');

// ── Settings beat the environment, and report their source ──────────
process.env.VLAN_INTERFACE = 'eth9';
const fromSetup = resumed.resolveSetting('vlanInterface', 'VLAN_INTERFACE');
check('stored setting wins over env', fromSetup.value === 'eno1' && fromSetup.source === 'setup');

const fromEnv = resumed.resolveSetting('fmsAddress', 'PFMS_TEST_FMS_ADDRESS');
check('falls back to default when neither is set', fromEnv.value === undefined && fromEnv.source === 'default');

process.env.PFMS_TEST_FMS_ADDRESS = '10.0.100.5';
const envWins = resumed.resolveSetting('fmsAddress', 'PFMS_TEST_FMS_ADDRESS');
check('env is used when nothing is stored', envWins.value === '10.0.100.5' && envWins.source === 'env');

// These two are exactly how src/index.ts resolves them at startup, so this
// covers the real code path rather than a parallel copy of the rule.
process.env.RADIO_URL = 'http://10.99.99.99';
resumed.updateSettings({ radioUrl: 'http://10.88.88.88' });
check(
  'radio URL: saved setting beats the env var (as index.ts resolves it)',
  (resumed.resolveSetting('radioUrl', 'RADIO_URL').value ?? 'http://10.0.100.2') === 'http://10.88.88.88',
);

resumed.updateSettings({ radioUrl: undefined });
check(
  'radio URL: falls back to env once the setting is cleared',
  resumed.resolveSetting('radioUrl', 'RADIO_URL').value === 'http://10.99.99.99',
);

delete process.env.RADIO_URL;
check(
  'radio URL: falls back to the built-in default',
  (resumed.resolveSetting('radioUrl', 'RADIO_URL').value ?? 'http://10.0.100.2') === 'http://10.0.100.2',
);

// ── Skipping counts as finishing, so the wizard can complete ────────
for (const step of ['fieldControl', 'radio', 'teamVlans', 'audio', 'deployment'] as const) {
  resumed.markStep(step, 'done');
}
check('still incomplete with one step left', !resumed.isComplete());
resumed.markStep('scoreboard', 'skipped');
check('a skipped step does not block completion', resumed.isComplete());
check('completion is stamped', resumed.get().completedAt !== undefined);

// ── Re-opening a step re-opens the wizard ───────────────────────────
resumed.markStep('radio', 'pending');
check('re-opening a step reopens the wizard', resumed.nextStep() === 'radio');
check('completion stamp is cleared', resumed.get().completedAt === undefined);

// ── A step whose checks all pass is done without a click ────────────
const auto = new SetupConfigStore(FILE + '.auto');
auto.markStep('audio', 'skipped');
const changed = auto.markPassingStepsDone([
  { id: 'host', status: 'pass' },
  { id: 'admin', status: 'fail' },
  { id: 'interfaces', status: 'warn' },
  { id: 'audio', status: 'pass' },
]);
check('a passing step is marked done', changed && auto.get().steps.host?.status === 'done');
check('a failing or warning step is left alone', !auto.get().steps.admin && !auto.get().steps.interfaces);
check('a skipped step stays skipped', auto.get().steps.audio?.status === 'skipped');
check('nothing to do reports no change', !auto.markPassingStepsDone([{ id: 'host', status: 'pass' }]));
clearSetupConfig(FILE + '.auto');

// ── Clearing starts over ────────────────────────────────────────────
check('clear removes the file', clearSetupConfig(FILE) === FILE);
check('clear is idempotent', clearSetupConfig(FILE) === null);
check('a store after clearing starts fresh', new SetupConfigStore(FILE).nextStep() === 'host');

if (existsSync(FILE)) unlinkSync(FILE);
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
