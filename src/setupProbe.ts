/**
 * Read-only environment probe for the setup wizard.
 *
 * Answers "what's wrong with this host right now" as structured data, in the
 * order a new deployer has to fix things: can we run at all → is there a NIC
 * we can trunk → is field control reachable → is the radio there → are the
 * team VLANs up. The wizard renders this directly, and it re-runs on an
 * interval so a step lights up the moment the operator fixes it.
 *
 * This module NEVER changes the host. Every failing check carries the exact
 * command that would fix it, for the UI to show (and, later, to offer to run
 * on an explicit click). Keeping observation and mutation separate is what
 * makes it safe to run this continuously.
 */
import { execFile } from 'node:child_process';
import { OPTIONAL_TOOLS, REQUIRED_TOOLS, aptInstallCommand, hasTool } from './hostTools.js';
import { SYSTEMD_UNIT } from './systemdService.js';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundledPath } from './assetRoot.js';
import { SOUND_NAMES } from './matchAudio.js';
import { FIELD_CONTROL_ADDRESS, isValidRawRadioUpdate, translateRadioUpdate } from './types.js';
import { detectFirmwareMode } from './startupChecks.js';
import { createBackend, createDryRunBackend, type NetworkBackend } from './node-ip/index.js';
import type { SetupCheck, SetupProbeState, SetupStepId, SetupStep, DeploymentMode } from './types.js';

const execFileAsync = promisify(execFile);

const SOUNDS_DIR = bundledPath('sounds');
const AUDIO_CONFIG_FILE = 'audio-config.json';

function pass(id: string, label: string, detail: string): SetupCheck {
  return { id, label, status: 'pass', detail };
}
function fail(id: string, label: string, detail: string, fix?: string): SetupCheck {
  return { id, label, status: 'fail', detail, fix };
}
function warn(id: string, label: string, detail: string, fix?: string): SetupCheck {
  return { id, label, status: 'warn', detail, fix };
}

// ── Step probes ─────────────────────────────────────────────────────

async function probeHost(): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  const os = platform();
  checks.push(
    os === 'linux'
      ? pass('platform', 'Operating system', 'Linux — VLAN and routing management supported')
      : fail(
          'platform',
          'Operating system',
          `${os} has no supported networking layer. pFMS can run here for development only.`,
          'Set DRY_RUN=1 to explore the UI without touching the network, or deploy on Linux.',
        ),
  );

  // getuid is undefined on Windows, hence the optional call.
  const uid = process.getuid?.();
  if (uid === undefined) {
    checks.push(warn('root', 'Privileges', 'Cannot determine user on this platform'));
  } else if (uid === 0) {
    checks.push(pass('root', 'Privileges', 'Running as root — can manage VLANs, addresses, and iptables'));
  } else {
    checks.push(
      fail(
        'root',
        'Privileges',
        `Running as uid ${uid}. Creating VLANs and iptables rules needs root.`,
        'Run the service as root (the systemd unit has no User=, so it already is).',
      ),
    );
  }

  const missingRequired: string[] = [];
  for (const tool of REQUIRED_TOOLS) {
    if (!(await hasTool(tool))) missingRequired.push(tool);
  }
  checks.push(
    missingRequired.length === 0
      ? pass('tools', 'Required tools', `All present: ${REQUIRED_TOOLS.join(', ')}`)
      : fail(
          'tools',
          'Required tools',
          `Missing: ${missingRequired.join(', ')}. pFMS can't run the field network without these — install them below, or yourself with:`,
          aptInstallCommand(missingRequired),
        ),
  );

  const missingOptional: [string, string][] = [];
  for (const [tool, why] of OPTIONAL_TOOLS) {
    if (!(await hasTool(tool))) missingOptional.push([tool, why]);
  }
  if (missingOptional.length > 0) {
    checks.push(
      warn(
        'optional-tools',
        'Optional tools',
        missingOptional.map(([t, why]) => `${t} missing — ${why} won't work`).join('; ') +
          '. Install below, or yourself with:',
        aptInstallCommand(missingOptional.map(([t]) => t)),
      ),
    );
  } else {
    checks.push(pass('optional-tools', 'Optional tools', 'Audio and robot-tester tooling present'));
  }

  return checks;
}

/** Interfaces that could plausibly carry the VLAN trunk. */
function trunkCandidates(interfaces: InterfaceLike[]): InterfaceLike[] {
  return interfaces.filter(
    i =>
      i.name !== 'lo' &&
      // Sub-interfaces and bridges are things we create, not things to trunk on
      i.link?.vlanId === undefined &&
      i.link?.kind !== 'bridge' &&
      !i.name.startsWith('br-') &&
      !i.name.includes('.'),
  );
}

type InterfaceLike = Awaited<ReturnType<NetworkBackend['listInterfaces']>>[number];

/** What pFMS is actually running the field network on, as opposed to the
 *  setting — they differ while a change is applied, or when it failed. */
export interface TrunkRuntime {
  active?: string;
  problem?: string | null;
}

async function probeInterfaces(
  net: NetworkBackend,
  vlanInterface: string | undefined,
  runtime: TrunkRuntime,
): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  let interfaces: InterfaceLike[];
  try {
    interfaces = await net.listInterfaces();
  } catch (err) {
    return [
      fail('list', 'Network interfaces', `Could not list interfaces: ${err instanceof Error ? err.message : err}`),
    ];
  }

  const candidates = trunkCandidates(interfaces);
  checks.push(
    candidates.length > 0
      ? pass('candidates', 'Available interfaces', candidates.map(i => `${i.name} (${i.state})`).join(', '))
      : fail('candidates', 'Available interfaces', 'No physical interface found to carry the VLAN trunk'),
  );

  if (!vlanInterface) {
    checks.push(
      fail(
        'selected',
        'Trunk interface',
        candidates.length > 0
          ? `No trunk interface chosen yet, so pFMS isn't running the field network. Pick one below (${candidates[0].name} is the likeliest).`
          : "No trunk interface chosen yet, so pFMS isn't running the field network.",
      ),
    );
    return checks;
  }

  const selected = interfaces.find(i => i.name === vlanInterface);
  if (!selected) {
    checks.push(
      fail(
        'selected',
        'Trunk interface',
        `${vlanInterface} isn't an interface on this host.` +
          (candidates.length > 0 ? ` Pick one of: ${candidates.map(i => i.name).join(', ')}.` : ''),
      ),
    );
    return checks;
  }

  // pFMS sets the link up itself when it sets up the field network, so a
  // link still down means no cable or no carrier — nothing to run.
  checks.push(
    selected.state === 'UP'
      ? pass('selected', 'Trunk interface', `${selected.name} is up`)
      : warn(
          'selected',
          'Trunk interface',
          `${selected.name} is ${selected.state}: check its cable to the switch — nothing reaches the radio while it's down`,
        ),
  );

  checks.push(
    runtime.active === vlanInterface
      ? pass('running', 'Field network', `pFMS is running the field network on ${vlanInterface}`)
      : runtime.problem
        ? fail(
            'running',
            'Field network',
            `pFMS couldn't set up the field network on ${vlanInterface}: ${runtime.problem}. It retries every 30 seconds.`,
          )
        : warn('running', 'Field network', `pFMS is setting up the field network on ${vlanInterface}…`),
  );

  return checks;
}

async function probeFieldControl(
  net: NetworkBackend,
  vlanInterface: string | undefined,
  fieldControlInterface: string | undefined,
): Promise<SetupCheck[]> {
  if (!vlanInterface) {
    return [warn('address', 'Field control address', 'Waiting on a trunk interface selection')];
  }
  // Field control is the trunk's native VLAN unless it has its own interface.
  const expected = fieldControlInterface ?? vlanInterface;

  let interfaces: InterfaceLike[];
  try {
    interfaces = await net.listInterfaces();
  } catch (err) {
    return [
      fail('address', 'Field control address', `Could not read addresses: ${err instanceof Error ? err.message : err}`),
    ];
  }

  const target = interfaces.find(i => i.name === expected);
  if (target?.addresses.some(a => a.address === FIELD_CONTROL_ADDRESS)) {
    return [pass('address', 'Field control address', `${FIELD_CONTROL_ADDRESS} is on ${expected}`)];
  }

  // The address on some other interface: someone (netplan, an earlier
  // setting) put it there, and it will fight the one pFMS adds.
  const elsewhere = interfaces.find(
    i => i.name !== expected && i.addresses.some(a => a.address === FIELD_CONTROL_ADDRESS),
  );
  if (elsewhere) {
    return [
      fail(
        'address',
        'Field control address',
        `${FIELD_CONTROL_ADDRESS} is on ${elsewhere.name}, not on ${expected}. ` +
          (fieldControlInterface
            ? `pFMS puts it on the field-control interface, ${expected}.`
            : `pFMS puts it on the bare trunk interface, so field control is the native (untagged) VLAN there. If your switch tags field control on that port, set the field-control interface to ${elsewhere.name}.`),
        fieldControlInterface
          ? `Remove ${FIELD_CONTROL_ADDRESS} from ${elsewhere.name}`
          : `Set the field-control interface to ${elsewhere.name}, or make field control the native VLAN on the ${vlanInterface} switch port`,
      ),
    ];
  }

  // Deliberately not offering `ip addr add` here: pFMS assigns this itself
  // when it sets up the field network (checkInterfaceIps). If it's missing,
  // the cause is upstream — the field network isn't up (see the step above)
  // or pFMS isn't running as root — and adding it by hand would paper over it.
  return [
    fail(
      'address',
      'Field control address',
      `${FIELD_CONTROL_ADDRESS} is not on ${expected}. pFMS adds it when it sets up the field network, so if it's missing the field network isn't up yet (see Interfaces) or pFMS isn't running as root.`,
    ),
  ];
}

async function probeRadio(radioUrl: string): Promise<SetupCheck[]> {
  try {
    const response = await fetch(`${radioUrl}/status`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const raw: unknown = await response.json();
    if (!isValidRawRadioUpdate(raw)) {
      return [warn('reachable', 'Radio', `${radioUrl} answered, but not with a radio status payload`)];
    }
    const data = translateRadioUpdate(raw);

    const mode = detectFirmwareMode(data.version);
    const checks: SetupCheck[] = [pass('reachable', 'Radio', `Reachable at ${radioUrl} — ${data.version}`)];

    checks.push(
      mode === 'PRACTICE' || mode === 'OFFSEASON'
        ? pass('firmware', 'Firmware mode', `${mode}${mode === 'OFFSEASON' ? ' — pFMS serves DHCP per VLAN' : ''}`)
        : warn(
            'firmware',
            'Firmware mode',
            `${mode} firmware. pFMS supports PRACTICE (recommended) and OFFSEASON.`,
            'Flash PRACTICE or OFFSEASON firmware from frc-radio.vivid-hosting.net',
          ),
    );

    const configured = Object.entries(data.stationStatuses ?? {})
      .filter(([, s]) => s && typeof s === 'object' && 'ssid' in s && s.ssid)
      .map(([station]) => station);
    checks.push(
      pass(
        'existing-config',
        'Existing configuration',
        configured.length > 0 ? `Stations already configured: ${configured.join(', ')}` : 'No stations configured yet',
      ),
    );

    return checks;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      fail(
        'reachable',
        'Radio',
        `No answer from ${radioUrl} (${msg}). The radio is reached over field control, so check the Interfaces and Field control steps above first.`,
      ),
    ];
  }
}

async function probeTeamVlans(net: NetworkBackend, vlanInterface: string | undefined): Promise<SetupCheck[]> {
  if (!vlanInterface) {
    return [warn('vlans', 'Team VLANs', 'Waiting on a trunk interface selection')];
  }

  try {
    const interfaces = await net.listInterfaces();
    const subs = interfaces.filter(i => i.link?.parent === vlanInterface && i.link?.vlanId !== undefined);
    const bridges = interfaces.filter(i => i.name.startsWith('br-slot'));

    if (subs.length === 0 && bridges.length === 0) {
      // Nothing to do by hand here — pFMS creates every sub-interface, bridge
      // and membership itself whenever a station config is committed.
      return [
        warn(
          'vlans',
          'Team VLANs',
          'None yet. pFMS creates these itself — assign a team to a station from the home page and they appear.',
          'Assign a team to a station',
        ),
      ];
    }

    return [
      pass(
        'vlans',
        'Team VLANs',
        `${subs.length} VLAN sub-interface(s), ${bridges.length} bridge(s): ${[...subs, ...bridges].map(i => i.name).join(', ')}`,
      ),
    ];
  } catch (err) {
    return [fail('vlans', 'Team VLANs', `Could not inspect: ${err instanceof Error ? err.message : err}`)];
  }
}

/** Audio readiness. The wizard pairs this with a "play a test sound" button —
 *  a check can prove a player exists, but only a human can confirm the field
 *  speaker actually made a noise. */
async function probeAudio(audioVerified: boolean): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  const players = ['aplay', 'paplay', 'ffplay', 'mpv', 'play'];
  const found: string[] = [];
  for (const player of players) {
    if (await hasTool(player)) found.push(player);
  }
  checks.push(
    found.length > 0
      ? pass('player', 'Audio player', `Available: ${found.join(', ')}`)
      : fail(
          'player',
          'Audio player',
          'No audio player found, so the field speaker will stay silent for every match cue.',
          'sudo apt install alsa-utils',
        ),
  );

  const missingSounds = SOUND_NAMES.filter(name => !existsSync(resolve(SOUNDS_DIR, `${name}.wav`)));
  checks.push(
    missingSounds.length === 0
      ? pass('files', 'Sound files', `All ${SOUND_NAMES.length} clips present`)
      : warn(
          'files',
          'Sound files',
          `Missing: ${missingSounds.join(', ')}. Those transitions are silent (everything else still plays).`,
          'bun scripts/generate-sounds.ts',
        ),
  );

  // The device picker writes this; without a selection the server plays nothing.
  const deviceConfigured = existsSync(AUDIO_CONFIG_FILE);
  checks.push(
    deviceConfigured
      ? pass('device', 'Output device', 'An output device has been selected')
      : warn(
          'device',
          'Output device',
          'No output device selected yet — sounds stay off until one is chosen.',
          'Pick a device in this step, then play a test sound',
        ),
  );

  checks.push(
    audioVerified
      ? pass('verified', 'Speaker check', 'Someone confirmed the test sound was audible at the field')
      : warn(
          'verified',
          'Speaker check',
          'Nobody has confirmed a test sound was actually heard. Volume, amp power, and wiring can all fail silently.',
          'Play a test sound and confirm you heard it',
        ),
  );

  return checks;
}

/** Scoreboard and casting. The secure-origin half can only be checked in the
 *  browser (`window.isSecureContext`), so the wizard does that client-side and
 *  this covers the server-side half. */
async function probeScoreboard(
  videoProxyTarget: string | undefined,
  castVerified: boolean,
  scoringOpen: boolean,
): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  // Open-by-default is intentional — a new sensor works without setup — but
  // an operator should know which mode their field is actually in.
  checks.push(
    scoringOpen
      ? warn(
          'scoring-auth',
          'Scoring access',
          'Open: any device on the network can submit or reset scores. Fine for a friendly practice field; create a key below when the numbers matter, and only devices given it can score.',
        )
      : pass('scoring-auth', 'Scoring access', 'Locked: scoring writes require an API key'),
  );

  checks.push(
    castVerified
      ? pass('cast', 'Cast to a TV', 'Casting confirmed working on a real display')
      : warn(
          'cast',
          'Cast to a TV',
          'Google Cast needs the scoreboard served over HTTPS from a real hostname — casting silently will not offer the receiver otherwise.',
          'Open /scores on the field network and cast it to your TV',
        ),
  );

  if (!videoProxyTarget) {
    checks.push(
      warn(
        'video',
        'Video stream (optional)',
        'No stream server configured. The scoreboard works fine without it; set one to overlay a live camera feed.',
        'Set a WHEP server URL (e.g. MediaMTX at http://10.0.0.5:8889)',
      ),
    );
    return checks;
  }

  try {
    const response = await fetch(videoProxyTarget, { signal: AbortSignal.timeout(2500) });
    checks.push(pass('video', 'Video stream (optional)', `${videoProxyTarget} answered (HTTP ${response.status})`));
  } catch (err) {
    checks.push(
      fail(
        'video',
        'Video stream (optional)',
        `${videoProxyTarget} did not answer (${err instanceof Error ? err.message : err}).`,
      ),
    );
  }

  return checks;
}

/** Are we inside a container right now? */
function detectContainer(): string | null {
  if (existsSync('/.dockerenv')) return 'Docker';
  if (process.env.container) return process.env.container;
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
    if (cgroup.includes('docker')) return 'Docker';
    if (cgroup.includes('containerd')) return 'containerd';
    if (cgroup.includes('lxc')) return 'LXC';
  } catch {
    // No /proc (or not readable) — not a container we can identify
  }
  return null;
}

/**
 * How this install survives a reboot. Both supported modes need the host's
 * network namespace and NET_ADMIN, so the interesting question isn't "which is
 * better" but "is the one you picked actually set up".
 */
async function probeDeployment(mode: DeploymentMode | undefined): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  const container = detectContainer();
  const hasSystemd = existsSync('/run/systemd/system');

  checks.push(
    pass(
      'runtime',
      'Running as',
      container
        ? `A ${container} container${hasSystemd ? '' : ' (no systemd inside, as expected)'}`
        : hasSystemd
          ? 'A normal process on a systemd host'
          : 'A normal process (no systemd detected)',
    ),
  );

  if (!mode) {
    checks.push(
      warn(
        'mode',
        'Deployment method',
        container
          ? "You're in a container, so Docker is probably what you want — but nothing is recorded yet."
          : 'Not chosen yet. Pick systemd (simplest on a dedicated field host) or Docker (keeps dependencies self-contained).',
        'Choose a deployment method in this step',
      ),
    );
    return checks;
  }

  checks.push(pass('mode', 'Deployment method', mode === 'docker' ? 'Docker' : 'systemd service'));

  if (mode === 'systemd') {
    if (!hasSystemd) {
      checks.push(
        fail(
          'unit',
          'Service unit',
          'systemd was chosen but this host is not running systemd.',
          'Pick Docker instead, or run on a systemd host',
        ),
      );
      return checks;
    }

    if (!existsSync(SYSTEMD_UNIT)) {
      checks.push(
        fail(
          'unit',
          'Service unit',
          `${SYSTEMD_UNIT} does not exist, so pFMS will not come back after a reboot. Install it below, or yourself from docs/deployment.md and then:`,
          'sudo systemctl daemon-reload && sudo systemctl enable practice-field-management-system',
        ),
      );
      return checks;
    }

    // Best-effort: the unit can exist without being enabled for boot.
    try {
      const { stdout } = await execFileAsync('systemctl', ['is-enabled', 'practice-field-management-system']);
      const enabled = stdout.trim();
      checks.push(
        enabled === 'enabled'
          ? pass('unit', 'Service unit', 'Installed and enabled — it will start on boot')
          : warn(
              'unit',
              'Service unit',
              `Unit is installed but "${enabled}" — it will not start on boot.`,
              'sudo systemctl enable practice-field-management-system',
            ),
      );
    } catch {
      checks.push(warn('unit', 'Service unit', 'Unit file exists; could not determine whether it is enabled'));
    }

    return checks;
  }

  // Docker
  if (!container) {
    checks.push(
      warn(
        'container',
        'Container',
        'Docker was chosen, but this process is not running in a container. The walkthrough will show you how to build and run the image.',
        'See docs/deployment.md',
      ),
    );
    return checks;
  }

  checks.push(pass('container', 'Container', `Running inside ${container}`));
  // Restart policy lives on the host side of the container boundary; there is
  // no honest way to read it from in here, so say so rather than guess.
  checks.push(
    warn(
      'restart-policy',
      'Restart policy',
      'A container cannot see its own restart policy. Make sure it was started with --restart unless-stopped (or restart: unless-stopped in compose), or the field will not come back after a reboot.',
      'docker inspect -f "{{.HostConfig.RestartPolicy.Name}}" pfms',
    ),
  );

  return checks;
}

// ── Assembly ────────────────────────────────────────────────────────

const STEP_LABELS: Record<SetupStepId, { label: string; blurb: string }> = {
  host: { label: 'Host', blurb: 'Can this machine run a field at all?' },
  admin: { label: 'Admin passphrase', blurb: 'Who may change this field from here on?' },
  interfaces: { label: 'Interfaces', blurb: 'Which NIC carries the VLAN trunk?' },
  fieldControl: { label: 'Field control', blurb: 'Can we talk to the field-control network?' },
  radio: { label: 'Radio', blurb: 'Is the access point reachable and running supported firmware?' },
  teamVlans: { label: 'Team VLANs', blurb: 'Are the per-station networks in place?' },
  audio: { label: 'Match audio', blurb: 'Will the field speaker actually make noise?' },
  scoreboard: { label: 'Scoreboard', blurb: 'Casting scores to a TV, and an optional video feed.' },
  deployment: { label: 'Deployment', blurb: 'Keep it running: systemd service or Docker.' },
};

/** Worst status wins, so a step reads as failed if anything in it failed. */
function rollUp(checks: SetupCheck[]): SetupStep['status'] {
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'warn')) return 'warn';
  return 'pass';
}

export interface SetupProbeOptions {
  vlanInterface?: string;
  /** Where field control lives, when it isn't the trunk's native VLAN. */
  fieldControlInterface?: string;
  radioUrl: string;
  dryRun?: boolean;
  videoProxyTarget?: string;
  /** Human confirmations the wizard has recorded — checks can't prove these. */
  audioVerified?: boolean;
  castVerified?: boolean;
  deploymentMode?: DeploymentMode;
  /** True when the scoring API currently accepts unauthenticated writes. */
  scoringOpen?: boolean;
  /** The trunk pFMS is actually running on, and why not the chosen one. */
  trunk?: TrunkRuntime;
  /** An admin passphrase has been set. */
  adminConfigured?: boolean;
}

/** Until a passphrase is set, anyone who can open the page can change setup
 *  (and the radio, and every setting) — the trust-on-first-use window. */
function probeAdmin(configured: boolean): SetupCheck[] {
  return [
    configured
      ? pass('passphrase', 'Admin passphrase', 'Set — only admins can change setup and field settings now')
      : fail(
          'passphrase',
          'Admin passphrase',
          'Not set yet: anyone who can open this page can change the field. Set one below before going further.',
        ),
  ];
}

/** Run every probe once and return a full report. */
export async function runSetupProbe(opts: SetupProbeOptions): Promise<SetupProbeState> {
  // The whole point of the host step is to report an unsupported OS, so the
  // network probes must degrade rather than throw on one. createBackend()
  // throws outside Linux, so only reach for it when we can actually use it.
  const os = platform();
  const net: NetworkBackend | null =
    os === 'linux' && !opts.dryRun ? createBackend() : opts.dryRun ? createDryRunBackend() : null;

  const unavailable = (id: string, label: string): SetupCheck[] => [
    warn(id, label, `Not available on ${os} — pFMS manages networking on Linux only`),
  ];

  const [host, interfaces, fieldControl, radio, teamVlans, audio, scoreboard, deployment] = await Promise.all([
    probeHost(),
    net ? probeInterfaces(net, opts.vlanInterface, opts.trunk ?? {}) : unavailable('selected', 'Trunk interface'),
    net
      ? probeFieldControl(net, opts.vlanInterface, opts.fieldControlInterface)
      : unavailable('address', 'Field control address'),
    // Reaching the radio is plain HTTP, so it's worth trying from anywhere.
    probeRadio(opts.radioUrl),
    net ? probeTeamVlans(net, opts.vlanInterface) : unavailable('vlans', 'Team VLANs'),
    probeAudio(opts.audioVerified ?? false),
    probeScoreboard(opts.videoProxyTarget, opts.castVerified ?? false, opts.scoringOpen ?? false),
    probeDeployment(opts.deploymentMode),
  ]);

  const byId: [SetupStepId, SetupCheck[]][] = [
    ['host', host],
    ['admin', probeAdmin(opts.adminConfigured ?? false)],
    ['interfaces', interfaces],
    ['fieldControl', fieldControl],
    ['radio', radio],
    ['teamVlans', teamVlans],
    ['audio', audio],
    ['scoreboard', scoreboard],
    ['deployment', deployment],
  ];

  let trunkCandidateNames: string[] = [];
  try {
    trunkCandidateNames = net ? trunkCandidates(await net.listInterfaces()).map(i => i.name) : [];
  } catch {
    // The Interfaces step already reports why the list is unavailable.
  }

  const steps: SetupStep[] = byId.map(([id, checks]) => ({
    id,
    label: STEP_LABELS[id].label,
    blurb: STEP_LABELS[id].blurb,
    status: rollUp(checks),
    checks,
  }));

  return {
    type: 'setupProbeState',
    checkedAt: Date.now(),
    vlanInterface: opts.vlanInterface,
    fieldControlInterface: opts.fieldControlInterface,
    trunkCandidates: trunkCandidateNames,
    radioUrl: opts.radioUrl,
    dryRun: opts.dryRun ?? false,
    steps,
  };
}
