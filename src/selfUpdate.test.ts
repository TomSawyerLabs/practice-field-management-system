import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { assetNameFor, pickUpdate, trustedSha256, versionOfTag, type FeedRelease } from './selfUpdate.js';

function release(tag: string, createdAt: string, extra: Partial<FeedRelease> = {}): FeedRelease {
  const asset = (name: string) => ({ name, browser_download_url: `https://example/${tag}/${name}`, size: 100 });
  return {
    tag_name: tag,
    created_at: createdAt,
    body: `notes for ${tag}`,
    assets: [asset('pfms-linux-x64'), asset('pfms-linux-arm64'), asset('SHA256SUMS'), asset('SHA256SUMS.sig')],
    ...extra,
  };
}

const feed = [
  release('build-20261012-0900-aaaaaaa', '2026-10-12T09:00:00Z'),
  release('mdns-socket-v0.1.0', '2026-10-13T12:00:00Z'),
  release('build-20261013-1400-ccccccc', '2026-10-13T14:00:00Z'),
  release('build-20261013-1000-bbbbbbb', '2026-10-13T10:00:00Z'),
];

describe('which published build is offered', () => {
  test('the newest build-* release, ignoring other releases', () => {
    const update = pickUpdate(feed, { version: 'aaaaaaa' }, 'pfms-linux-x64');
    expect(update?.version).toBe('ccccccc');
    expect(update?.binaryUrl).toBe('https://example/build-20261013-1400-ccccccc/pfms-linux-x64');
    expect(update?.notes).toBe('notes for build-20261013-1400-ccccccc');
  });

  test('nothing when we are the newest', () => {
    expect(pickUpdate(feed, { version: 'ccccccc' }, 'pfms-linux-x64')).toBeNull();
  });

  test('a build not in the feed (local or pruned) is only updated by something built after it', () => {
    expect(pickUpdate(feed, { version: 'zzzzzzz', builtAt: '2026-10-13T15:00:00Z' }, 'pfms-linux-x64')).toBeNull();
    expect(pickUpdate(feed, { version: 'zzzzzzz', builtAt: '2026-10-13T13:00:00Z' }, 'pfms-linux-x64')?.version).toBe(
      'ccccccc',
    );
  });

  test('drafts, prereleases and releases missing an asset are skipped', () => {
    const incomplete = release('build-20261014-0800-ddddddd', '2026-10-14T08:00:00Z', {
      assets: [{ name: 'pfms-linux-x64', browser_download_url: 'x', size: 1 }],
    });
    const draft = release('build-20261014-0900-eeeeeee', '2026-10-14T09:00:00Z', { draft: true });
    // A newer release still uploading its assets, or a draft, doesn't hide
    // the newest complete one.
    expect(pickUpdate([...feed, incomplete, draft], { version: 'aaaaaaa' }, 'pfms-linux-x64')?.version).toBe('ccccccc');
  });

  test('only Linux x64 and arm64 have builds', () => {
    expect(assetNameFor('linux', 'arm64')).toBe('pfms-linux-arm64');
    expect(assetNameFor('win32', 'x64')).toBeNull();
    expect(assetNameFor('linux', 'ia32')).toBeNull();
  });

  test('the version is the tag’s last part', () => {
    expect(versionOfTag('build-20261013-1442-abc1234')).toBe('abc1234');
  });
});

describe('checking a download against the signed checksums', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const hash = 'a'.repeat(64);
  const sums = `${hash}  pfms-linux-x64\n${'b'.repeat(64)}  pfms-linux-arm64\n`;
  const sig = sign(null, Buffer.from(sums), privateKey).toString('base64');

  test('a valid signature yields the asset’s hash', () => {
    expect(trustedSha256(sums, sig, 'pfms-linux-x64', pub)).toBe(hash);
    expect(trustedSha256(sums, sig, 'pfms-linux-arm64', pub)).toBe('b'.repeat(64));
  });

  test('a changed checksum file is refused', () => {
    const tampered = sums.replace(hash, 'c'.repeat(64));
    expect(() => trustedSha256(tampered, sig, 'pfms-linux-x64', pub)).toThrow(/signature/);
  });

  test('a signature from another key is refused', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const forged = sign(null, Buffer.from(sums), other).toString('base64');
    expect(() => trustedSha256(sums, forged, 'pfms-linux-x64', pub)).toThrow(/signature/);
  });

  test('the real release key refuses a signature made with a test key', () => {
    expect(() => trustedSha256(sums, sig, 'pfms-linux-x64')).toThrow(/signature/);
  });

  test('an asset missing from the list is refused', () => {
    expect(() => trustedSha256(sums, sig, 'pfms-windows-x64.exe', pub)).toThrow(/no entry/);
  });
});
