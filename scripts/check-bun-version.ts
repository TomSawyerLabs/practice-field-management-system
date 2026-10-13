/**
 * Fail the build when this bun is older than package.json's `engines.bun`.
 * Run first by `bun run build`, so update.sh stops the deploy (and the field
 * keeps running) instead of reloading pFMS onto a runtime it misbehaves on.
 *
 * Why there's a floor: bun 1.3.11 fails matchEngine tests on Linux that
 * 1.4.2 passes (challenge runs, relay hand-offs; 2026-10-13).
 */
import pkg from '../package.json';

const wanted = pkg.engines.bun;
if (!Bun.semver.satisfies(Bun.version, wanted)) {
  console.error(`bun ${Bun.version} is too old for pFMS (needs ${wanted}). Run: bun upgrade`);
  process.exit(1);
}
