import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

// ── Known firmware releases ─────────────────────────────────────────

export interface FirmwareEntry {
  /** Version string (e.g. "2.0.1") */
  version: string;
  /** SHA-256 of the unencrypted firmware. The radio checks it after decrypting
   *  the image, so it never matches the `.img.enc` file itself: both images of
   *  a release share one. */
  checksum: string;
  /** Local file path (set when the file is available on disk) */
  filePath?: string;
  /** Download URL (may be undefined for manually uploaded files) */
  downloadUrl?: string;
  /** "from12x" or "pre12x" — which radios this file is for */
  upgradeFrom: 'from12x' | 'pre12x';
  /** Whether a download is currently in progress */
  downloading?: boolean;
  /** Download progress: bytes received so far */
  downloadedBytes?: number;
  /** Download progress: total bytes (if known from Content-Length) */
  totalBytes?: number;
  /** Error message if download failed */
  downloadError?: string;
}

interface FirmwareManifest {
  entries: FirmwareEntry[];
}

export type KnownRelease = Omit<FirmwareEntry, 'filePath'> & {
  /** SHA-256 of the `.img.enc` file itself, which an upload can be checked against. */
  imageSha256: string;
};

const KNOWN_RELEASES: KnownRelease[] = [
  {
    version: '2.0.1',
    checksum: '77575f490fa0a07503e5235cdd85118b0a81c69bc0b8db7a9fc131ea2d8c6315',
    imageSha256: '1f595fdbcad9d501dc5047cef751fe551c53dd85ae354093043f28dd0dfa0e57',
    downloadUrl:
      'https://4239402461-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FzaDthb1gXvbj84qIfOUE%2Fuploads%2FDYZGxAFlpIglmx8C31gq%2FVH-109_2.0.1-02062026.FROM_1_2_X.img.enc?alt=media&token=711cee42-568c-4533-a5f7-712895e1c6a3',
    upgradeFrom: 'from12x',
  },
  {
    version: '2.0.1',
    checksum: '77575f490fa0a07503e5235cdd85118b0a81c69bc0b8db7a9fc131ea2d8c6315',
    imageSha256: 'bfe0e79ee872d2ce02111e24737ccd46af5f9f58f0d95f74b75e9864e08f4c52',
    downloadUrl:
      'https://4239402461-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FzaDthb1gXvbj84qIfOUE%2Fuploads%2FDOB0aVqc7pD50euGhir9%2FVH-109_2.0.1-02062026.img.enc?alt=media&token=e44ae3c3-5c07-48f6-8103-59e26cfe7839',
    upgradeFrom: 'pre12x',
  },
];

// ── Store ───────────────────────────────────────────────────────────

const DEFAULT_STORE_DIR = 'firmware';
const MANIFEST_FILE = 'manifest.json';

function firmwareFilename(version: string, upgradeFrom: 'from12x' | 'pre12x'): string {
  return `VH-109_${version}.${upgradeFrom === 'pre12x' ? '' : 'FROM_1_2_X.'}img.enc`;
}

/** An upload that can't be the firmware it says it is. */
export class FirmwareUploadRefused extends Error {}

export type FirmwareStoreListener = (entries: FirmwareEntry[]) => void;

export class FirmwareStore {
  private dir: string;
  private entries: FirmwareEntry[] = [];
  private listeners: FirmwareStoreListener[] = [];

  constructor(
    storeDir?: string,
    private readonly knownReleases: KnownRelease[] = KNOWN_RELEASES,
  ) {
    this.dir = storeDir ?? DEFAULT_STORE_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.loadManifest();
    this.reconcileKnownReleases();
  }

  /** Register a listener for firmware store changes. */
  addListener(fn: FirmwareStoreListener): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notify(): void {
    const entries = this.getEntries();
    for (const fn of this.listeners) {
      try {
        fn(entries);
      } catch {}
    }
  }

  /** Get all firmware entries and their availability status. */
  getEntries(): FirmwareEntry[] {
    return this.entries.map(e => ({ ...e }));
  }

  /** Find a firmware file suitable for a given current radio version. Returns undefined if not available locally. */
  getFirmwareForRadio(currentVersion: string): FirmwareEntry | undefined {
    const upgradeFrom = isPreI2x(currentVersion) ? 'pre12x' : 'from12x';
    return this.entries.find(e => e.filePath && e.upgradeFrom === upgradeFrom);
  }

  /** Get the expected firmware version prefix. */
  getExpectedVersion(): string {
    return KNOWN_RELEASES[0]?.version ?? 'unknown';
  }

  /** Check if a version needs updating. */
  needsUpdate(version: string): boolean {
    const versionPart = version.includes('_') ? version.split('_')[1] : version;
    return !versionPart.startsWith(this.getExpectedVersion());
  }

  /**
   * Start downloading all known firmware files that aren't already cached.
   * Non-blocking — returns immediately, downloads happen in the background.
   * Retries up to 3 times with exponential backoff.
   */
  startBackgroundDownloads(): void {
    for (const entry of this.entries) {
      if (entry.filePath || entry.downloading || !entry.downloadUrl) continue;
      this.downloadEntry(entry);
    }
  }

  /**
   * Manually add a firmware file (uploaded by admin). A release this store
   * knows is checked here, before anything is written. Any other version can't
   * be: `checksum` covers what's inside the encrypted image, so only the radio
   * can tell, when it's flashed.
   */
  addManualFirmware(data: Buffer, checksum: string, version: string, upgradeFrom: 'from12x' | 'pre12x'): FirmwareEntry {
    const known = this.knownReleases.find(r => r.version === version && r.upgradeFrom === upgradeFrom);
    if (known) {
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== known.imageSha256) {
        throw new FirmwareUploadRefused(
          `This file isn't the ${version} image for ${upgradeFrom}: its SHA-256 is ${sha256}, not ${known.imageSha256}`,
        );
      }
      if (checksum.toLowerCase() !== known.checksum) {
        throw new FirmwareUploadRefused(`The published checksum for ${version} is ${known.checksum}`);
      }
    }

    const filename = firmwareFilename(version, upgradeFrom);
    const filePath = join(this.dir, filename);
    writeFileSync(filePath, data);

    // Check if entry already exists
    const existing = this.entries.find(e => e.version === version && e.upgradeFrom === upgradeFrom);
    if (existing) {
      existing.filePath = filePath;
      existing.checksum = checksum;
    } else {
      this.entries.push({ version, checksum, filePath, upgradeFrom });
    }

    this.saveManifest();
    this.notify();
    console.log(`Firmware manually added: ${filename} (${upgradeFrom})`);
    return existing ?? this.entries[this.entries.length - 1];
  }

  // ── Internal ────────────────────────────────────────────────────

  private async downloadEntry(entry: FirmwareEntry, retries = 3): Promise<void> {
    if (!entry.downloadUrl) return;

    const filename = firmwareFilename(entry.version, entry.upgradeFrom);
    const filePath = join(this.dir, filename);

    // Already on disk?
    if (existsSync(filePath)) {
      entry.filePath = filePath;
      this.saveManifest();
      return;
    }

    entry.downloading = true;
    entry.downloadedBytes = 0;
    entry.totalBytes = undefined;
    entry.downloadError = undefined;
    this.notify();
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`Downloading firmware ${filename} (attempt ${attempt}/${retries})...`);
        entry.downloadedBytes = 0;
        this.notify();

        const res = await fetch(entry.downloadUrl, {
          signal: AbortSignal.timeout(300_000), // 5 minute timeout
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const contentLength = res.headers.get('content-length');
        entry.totalBytes = contentLength ? parseInt(contentLength, 10) : undefined;
        this.notify();

        // Stream to disk with progress tracking
        const ws = createWriteStream(filePath);
        const reader = (res.body as unknown as NodeJS.ReadableStream)[Symbol.asyncIterator]();
        for await (const chunk of { [Symbol.asyncIterator]: () => reader }) {
          ws.write(chunk as Buffer);
          entry.downloadedBytes = (entry.downloadedBytes ?? 0) + (chunk as Buffer).length;
          // Throttle notifications to ~every 100KB
          if (entry.downloadedBytes % 102400 < (chunk as Buffer).length) {
            this.notify();
          }
        }
        await new Promise<void>((resolve, reject) => {
          ws.end(() => resolve());
          ws.on('error', reject);
        });

        entry.filePath = filePath;
        entry.downloading = false;
        entry.downloadedBytes = undefined;
        entry.totalBytes = undefined;
        this.saveManifest();
        this.notify();
        console.log(`Firmware downloaded: ${filename}`);
        return;
      } catch (err) {
        try {
          if (existsSync(filePath)) unlinkSync(filePath);
        } catch {}
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`Firmware download failed (attempt ${attempt}/${retries}): ${lastError.message}`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 5000 * Math.pow(4, attempt - 1)));
        }
      }
    }

    entry.downloading = false;
    entry.downloadedBytes = undefined;
    entry.totalBytes = undefined;
    entry.downloadError = lastError?.message;
    this.notify();
    console.error(`Firmware download failed after ${retries} attempts: ${lastError?.message}`);
  }

  private loadManifest(): void {
    const manifestPath = join(this.dir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      this.entries = [];
      return;
    }
    try {
      const data = JSON.parse(readFileSync(manifestPath, 'utf-8')) as FirmwareManifest;
      this.entries = data.entries ?? [];
      // Verify file paths still exist on disk
      for (const entry of this.entries) {
        if (entry.filePath && !existsSync(entry.filePath)) {
          entry.filePath = undefined;
        }
        entry.downloading = false;
      }
    } catch {
      this.entries = [];
    }
  }

  private saveManifest(): void {
    const manifestPath = join(this.dir, MANIFEST_FILE);
    const data: FirmwareManifest = {
      entries: this.entries.map(({ downloading, downloadedBytes, totalBytes, downloadError, ...rest }) => rest),
    };
    writeFileSync(manifestPath, JSON.stringify(data, null, 2));
  }

  /** Ensure all known releases are in the manifest (adds missing ones). */
  private reconcileKnownReleases(): void {
    let changed = false;
    for (const { imageSha256: _, ...known } of this.knownReleases) {
      const existing = this.entries.find(e => e.version === known.version && e.upgradeFrom === known.upgradeFrom);
      if (!existing) {
        this.entries.push({ ...known });
        changed = true;
      } else {
        // Update download URL if it changed
        if (known.downloadUrl && existing.downloadUrl !== known.downloadUrl) {
          existing.downloadUrl = known.downloadUrl;
          changed = true;
        }
      }
    }
    // Also check for files already on disk from previous runs
    if (existsSync(this.dir)) {
      for (const entry of this.entries) {
        if (entry.filePath) continue;
        const filename = firmwareFilename(entry.version, entry.upgradeFrom);
        const filePath = join(this.dir, filename);
        if (existsSync(filePath)) {
          entry.filePath = filePath;
          changed = true;
        }
      }
    }
    if (changed) this.saveManifest();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Check if a firmware version string indicates pre-1.2.0. */
export function isPreI2x(version: string): boolean {
  const versionPart = version.includes('_') ? version.split('_')[1] : version;
  const match = versionPart.match(/^(\d+)\.(\d+)\./);
  if (!match) return true;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major < 1 || (major === 1 && minor < 2);
}
