/**
 * Where pFMS's bundled files (frontend build, sounds, diag script, the
 * mdns-socket addon) live. In a checkout that's the repo; the packaged
 * binary unpacks its embedded copies to disk at startup (src/binaryMain.ts)
 * and points here before the app loads — aplay and dlopen need real files.
 */
import { join, resolve } from 'node:path';

let root: string | undefined;

/** Set by the packaged binary before importing the app. */
export function setAssetRoot(dir: string): void {
  root = dir;
}

/** The unpacked bundle, or undefined in a checkout. */
export function assetRoot(): string | undefined {
  return root;
}

/** A repo-relative path (`sounds`, `native/…`): from the unpacked bundle when
 *  there is one, else from the checkout (src/ sits one level below it). */
export function bundledPath(...parts: string[]): string {
  return root ? join(root, ...parts) : resolve(__dirname, '..', ...parts);
}
