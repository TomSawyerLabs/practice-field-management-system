// Run by test-team-lock-netns.sh inside its `fw` namespace: applies the team
// lock with the real Linux backend, then checks what laptops and the robot
// can reach.
import { execFile, execFileSync } from 'node:child_process';
const REPO = process.env.REPO ?? new URL('..', import.meta.url).pathname;
const { createLinuxBackend } = await import(`${REPO}/src/node-ip/linux.ts`);
const { TeamAuth } = await import(`${REPO}/src/teamAuth.ts`);
const { TeamLock } = await import(`${REPO}/src/teamLock.ts`);
const { createLockPortal } = await import(`${REPO}/src/teamAuthApi.ts`);

const net = createLinuxBackend();
const auth = new TeamAuth(`/tmp/team-auth-${Date.now()}.json`);
const portal = createLockPortal({ loginBase: () => 'http://pfms.tsl' });
await new Promise<void>(r => portal.listen(8180, r));

const lock = new TeamLock({
  auth,
  net: () => net,
  teamsOnBridges: () => ({ slot1: 1234 }),
  bridgeName: (s: string) => `br-${s}`,
  portalPort: 8180,
  idleMs: () => 12 * 3600_000,
});
auth.onChange(c => c.network && void lock.reconcile());
await lock.activate();

let failures = 0;
function check(name: string, got: string, want: RegExp) {
  const ok = want.test(got);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got.trim().split('\n')[0]}`);
}
// Async: the portal answers from this same process.
function inNs(ns: string, cmd: string[]): Promise<string> {
  return new Promise(resolve =>
    execFile('ip', ['netns', 'exec', ns, ...cmd], { encoding: 'utf8', timeout: 8000 }, (err, stdout, stderr) =>
      resolve(err ? `exit ${(err as { code?: number }).code}: ${stdout + stderr}` : stdout),
    ),
  );
}
const http = (ns: string, url: string) =>
  inNs(ns, ['curl', '-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', url]);
const tcp = (ns: string, port: number) =>
  inNs(ns, ['curl', '-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', `http://10.12.34.2:${port}/`]);
const ping = (ns: string) => inNs(ns, ['ping', '-c', '1', '-W', '2', '10.12.34.2']);

check('no lock: laptop reaches the robot', await http('lap', 'http://10.12.34.2/'), /^200/);

const set = await auth.setPassword(1234, 'gearbox42!', { deviceName: 'Laptop' });
auth.setLock(1234, true);
await lock.reconcile();
console.log(
  execFileSync('iptables-save', { encoding: 'utf8' })
    .split('\n')
    .filter(l => /lock/.test(l))
    .join('\n'),
);

check(
  'locked: HTTP goes to the login page',
  await http('lap', 'http://10.12.34.2/dash?x=1'),
  /^302 http:\/\/pfms\.tsl\/login\?team=1234&return=http%3A%2F%2F10\.12\.34\.2%2Fdash%3Fx%3D1/,
);
check('locked: other TCP is reset at once', await tcp('lap', 5800), /^000|exit/);
check('locked: ping is refused', await ping('lap'), /exit|Prohibited|Unreachable|100% packet loss/i);
check(
  'locked: robot-started flows still work',
  await inNs('rob', ['curl', '-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', 'http://192.168.3.10:9000/']),
  /^200/,
);

if (!set || !('token' in set)) throw new Error('no device');
auth.bindAddress(1234, set.device.id, '192.168.3.10');
await lock.reconcile();
check('bound laptop reaches the robot web page', await http('lap', 'http://10.12.34.2/'), /^200/);
check('bound laptop reaches other ports', await tcp('lap', 5800), /^200/);
check('bound laptop can ping', await ping('lap'), /1 received/);
check('the other laptop is still refused', await tcp('lap2', 5800), /^000|exit/);
check('the other laptop still goes to login', await http('lap2', 'http://10.12.34.2/'), /^302/);

await lock.poll();
const seen = auth.listDevices(1234)[0]?.addressSeenAt;
check('traffic counters keep the binding alive', String(seen && Date.now() - seen < 5000), /true/);

// Moving the binding cuts the old address at once.
auth.bindAddress(1234, set.device.id, '192.168.3.11');
await lock.reconcile();
check('after moving, the old address is refused', await tcp('lap', 5800), /^000|exit/);
check('after moving, the new address gets through', await tcp('lap2', 5800), /^200/);

auth.setLock(1234, false);
await lock.reconcile();
check('unlocked: everyone reaches the robot', await tcp('lap', 5800), /^200/);
const left = execFileSync('iptables-save', { encoding: 'utf8' })
  .split('\n')
  .filter(l => /lock/.test(l));
check('unlocked: no lock rules or chains left', String(left.length), /^0$/);

auth.setLock(1234, true);
await lock.reconcile();
await lock.removeAll();
const after = execFileSync('iptables-save', { encoding: 'utf8' })
  .split('\n')
  .filter(l => /lock/.test(l));
check('removeAll leaves nothing', String(after.length), /^0$/);

portal.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
