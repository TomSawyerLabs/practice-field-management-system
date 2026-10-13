/**
 * Entry point of the single-file pFMS binary (scripts/build-binary.ts).
 *
 * The binary embeds the frontend build, sounds, the diag script, the
 * mdns-socket addon and build-info.json, staged under `bundle/` with the
 * repo's layout (`bun build --compile --asset=build/bundle`). Before the app
 * loads, this unpacks them to disk —
 * aplay plays files, dlopen loads files — and points the app's asset lookups
 * there (src/assetRoot.ts). Then it imports src/index.ts, the same app a
 * checkout runs.
 *
 * Run from a checkout (`bun src/binaryMain.ts`) nothing is embedded, so it
 * just starts the app.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setAssetRoot } from './assetRoot.js';
import { setPackagedBuild, versionLine, type BuildInfo } from './buildInfo.js';

const PREFIX = 'bundle/';
const BUILD_INFO = 'build-info.json';
/** Written last, so a half-unpacked directory is never mistaken for done. */
const COMPLETE = '.complete';

/**
 * Unpack the embedded files into `<base>/<version>/`, once per version.
 * Beside the binary when that's writable (a root service), else the temp
 * directory. Older versions are pruned, keeping the newest other one — the
 * previous build, which a self-update rollback goes back to.
 */
async function unpack(files: File[], version: string): Promise<string> {
  const bases = [join(dirname(process.execPath), '.pfms-assets'), join(tmpdir(), 'pfms-assets')];
  for (const base of bases) {
    const dir = join(base, version);
    try {
      if (!existsSync(join(dir, COMPLETE))) {
        rmSync(dir, { recursive: true, force: true });
        for (const file of files) {
          const out = join(dir, file.name.slice(PREFIX.length));
          mkdirSync(dirname(out), { recursive: true });
          await Bun.write(out, file);
        }
        writeFileSync(join(dir, COMPLETE), '');
      }
      prune(base, version);
      return dir;
    } catch (err) {
      console.warn(`Could not unpack pFMS's bundled files into ${base}: ${(err as Error).message}`);
    }
  }
  throw new Error(`Nowhere to unpack pFMS's bundled files (tried ${bases.join(', ')})`);
}

function prune(base: string, keep: string): void {
  const others = readdirSync(base)
    .filter(name => name !== keep)
    .map(name => ({ name, mtime: statSync(join(base, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name } of others.slice(1)) rmSync(join(base, name), { recursive: true, force: true });
}

async function main(): Promise<void> {
  // bun-types says Blob; embedded files are Files, named by their path.
  const files = (Bun.embeddedFiles as unknown as File[]).filter(f => f.name.startsWith(PREFIX));
  const info = files.find(f => f.name === PREFIX + BUILD_INFO);
  if (info) {
    const build = JSON.parse(await info.text()) as BuildInfo;
    setPackagedBuild(build);
    // Answered here, before the app (and its startup chatter) loads and
    // without unpacking anything: self-update smoke-runs a downloaded binary
    // this way and reads the first word.
    if (process.argv.slice(2).includes('--version')) {
      console.log(versionLine());
      process.exit(0);
    }
    const root = await unpack(
      files.filter(f => f !== info),
      build.version,
    );
    setAssetRoot(root);
    const addon = join(
      root,
      'native',
      'mdns-socket',
      'prebuilt',
      `mdns-socket.${process.platform}-${process.arch}-gnu.node`,
    );
    if (!process.env.MDNS_SOCKET_NODE && existsSync(addon)) process.env.MDNS_SOCKET_NODE = addon;
  }
  await import('./index.js');
}

main().catch(err => {
  console.error('pFMS failed to start:', err);
  process.exit(1);
});
