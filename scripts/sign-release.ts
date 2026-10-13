/**
 * Release signing for the single-file binaries (.github/workflows/release.yml).
 *
 *   bun scripts/sign-release.ts sign <SHA256SUMS>   writes <SHA256SUMS>.sig
 *       key: PFMS_RELEASE_SIGNING_KEY (ed25519 private key, PKCS#8 PEM)
 *   bun scripts/sign-release.ts verify <SHA256SUMS>  checks it against
 *       src/releaseKey.ts — what self-update does before installing
 *   bun scripts/sign-release.ts keygen <out.pem>     a new key pair: private
 *       key to <out.pem>, public key printed for src/releaseKey.ts
 *
 * Changing the key strands every installed binary: they only trust the key
 * they were built with. Keep the private key backed up.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyReleaseSignature } from '../src/releaseKey.js';

const [command, file] = process.argv.slice(2);

if (command === 'sign' && file) {
  const pem = process.env.PFMS_RELEASE_SIGNING_KEY;
  if (!pem) throw new Error('PFMS_RELEASE_SIGNING_KEY is not set');
  const signature = sign(null, readFileSync(file), createPrivateKey(pem));
  writeFileSync(`${file}.sig`, signature.toString('base64') + '\n');
  if (!verifyReleaseSignature(readFileSync(file), readFileSync(`${file}.sig`, 'utf-8'))) {
    throw new Error('Signed with a key that does not match src/releaseKey.ts — installed binaries would reject it');
  }
  console.log(`Signed ${file}`);
} else if (command === 'verify' && file) {
  const ok = verifyReleaseSignature(readFileSync(file), readFileSync(`${file}.sig`, 'utf-8'));
  console.log(ok ? `${file}: signature OK` : `${file}: BAD signature`);
  process.exit(ok ? 0 : 1);
} else if (command === 'keygen' && file) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Private key written to ${file}. Public key for src/releaseKey.ts:\n`);
  console.log(publicKey.export({ type: 'spki', format: 'pem' }));
} else {
  console.error('usage: bun scripts/sign-release.ts sign|verify <SHA256SUMS> | keygen <out.pem>');
  process.exit(1);
}
