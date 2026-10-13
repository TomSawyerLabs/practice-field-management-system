/**
 * The public half of the key CI signs releases with (secret
 * PFMS_RELEASE_SIGNING_KEY; scripts/sign-release.ts). Self-update only
 * installs a binary whose SHA256SUMS carries a valid signature from it, so a
 * swapped or tampered release asset is refused even if it came from GitHub.
 *
 * Replacing this key strands every binary already installed — they trust
 * only the key they were built with.
 */
import { createPublicKey, verify } from 'node:crypto';

export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADzF608p8Iq9Eo0K7d0v47J9Uqb0L2KGXW1D2N8MfSB0=
-----END PUBLIC KEY-----
`;

/** True when `signatureBase64` is a valid ed25519 signature of `data`.
 *  `publicKeyPem` defaults to the release key; tests pass their own. */
export function verifyReleaseSignature(
  data: Buffer | Uint8Array,
  signatureBase64: string,
  publicKeyPem = RELEASE_PUBLIC_KEY,
): boolean {
  try {
    return verify(null, data, createPublicKey(publicKeyPem), Buffer.from(signatureBase64.trim(), 'base64'));
  } catch {
    return false;
  }
}
