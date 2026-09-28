/**
 * Build a standalone, self-contained pFMS for a machine with nothing
 * installed (`bun run package`).
 *
 * Produces `release/pfms-<target>/` containing the executable plus the two
 * asset directories it needs beside it:
 *
 *   pfms            the binary (no node, no bun, no npm install)
 *   web/            the built frontend
 *   sounds/         match audio
 *   diag/           the Driver Station Wi-Fi check teams download
 *
 * Assets sit NEXT TO the binary rather than inside it because
 * `bun build --compile` keeps each bundled module's build-time `__dirname` —
 * a binary that read them via `__dirname` would silently serve the build
 * machine's checkout and then fail on any other computer. `findAssetDir()`
 * in src/staticServer.ts looks beside the executable first for this reason.
 *
 * Run `bun run build` first, or just use `bun run package`, which does both.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

// bun's target triples. Default to the host; pass one explicitly to
// cross-compile, e.g. `bun scripts/package-binary.ts bun-linux-x64`.
const target = process.argv[2] ?? `bun-${process.platform === 'win32' ? 'windows' : process.platform}-x64`;
const isWindows = target.includes('windows');

const outDir = resolve(ROOT, 'release', `pfms-${target.replace(/^bun-/, '')}`);
const binaryName = isWindows ? 'pfms.exe' : 'pfms';

const webSource = resolve(ROOT, 'frontend', 'dist');
const soundsSource = resolve(ROOT, 'sounds');
const diagSource = resolve(ROOT, 'diag');

if (!existsSync(webSource)) {
  console.error(`No built frontend at ${webSource}. Run "bun run build" first.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`Compiling ${binaryName} for ${target}…`);
const build = spawnSync(
  'bun',
  ['build', '--compile', `--target=${target}`, `--outfile=${resolve(outDir, binaryName)}`, 'src/index.ts'],
  { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (build.status !== 0) {
  console.error('Compile failed.');
  process.exit(build.status ?? 1);
}

cpSync(webSource, resolve(outDir, 'web'), { recursive: true });
cpSync(soundsSource, resolve(outDir, 'sounds'), { recursive: true });
cpSync(diagSource, resolve(outDir, 'diag'), { recursive: true });

console.log(`\nPackaged into ${outDir}`);
console.log('Contents: the binary, web/ (frontend), sounds/ (match audio), diag/ (Wi-Fi check script)');
console.log('\nZip that directory and it runs anywhere with no dependencies:');
console.log(`  sudo ./${binaryName}        # then open http://<host>:3000/setup`);
console.log('\nKeep the four items together — the binary looks for web/, sounds/ and diag/ beside it.');
