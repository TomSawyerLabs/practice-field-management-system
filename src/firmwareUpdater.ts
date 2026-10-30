import type { FirmwareUpdateProgress } from './types.js';
import { teamSubnet } from './utils.js';
import type { FirmwareStore } from './firmwareStore.js';
import { fetchOnInterface, type HttpReply } from './interfaceFetch.js';
import { hashWpaKey } from './wpaKeyUtils.js';

// ── Radio status type ───────────────────────────────────────────────

interface RadioStatus {
  mode?: string;
  teamNumber?: number;
  ssidSuffix?: string;
  version?: string;
  networkStatus6?: { hashedWpaKey?: string; wpaKeySalt?: string };
  networkStatus24?: { hashedWpaKey?: string; wpaKeySalt?: string };
}

/** How long a request to the radio gets, unless it says otherwise. */
const REQUEST_TIMEOUT_MS = 5_000;

// ── Helpers ─────────────────────────────────────────────────────────

/** Wait for a URL to become reachable, polling every `intervalMs`. */
async function waitForHost(ifname: string, url: string, timeoutMs: number, intervalMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchOnInterface(ifname, url, {}, 2000);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Firmware Update ─────────────────────────────────────────────────

export type ProgressCallback = (progress: Omit<FirmwareUpdateProgress, 'type' | 'elapsedMs'>) => void;

/**
 * Run the full firmware update process for a robot radio:
 * 1. Verify WPA key against current radio config
 * 2. Get firmware binary from the store
 * 3. Upload firmware to radio
 * 4. Wait for radio to reboot
 * 5. Re-apply configuration (teamNumber, ssidSuffix, WPA keys)
 * 6. Verify radio comes back with correct config
 *
 * Every request stays on `ifname`, the tester's port. By the routing table, one
 * could write to this team's robot on a station instead.
 */
export async function updateRadioFirmware(
  team: number,
  ifname: string,
  wpaKey: string | undefined,
  wpaKey24: string | undefined,
  skipReconfigure: boolean,
  store: FirmwareStore,
  onProgress: ProgressCallback,
): Promise<void> {
  const radioIp = `${teamSubnet(team)}.1`;
  const radioUrl = `http://${radioIp}`;

  // Step 1: Fetch current status and verify WPA key (if reconfiguring)
  onProgress({ step: 'verifying', message: 'Checking radio status...', progress: 5 });

  let status: RadioStatus;
  try {
    const res = await fetchOnInterface(ifname, `${radioUrl}/status`, {}, REQUEST_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Radio returned HTTP ${res.status}`);
    status = (await res.json()) as RadioStatus;
  } catch (err) {
    throw new Error(`Cannot reach radio at ${radioIp}: ${err instanceof Error ? err.message : err}`);
  }

  if (!status.version) throw new Error('Radio did not report a firmware version');
  if (!store.needsUpdate(status.version)) {
    throw new Error(`Radio is already at firmware ${status.version} — no update needed`);
  }

  const savedConfig = {
    teamNumber: status.teamNumber,
    ssidSuffix: status.ssidSuffix ?? '',
  };

  if (!skipReconfigure) {
    if (!wpaKey) throw new Error('WPA passphrase required for reconfiguration');
    let keyVerified = false;
    for (const band of [status.networkStatus6, status.networkStatus24]) {
      if (band?.hashedWpaKey && band?.wpaKeySalt) {
        if (hashWpaKey(wpaKey, band.wpaKeySalt) === band.hashedWpaKey) {
          keyVerified = true;
          break;
        }
      }
    }
    if (!keyVerified) {
      throw new Error('WPA passphrase does not match the current radio configuration');
    }
    onProgress({
      step: 'verifying',
      message: `Verified: team ${savedConfig.teamNumber}, suffix "${savedConfig.ssidSuffix}"`,
      progress: 10,
    });
  } else {
    onProgress({
      step: 'verifying',
      message: `Firmware-only update (skip reconfiguration). Current: team ${savedConfig.teamNumber}`,
      progress: 10,
    });
  }

  // Step 2: Get firmware binary from the store
  const firmware = store.getFirmwareForRadio(status.version);
  if (!firmware?.filePath) {
    throw new Error(
      'Firmware file not available locally. Download it from the admin page or check your internet connection.',
    );
  }

  onProgress({ step: 'downloading', message: `Using cached firmware v${firmware.version}`, progress: 25 });

  // Step 3: Upload firmware to radio
  onProgress({ step: 'uploading', message: 'Uploading firmware to radio...', progress: 30 });

  let uploadRes: HttpReply;
  try {
    uploadRes = await fetchOnInterface(
      ifname,
      `${radioUrl}/firmware`,
      {
        method: 'POST',
        form: { file: { path: firmware.filePath, filename: 'firmware.img.enc' }, checksum: firmware.checksum },
      },
      60_000,
    );
  } catch (err) {
    throw new Error(`Firmware upload failed: ${err instanceof Error ? err.message : err}`);
  }

  if (uploadRes.status !== 202) {
    const body = await uploadRes.text();
    throw new Error(`Firmware upload rejected (HTTP ${uploadRes.status}): ${body}`);
  }

  onProgress({ step: 'flashing', message: 'Radio is flashing firmware...', progress: 40 });

  // Step 4: Wait for radio to come back
  onProgress({ step: 'waiting_reboot', message: 'Waiting for radio to reboot (up to 3 minutes)...', progress: 50 });

  const teamUrl = `http://${radioIp}/status`;
  const factoryUrl = 'http://192.168.69.1/status';

  let rebootedToFactory = false;
  const rebootDeadline = Date.now() + 180_000;

  await new Promise(r => setTimeout(r, 10_000));

  while (Date.now() < rebootDeadline) {
    try {
      const res = await fetchOnInterface(ifname, teamUrl, {}, 2000);
      if (res.ok) {
        rebootedToFactory = false;
        break;
      }
    } catch {
      // Not ready
    }
    try {
      const res = await fetchOnInterface(ifname, factoryUrl, {}, 2000);
      if (res.ok) {
        rebootedToFactory = true;
        break;
      }
    } catch {
      // Not ready
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  if (Date.now() >= rebootDeadline) {
    throw new Error('Radio did not come back after firmware update (3 minute timeout)');
  }

  onProgress({
    step: 'waiting_reboot',
    message: rebootedToFactory ? 'Radio rebooted to factory defaults' : 'Radio rebooted with config intact',
    progress: 65,
  });

  if (skipReconfigure) {
    const verifyUrl = rebootedToFactory ? factoryUrl : teamUrl;
    let message = 'Firmware flashed. Radio may need manual configuration.';
    try {
      const res = await fetchOnInterface(ifname, verifyUrl, {}, REQUEST_TIMEOUT_MS);
      if (res.ok) {
        const newStatus = (await res.json()) as RadioStatus;
        const newVersion = newStatus.version ?? 'unknown';
        message = `Firmware updated to ${newVersion}. Radio is in ${rebootedToFactory ? 'factory default' : 'configured'} state.`;
      }
    } catch {
      // Not reachable right now, so the flash itself is all we can report
    }
    onProgress({ step: 'complete', message, progress: 100 });
    return;
  }

  // Step 5: Re-apply configuration
  onProgress({
    step: 'reconfiguring',
    message: `Reconfiguring radio for team ${savedConfig.teamNumber}...`,
    progress: 70,
  });

  const configUrl = rebootedToFactory ? 'http://192.168.69.1/configuration' : `${radioUrl}/configuration`;
  const configBody = {
    mode: 'TEAM_ROBOT_RADIO',
    teamNumber: savedConfig.teamNumber,
    ssidSuffix: savedConfig.ssidSuffix,
    wpaKey6: wpaKey,
    wpaKey24: wpaKey24 || wpaKey,
    channel: 0,
  };

  try {
    const res = await fetchOnInterface(
      ifname,
      configUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configBody),
      },
      15_000,
    );
    if (res.status !== 202) {
      const body = await res.text();
      throw new Error(`Configuration rejected (HTTP ${res.status}): ${body}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Configuration rejected')) throw err;
    throw new Error(`Failed to reconfigure radio: ${err instanceof Error ? err.message : err}`);
  }

  // Step 6: Wait for radio to come back at team IP with new firmware
  onProgress({ step: 'verifying_config', message: 'Waiting for radio to apply configuration...', progress: 80 });

  const configReady = await waitForHost(ifname, teamUrl, 120_000, 3000);
  if (!configReady) {
    throw new Error('Radio did not come back at team IP after reconfiguration (2 minute timeout)');
  }

  try {
    const res = await fetchOnInterface(ifname, teamUrl, {}, REQUEST_TIMEOUT_MS);
    if (!res.ok) throw new Error(`radio returned HTTP ${res.status}`);
    const newStatus = (await res.json()) as RadioStatus;
    const newVersion = newStatus.version ?? 'unknown';
    if (store.needsUpdate(newVersion)) {
      throw new Error(`Firmware update may have failed — radio reports version ${newVersion}`);
    }
    onProgress({
      step: 'complete',
      message: `Firmware updated to ${newVersion}. Team ${newStatus.teamNumber}, SSID suffix "${newStatus.ssidSuffix}"`,
      progress: 100,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Firmware update may have failed')) throw err;
    throw new Error(`Cannot verify radio after update: ${err instanceof Error ? err.message : err}`);
  }
}
