/**
 * Build the single-file pFMS: one executable with the frontend, sounds, the
 * diag script and (Linux) the mdns-socket addon inside it — no git, bun or
 * build needed where it runs. CI publishes these as releases
 * (.github/workflows/release.yml); self-update installs them.
 *
 *   bun run package                          this machine's platform
 *   bun scripts/build-binary.ts bun-linux-arm64   cross-compile (after `bun run build`)
 *
 * Output: release/pfms-<os>-<arch>[.exe]. The frontend must already be built
 * (`bun run package` runs `bun run build` first) from the same commit — the
 * screens reload when their build version differs from the server's.
 *
 * When the target is this machine, the binary is smoke-run with --version.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BuildInfo } from '../src/buildInfo.js';

const ROOT = resolve(import.meta.dir, '..');
const hostOs = process.platform === 'win32' ? 'windows' : process.platform;
const target = process.argv[2] ?? `bun-${hostOs}-${process.arch}`;
const match = target.match(/^bun-(linux|windows|darwin)-(x64|arm64)/);
if (!match) {
  console.error(`Unknown target ${target} — expected e.g. bun-linux-x64, bun-linux-arm64`);
  process.exit(1);
}
const [, os, arch] = match;

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();

if (!existsSync(join(ROOT, 'frontend', 'dist', 'index.html'))) {
  console.error('No built frontend in frontend/dist. Run "bun run build" first (or use "bun run package").');
  process.exit(1);
}

// Everything embedded is staged in build/bundle/ with the repo's layout and
// embedded as that one directory: bun names an embedded file relative to its
// --asset's parent (frontend/dist/x → "dist/x"), so this keeps the paths the
// app looks up (src/assetRoot.ts). src/binaryMain.ts strips "bundle/".
const assets = ['frontend/dist', 'sounds', 'diag'];
if (os === 'linux') {
  run('bun', ['scripts/fetch-mdns-socket.ts', arch]); // only this target's addon goes in
  assets.push(`native/mdns-socket/prebuilt/mdns-socket.linux-${arch}-gnu.node`);
}
const bundle = join(ROOT, 'build', 'bundle');
rmSync(bundle, { recursive: true, force: true });
for (const asset of assets) cpSync(join(ROOT, asset), join(bundle, asset), { recursive: true });

const build: BuildInfo = {
  commit: git('rev-parse', 'HEAD'),
  version: git('rev-parse', '--short', 'HEAD'),
  builtAt: new Date().toISOString(),
  target,
};
if (git('status', '--porcelain', '--untracked-files=no')) {
  console.warn(`Warning: uncommitted changes — this binary says ${build.version} but isn't exactly it.`);
}
writeFileSync(join(bundle, 'build-info.json'), JSON.stringify(build, null, 2));

const outFile = join(ROOT, 'release', `pfms-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
mkdirSync(join(ROOT, 'release'), { recursive: true });
rmSync(outFile, { force: true });

console.log(`Compiling ${outFile} (${target}, ${build.version})…`);
run('bun', [
  'build',
  '--compile',
  `--target=${target}`,
  // Production settings come from the environment and setup-config.json,
  // never a .env or bunfig.toml that happens to sit in the working directory.
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--asset=build/bundle',
  `--outfile=${outFile}`,
  'src/binaryMain.ts',
]);

if (os === hostOs && arch === process.arch) {
  const out = execFileSync(outFile, ['--version'], { encoding: 'utf-8' }).trim();
  if (!out.startsWith(`${build.version} `)) {
    console.error(`Smoke test failed: --version printed "${out}", expected ${build.version}`);
    process.exit(1);
  }
  console.log(`Smoke test: ${out}`);
}
console.log(`\nBuilt ${outFile}`);
console.log(
  'Copy it anywhere and run it (as root on a field host): sudo ./pfms-…   then open http://<host>:3000/setup',
);
