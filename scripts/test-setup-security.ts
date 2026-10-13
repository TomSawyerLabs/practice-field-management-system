/**
 * Prove the setup wizard can't be used to redirect the radio
 * (`bun scripts/test-setup-security.ts`).
 *
 * Why this exists: `radioUrl` decides where station configurations are POSTed,
 * and those payloads contain every team's plaintext WPA key
 * (`radioManager.ts` buildRadioStationConfig). The setup screen is
 * deliberately reachable without a passphrase on a fresh install, so the
 * message that writes settings has to refuse anything that could point the
 * radio manager at an attacker — and has to stop accepting writes at all once
 * the field has been claimed with an admin passphrase.
 */
import { isUpdateSetupSettings, isPrivateHostUrl, settingsPatchFromWire } from '../src/types.js';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const update = (settings: unknown) => isUpdateSetupSettings({ type: 'updateSetupSettings', settings });

// ── Addresses a field radio can legitimately live at ────────────────
for (const url of [
  'http://10.0.100.2',
  'http://192.168.69.1',
  'http://172.16.4.4:8080',
  'http://127.0.0.1:8889',
  'http://localhost:3000',
  'http://169.254.1.1',
]) {
  check(`accepts private address ${url}`, isPrivateHostUrl(url));
}

// ── Exfiltration targets ────────────────────────────────────────────
for (const url of [
  'http://8.8.8.8',
  'https://evil.example.com',
  'http://attacker.test/collect',
  // A hostname is refused even when it currently resolves somewhere private:
  // DNS can be repointed after the check.
  'http://radio.local',
  'http://10.0.100.2.evil.com',
  'file:///etc/passwd',
  'gopher://10.0.100.2',
  'javascript:alert(1)',
  'not a url',
]) {
  check(`refuses ${url}`, !isPrivateHostUrl(url));
}

// ── The message guard as a whole ────────────────────────────────────
check('accepts a legitimate radio URL', update({ radioUrl: 'http://10.0.100.2' }));
check('refuses a public radio URL', !update({ radioUrl: 'http://evil.example.com' }));
check('refuses a public video proxy', !update({ videoProxyTarget: 'https://evil.example.com' }));
check('refuses unknown keys entirely', !update({ radioUrl: 'http://10.0.100.2', __proto__: 'x', evil: 1 }));
check('refuses a wrong-typed known key', !update({ deploymentMode: 'kubernetes' }));
check('refuses a non-boolean confirmation', !update({ castVerified: 'yes' }));
check('refuses an interface name with shell characters', !update({ vlanInterface: 'eno1; rm -rf /' }));
check('accepts a normal interface name', update({ vlanInterface: 'eno1.100' }));
check('accepts null, which clears a setting', update({ vlanInterface: null, radioUrl: null }));
check(
  'null arrives as a clear',
  JSON.stringify(settingsPatchFromWire({ vlanInterface: null, radioUrl: 'http://10.0.100.2' })) ===
    JSON.stringify({ radioUrl: 'http://10.0.100.2' }) &&
    'vlanInterface' in settingsPatchFromWire({ vlanInterface: null }),
);
check('allows clearing a setting', update({ radioUrl: undefined }));

// A partially-valid payload must be rejected outright, not half-applied.
check(
  'refuses the whole message when one field is bad',
  !update({ deploymentMode: 'systemd', radioUrl: 'http://evil.example.com' }),
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
