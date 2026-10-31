import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAuth, MIN_PASSPHRASE_LENGTH, type ScryptCost } from './adminAuth.js';

// Cheap, so these don't take seconds. The default cost has its own test.
const CHEAP: ScryptCost = { N: 2 ** 10, r: 8, p: 1 };
const dir = mkdtempSync(join(tmpdir(), 'pfms-admin-auth-'));
let file: string;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  file = join(dir, `auth-${Math.random()}.json`);
});

const stored = () => JSON.parse(readFileSync(file, 'utf-8'));

/** A file as every field's pFMS wrote it before scrypt. */
function legacyFile(passphrase: string, tokenHashes: string[] = []) {
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const passphraseHash = createHash('sha256')
    .update(passphrase + salt)
    .digest('hex');
  writeFileSync(file, JSON.stringify({ passphraseHash, salt, tokenHashes }, null, 2));
  return { passphraseHash, salt };
}

describe('a new passphrase', () => {
  test('is hashed with scrypt, and the cost is kept with it', async () => {
    const auth = new AdminAuth(file, CHEAP);
    expect(await auth.setPassphrase('correct horse')).toBe(true);
    expect(stored().scrypt).toEqual(CHEAP);
    expect(stored().passphraseHash).toHaveLength(64);
    expect(await auth.login('correct horse')).toBeTruthy();
    expect(await auth.login('wrong horse!!')).toBeNull();
  });

  test('survives a restart', async () => {
    await new AdminAuth(file, CHEAP).setPassphrase('correct horse');
    expect(await new AdminAuth(file, CHEAP).login('correct horse')).toBeTruthy();
  });

  test(`must be at least ${MIN_PASSPHRASE_LENGTH} characters`, async () => {
    const auth = new AdminAuth(file, CHEAP);
    expect(await auth.setPassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH - 1))).toBe(false);
    expect(auth.isConfigured()).toBe(false);
    expect(await auth.setPassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH))).toBe(true);
  });

  test('a change needs force, and ends every session', async () => {
    const auth = new AdminAuth(file, CHEAP);
    await auth.setPassphrase('correct horse');
    const token = (await auth.login('correct horse'))!;
    expect(await auth.setPassphrase('battery staple', false)).toBe(false);
    expect(await auth.login('correct horse')).toBeTruthy();
    expect(await auth.setPassphrase('battery staple', true)).toBe(true);
    expect(auth.validateToken(token)).toBe(false);
    expect(await auth.login('correct horse')).toBeNull();
    expect(await auth.login('battery staple')).toBeTruthy();
  });

  test('only the first of two racing claims wins', async () => {
    const auth = new AdminAuth(file, CHEAP);
    const [first, second] = await Promise.all([
      auth.setPassphrase('first passphrase'),
      auth.setPassphrase('second passphrase'),
    ]);
    expect([first, second]).toEqual([true, false]);
    expect(await auth.login('first passphrase')).toBeTruthy();
  });
});

describe('a passphrase stored the old way', () => {
  test('still logs in, and the next login uses the new hash', async () => {
    const old = legacyFile('hunter2-field');
    const auth = new AdminAuth(file, CHEAP);
    expect(auth.isConfigured()).toBe(true);

    expect(await auth.login('hunter2-field')).toBeTruthy();
    expect(stored().scrypt).toEqual(CHEAP);
    expect(stored().passphraseHash).not.toBe(old.passphraseHash);
    expect(stored().salt).not.toBe(old.salt);

    expect(await new AdminAuth(file, CHEAP).login('hunter2-field')).toBeTruthy();
  });

  test('a short one keeps working, before and after the upgrade', async () => {
    legacyFile('abcd');
    expect(await new AdminAuth(file, CHEAP).login('abcd')).toBeTruthy();
    expect(stored().scrypt).toEqual(CHEAP);
    expect(await new AdminAuth(file, CHEAP).login('abcd')).toBeTruthy();
  });

  test('a wrong passphrase changes nothing', async () => {
    const old = legacyFile('hunter2-field');
    const before = readFileSync(file, 'utf-8');
    expect(await new AdminAuth(file, CHEAP).login('wrong')).toBeNull();
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(stored().passphraseHash).toBe(old.passphraseHash);
  });

  test('open sessions survive the upgrade', async () => {
    const token = 'b'.repeat(64);
    legacyFile('hunter2-field', [createHash('sha256').update(token).digest('hex')]);
    const auth = new AdminAuth(file, CHEAP);
    expect(auth.validateToken(token)).toBe(true);
    await auth.login('hunter2-field');
    expect(auth.validateToken(token)).toBe(true);
    expect(new AdminAuth(file, CHEAP).validateToken(token)).toBe(true);
  });

  test('a save that fails still logs in, and leaves the old file working', async () => {
    legacyFile('hunter2-field');
    const before = readFileSync(file, 'utf-8');
    const auth = new AdminAuth(file, CHEAP);
    // A directory where the temp file goes makes the write fail.
    mkdirSync(`${file}.tmp`);
    expect(await auth.login('hunter2-field')).toBeTruthy();
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(await new AdminAuth(file, CHEAP).login('hunter2-field')).toBeTruthy();
  });
});

describe('raising the cost later', () => {
  test('a cheaper scrypt hash is upgraded at its next login', async () => {
    await new AdminAuth(file, CHEAP).setPassphrase('correct horse');
    const higher = { ...CHEAP, N: 2 ** 11 };
    expect(await new AdminAuth(file, higher).login('correct horse')).toBeTruthy();
    expect(stored().scrypt).toEqual(higher);
  });

  test('a hash at the current cost is left alone', async () => {
    await new AdminAuth(file, CHEAP).setPassphrase('correct horse');
    const { salt } = stored();
    await new AdminAuth(file, CHEAP).login('correct horse');
    expect(stored().salt).toBe(salt);
  });
});

test('the real cost works on this runtime, and leaves the event loop free', async () => {
  const auth = new AdminAuth(file);
  let worstGap = 0;
  let last = performance.now();
  const beat = setInterval(() => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
  }, 5);
  await auth.setPassphrase('correct horse');
  expect(await auth.login('correct horse')).toBeTruthy();
  expect(await auth.login('wrong horse!!')).toBeNull();
  clearInterval(beat);
  expect(stored().scrypt).toEqual({ N: 2 ** 17, r: 8, p: 1 });
  // A stop has to get through while a login is being checked.
  expect(worstGap).toBeLessThan(100);
}, 20_000);

test('a flood of tries is turned away instead of queueing without end', async () => {
  const auth = new AdminAuth(file, CHEAP);
  await auth.setPassphrase('correct horse');
  const tries = Array.from({ length: 200 }, () => auth.login('correct horse'));
  const tokens = (await Promise.all(tries)).filter(Boolean);
  expect(tokens.length).toBe(8);
  // Once they've drained it works again.
  expect(await auth.login('correct horse')).toBeTruthy();
});

test('sessions are capped, newest kept', async () => {
  const auth = new AdminAuth(file, CHEAP);
  await auth.setPassphrase('correct horse');
  const tokens: string[] = [];
  for (let i = 0; i < 21; i++) tokens.push((await auth.login('correct horse'))!);
  expect(auth.validateToken(tokens[0])).toBe(false);
  expect(auth.validateToken(tokens[20])).toBe(true);
  expect(stored().tokenHashes).toHaveLength(20);
});

test('a save leaves no temp file, and only this user can read it', async () => {
  await new AdminAuth(file, CHEAP).setPassphrase('correct horse');
  expect(existsSync(`${file}.tmp`)).toBe(false);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('an unusable stored hash refuses logins rather than reading as unclaimed', async () => {
  writeFileSync(
    file,
    JSON.stringify({ passphraseHash: 'ab'.repeat(32), salt: 'cd', scrypt: { N: 3, r: 8, p: 1 }, tokenHashes: [] }),
  );
  const auth = new AdminAuth(file, CHEAP);
  expect(auth.isConfigured()).toBe(true);
  expect(await auth.setPassphrase('correct horse')).toBe(false);
  expect(await auth.login('correct horse')).toBeNull();
});
