/**
 * Fetch the prebuilt mdns-socket addon (native/mdns-socket) for this
 * platform from its GitHub release into native/mdns-socket/prebuilt/.
 *
 * The version is the crate's (native/mdns-socket/Cargo.toml); CI builds it
 * when a `mdns-socket-v<version>` tag is pushed
 * (.github/workflows/mdns-socket.yml). Run by `bun run build`, so update.sh
 * and the Docker build get it. Skipped off Linux (the addon is Linux only)
 * and when the right version is already there.
 *
 *   bun scripts/fetch-mdns-socket.ts          this machine's
 *   bun scripts/fetch-mdns-socket.ts arm64    Linux arm64's, from any OS —
 *                                             for building a binary for it
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'TomSawyerLabs/practice-field-management-system';
const crateDir = path.join(import.meta.dir, '..', 'native', 'mdns-socket');
const prebuiltDir = path.join(crateDir, 'prebuilt');

const wantedArch = process.argv[2];
if (!wantedArch && process.platform !== 'linux') {
  console.log(`mdns-socket: skipped on ${process.platform} (the addon is Linux only)`);
  process.exit(0);
}
const arch = wantedArch ?? process.arch;

const cargo = readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) throw new Error('mdns-socket: no version in native/mdns-socket/Cargo.toml');

const file = `mdns-socket.linux-${arch}-gnu.node`;
const target = path.join(prebuiltDir, file);
const stamp = path.join(prebuiltDir, `${file}.version`);
if (existsSync(target) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version) {
  console.log(`mdns-socket: ${file} ${version} already here`);
  process.exit(0);
}

const url = `https://github.com/${REPO}/releases/download/mdns-socket-v${version}/${file}`;
console.log(`mdns-socket: fetching ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`mdns-socket: ${res.status} ${res.statusText} for ${url}`);
  console.error(
    '  Is the release built? Push the tag mdns-socket-v' + version + ' (see native/mdns-socket/README.md).',
  );
  process.exit(1);
}
mkdirSync(prebuiltDir, { recursive: true });
// Write beside, then rename: a half-written file never looks finished.
writeFileSync(`${target}.part`, Buffer.from(await res.arrayBuffer()));
renameSync(`${target}.part`, target);
writeFileSync(stamp, `${version}\n`);
console.log(`mdns-socket: ${file} ${version} saved`);
