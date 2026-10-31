/**
 * Command-line entry points that run *instead of* starting the field.
 *
 * Kept deliberately small, and importing almost nothing: `src/index.ts` pulls in
 * the whole app, and `networkManager` builds a platform network backend at
 * module load, which throws outright on a non-Linux host. Running this file
 * directly (`bun src/cli.ts --clear-config`) therefore works everywhere,
 * while `bun src/index.ts --clear-config` only works where the app itself can load.
 */
import { existsSync } from 'node:fs';
import { versionLine } from './buildInfo.js';
import { clearSetupConfig, SETUP_CONFIG_DEFAULT_FILE } from './setupConfigStore.js';

/** Config written by the app that a "start over" might reasonably keep. */
const OTHER_CONFIG_FILES: [file: string, holds: string][] = [
  ['admin-auth.json', 'admin passphrase and sessions'],
  ['operator-auth.json', 'operator code and devices'],
  ['api-keys.json', 'scoring API keys'],
  ['external-access.json', 'external access tokens'],
  ['slack-config.json', 'Slack integration'],
  ['saved-teams.json', 'saved team WiFi configs'],
  ['active-config.json', 'current station assignments'],
  ['staged-config.json', 'staged station assignments'],
  ['audio-config.json', 'selected audio output device'],
  ['estop-state.json', 'e-stops and team Stops in force'],
];

/**
 * Refuse to touch config while the field is live — clearing setup state out
 * from under a running backend would leave the two disagreeing.
 *
 * Probing the health endpoint is the reliable signal: it's the same check
 * `update.sh` uses, and it doesn't depend on a pidfile that a crash could
 * leave stale.
 */
async function backendIsRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`pFMS — Practice Field Management System

Usage:
  bun src/index.ts                   Start the field
  bun src/cli.ts --clear-config      Erase saved setup answers and exit
  bun src/cli.ts --version           Show which pFMS this is
  bun src/cli.ts --help              Show this message

The single-file binary takes the same options: pfms, pfms --clear-config, …

Options for --clear-config:
  --all       Also erase the other config files listed in the output
  --force     Skip the "is the backend running?" check (dangerous)

Configuration lives in /etc/pfms/environment; see docs/configuration.md.`);
}

/**
 * Handle a CLI command if one was given. Returns the exit code the process
 * should use, or null when no command was given and the field should start.
 */
export async function maybeRunCli(argv: string[] = process.argv.slice(2)): Promise<number | null> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  if (argv.includes('--version')) {
    console.log(versionLine());
    return 0;
  }

  if (!argv.includes('--clear-config')) return null;

  const port = Number(process.env.WEBSOCKET_PORT) || 3000;

  if (!argv.includes('--force') && (await backendIsRunning(port))) {
    console.error(`Refusing to clear config: something is answering /health on port ${port}.`);
    console.error('Stop the service first:');
    console.error('  sudo systemctl stop practice-field-management-system');
    console.error('(or pass --force if you are certain that is not pFMS)');
    // Non-zero so a script can tell "refused" from "cleared".
    return 1;
  }

  const cleared = clearSetupConfig();
  console.log(
    cleared
      ? `Cleared ${cleared} — the setup wizard will start from the beginning.`
      : `No setup config to clear (${SETUP_CONFIG_DEFAULT_FILE} does not exist).`,
  );

  const present = OTHER_CONFIG_FILES.filter(([file]) => existsSync(file));

  if (argv.includes('--all')) {
    const { unlinkSync } = await import('node:fs');
    for (const [file, holds] of present) {
      try {
        unlinkSync(file);
        console.log(`Cleared ${file} (${holds})`);
      } catch (err) {
        console.error(`Could not remove ${file}:`, err);
      }
    }
    if (present.length === 0) console.log('No other config files present.');
  } else if (present.length > 0) {
    // Listing rather than deleting: these hold real operational state, and a
    // wizard restart rarely wants them gone.
    console.log('\nLeft alone (pass --all to erase these too):');
    for (const [file, holds] of present) console.log(`  ${file} — ${holds}`);
  }

  return 0;
}

// Support running this file directly, which avoids loading the rest of the app.
if (require.main === module) {
  void maybeRunCli().then(code => {
    if (code === null) printHelp();
    process.exit(code ?? 0);
  });
}
