// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { CatalogAddon, CatalogCategory } from './shared/types';
import { TIMEOUTS } from './shared/timeouts';
import { getYaamDir } from './yaamDatabase';
import { callFs } from './fsWorkerHost';
import { writeFileAtomic } from './shared/atomicWrite';

const API_URL = 'https://api.mmoui.com/v3/game/ESO/filelist.json';
const CATEGORY_API_URL = 'https://api.mmoui.com/v3/game/ESO/categorylist.json';

interface RawCatalogAddon {
  UID: string;
  UICATID: string;
  UIVersion: string;
  UIDate: number;
  UIName: string;
  UIAuthorName: string;
  UIFileInfoURL: string;
  UIDownloadTotal: string;
  UIDownloadMonthly: string;
  UIFavoriteTotal: string;
  UICompatibility: { version: string; name: string }[] | null;
  UIDir: string[];
  UIIMG_Thumbs: string[] | null;
  UIIMGs: string[] | null;
  UISiblings: null;
  UIDonationLink: string | null;
}

let cachedList: CatalogAddon[] | null = null;
let cachedCategories: CatalogCategory[] | null = null;

function transformAddon(raw: RawCatalogAddon): CatalogAddon {
  return {
    id: raw.UID,
    categoryId: raw.UICATID,
    name: raw.UIName,
    author: raw.UIAuthorName,
    version: raw.UIVersion,
    // MMOUI API returns UIDate in milliseconds – normalize to seconds
    date: Math.floor(raw.UIDate / 1000),
    infoUrl: raw.UIFileInfoURL,
    totalDownloads: parseInt(raw.UIDownloadTotal) || 0,
    monthlyDownloads: parseInt(raw.UIDownloadMonthly) || 0,
    favorites: parseInt(raw.UIFavoriteTotal) || 0,
    compatibility: raw.UICompatibility || [],
    directories: raw.UIDir || [],
    thumbnails: raw.UIIMG_Thumbs || [],
    images: raw.UIIMGs || [],
    donationLink: raw.UIDonationLink || '',
  };
}

/**
 * Per-request network budget.  Callers pass what suits their endpoint; see
 * shared/timeouts.ts for the values and the reasoning behind them.
 */
export interface FetchOptions {
  /** TCP/TLS connection establishment. */
  connectTimeoutMs?: number;
  /** No socket activity on an established connection. */
  idleTimeoutMs?: number;
  /** Whole request including the response body.  Omit for downloads that may
   *  legitimately run long — idle detection still covers a true stall. */
  totalTimeoutMs?: number;
  /** Remaining redirect hops. */
  maxRedirects?: number;
}

const MAX_REDIRECTS = 5;

/**
 * Guard the connection-establishment phase.
 *
 * req.setTimeout() does NOT reliably cover it: while the socket is still in
 * `connecting` state its callback is late or does not fire at all, so a
 * firewall that DROPs SYN packets falls through to the OS retry timeout
 * (tens of seconds, platform dependent).  This timer starts immediately and is
 * cleared as soon as the connection is up.
 */
function guardConnect(req: http.ClientRequest, timeoutMs: number, onTimeout: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const clear = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  req.on('socket', (socket) => {
    if (!socket.connecting) return; // reused/keep-alive socket: already connected
    timer = setTimeout(onTimeout, timeoutMs);
    socket.once('connect', clear);
    socket.once('close', clear);
  });
  return clear;
}

/**
 * Fetch data from a URL as a string.
 * Aborts on idle/total timeout and refuses to follow redirects endlessly.
 */
function fetchUrl(url: string, opts: FetchOptions = {}): Promise<string> {
  const connectMs = opts.connectTimeoutMs ?? TIMEOUTS.net.connect;
  const idleMs = opts.idleTimeoutMs ?? TIMEOUTS.net.idle;
  const totalMs = opts.totalTimeoutMs ?? TIMEOUTS.net.small;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    const client = url.startsWith('https') ? https : http;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let clearConnectGuard: (() => void) | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      clearConnectGuard?.();
      action();
    };

    const req = client.get(url, { headers: { 'User-Agent': 'YAAM/1.0' } }, (res) => {
      clearConnectGuard?.();
      // Follow redirects (bounded, and resolved against the current URL so
      // relative Location headers work).
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume(); // drain so the socket can be released
        finish(() => {
          req.destroy();
          fetchUrl(next, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve).catch(reject);
        });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish(() => {
          req.destroy();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        });
        return;
      }
      let data = '';
      // Decode as UTF-8 across chunk boundaries (implicit chunk.toString()
      // would corrupt multi-byte characters split across two chunks).
      res.setEncoding('utf-8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => finish(() => resolve(data)));
      res.on('error', (err) => finish(() => { req.destroy(); reject(err); }));
    });

    clearConnectGuard = guardConnect(req, connectMs, () => {
      finish(() => {
        req.destroy();
        reject(new Error(`Could not connect to ${new URL(url).host} within ${connectMs / 1000}s (firewall, DNS or VPN?)`));
      });
    });

    deadline = setTimeout(() => {
      finish(() => {
        req.destroy();
        reject(new Error(`Timeout after ${totalMs / 1000}s for ${url}`));
      });
    }, totalMs);

    req.setTimeout(idleMs, () => {
      finish(() => {
        req.destroy();
        reject(new Error(`No response within ${idleMs / 1000}s from ${url} (connection stalled)`));
      });
    });
    req.on('error', (err) => finish(() => reject(err)));
  });
}

/**
 * Download a file from a URL, following redirects. Returns the path to the temp file.
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (received: number, total: number) => void,
  opts: FetchOptions = {}
): Promise<void> {
  const connectMs = opts.connectTimeoutMs ?? TIMEOUTS.net.connect;
  const idleMs = opts.idleTimeoutMs ?? TIMEOUTS.net.idle;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }
    const client = url.startsWith('https') ? https : http;
    let settled = false;
    let clearConnectGuard: (() => void) | undefined;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearConnectGuard?.();
      req.destroy();
      fs.unlink(destPath, () => {});
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearConnectGuard?.();
      resolve();
    };

    const req = client.get(url, { headers: { 'User-Agent': 'YAAM/1.0' } }, (res) => {
      clearConnectGuard?.();
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        if (settled) return;
        settled = true;
        req.destroy();
        downloadFile(next, destPath, onProgress, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`HTTP ${res.statusCode} downloading from ${url}`));
        return;
      }
      const totalSize = parseInt(String(res.headers['content-length'] || '0'), 10);
      let received = 0;
      const file = fs.createWriteStream(destPath);
      if (onProgress && totalSize > 0) {
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received, totalSize);
        });
      }
      res.on('error', fail);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => succeed());
      });
      file.on('error', fail);
    });

    // A download that stalls mid-stream must not hang the app forever.
    // setTimeout() fires on socket inactivity, so a slow-but-progressing
    // download is not killed — only a truly stuck one.  No overall deadline
    // here: addon archives can legitimately take a while on a slow line.
    clearConnectGuard = guardConnect(req, connectMs, () => {
      fail(new Error(`Could not connect to ${new URL(url).host} within ${connectMs / 1000}s (firewall, DNS or VPN?)`));
    });
    req.setTimeout(idleMs, () => {
      fail(new Error(`Download stalled (no data for ${idleMs / 1000}s) from ${url}`));
    });
    req.on('error', fail);
  });
}

/**
 * Fetch the complete addon catalog file list from the MMOUI API.
 */
export async function fetchAddonCatalog(forceRefresh = false): Promise<CatalogAddon[]> {
  if (cachedList && !forceRefresh) return cachedList;

  // The big one (~2.5 MB) — allow a longer overall budget.
  const data = await fetchUrl(API_URL, { totalTimeoutMs: TIMEOUTS.net.catalog });
  const raw: RawCatalogAddon[] = JSON.parse(data);
  cachedList = raw.map(transformAddon);
  return cachedList;
}

// ─── Catalog Snapshot & Diff ───

const SNAPSHOT_FILE = 'yaam-catalog-snapshot.json';

/** Compact per-UID entry stored in the snapshot */
interface SnapshotEntry { v: string; d: number }

/** Result of comparing two catalog snapshots */
export interface CatalogDiff {
  /** UIDs where version or date changed */
  changed: Map<string, { oldVersion: string; newVersion: string }>;
  /** UIDs newly appearing in catalog */
  added: Set<string>;
  /** UIDs removed from catalog */
  removed: Set<string>;
}

/**
 * Load the previous catalog snapshot from disk.
 * Returns null if no snapshot exists.
 */
function loadCatalogSnapshot(addonsPath: string): Record<string, SnapshotEntry> | null {
  try {
    const snapshotPath = path.join(getYaamDir(addonsPath), SNAPSHOT_FILE);
    if (!fs.existsSync(snapshotPath)) return null;
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save a catalog snapshot to disk (compact: UID → {version, date}).
 */
function saveCatalogSnapshot(addonsPath: string, catalog: CatalogAddon[]): void {
  const snapshot: Record<string, SnapshotEntry> = {};
  for (const c of catalog) {
    snapshot[c.id] = { v: c.version, d: c.date };
  }
  try {
    const snapshotPath = path.join(getYaamDir(addonsPath), SNAPSHOT_FILE);
    writeFileAtomic(snapshotPath, JSON.stringify(snapshot));
  } catch (err) {
    console.error('Failed to save catalog snapshot:', err);
  }
}

/**
 * Compare previous snapshot with a fresh catalog and save the new snapshot.
 * Returns the diff (changed/added/removed UIDs), or null on first run.
 */
export function updateCatalogSnapshot(
  addonsPath: string,
  catalog: CatalogAddon[]
): CatalogDiff | null {
  const oldSnapshot = loadCatalogSnapshot(addonsPath);

  // Do NOT save the new snapshot here — the renderer calls commitCatalogSnapshot()
  // after the user has had a chance to see and act on the diff.
  // This ensures that addons the user did not update stay in the diff next session.

  if (!oldSnapshot) {
    // First run: save initial snapshot so we have a baseline for next session
    saveCatalogSnapshot(addonsPath, catalog);
    return null;
  }

  const changed = new Map<string, { oldVersion: string; newVersion: string }>();
  const added = new Set<string>();
  const removed = new Set<string>();

  for (const c of catalog) {
    const old = oldSnapshot[c.id];
    if (!old) {
      added.add(c.id);
    } else if (old.v !== c.version || old.d !== c.date) {
      changed.set(c.id, { oldVersion: old.v, newVersion: c.version });
    }
  }

  const newIds = new Set(catalog.map(c => c.id));
  for (const uid of Object.keys(oldSnapshot)) {
    if (!newIds.has(uid)) removed.add(uid);
  }

  return { changed, added, removed };
}

/**
 * Commit (save) the current catalog as the new snapshot baseline.
 * Called after updates are applied so that updated addons are removed from
 * the diff on next launch.  Also called on app quit so newly changed catalog
 * entries that the user chose NOT to update are remembered for next session.
 */
export function commitCatalogSnapshot(addonsPath: string, catalog: CatalogAddon[]): void {
  saveCatalogSnapshot(addonsPath, catalog);
}

/**
 * Fetch addon categories from the MMOUI API.
 * Returns live data; cached in memory after first fetch.
 */
export async function fetchCategories(forceRefresh = false): Promise<CatalogCategory[]> {
  if (cachedCategories && !forceRefresh) return cachedCategories;

  try {
    const data = await fetchUrl(CATEGORY_API_URL, { totalTimeoutMs: TIMEOUTS.net.small });
    const raw: { UICATID: string; UICATTitle: string; UICATFileCount: string; UICATParentIDs: string[] }[] = JSON.parse(data);
    cachedCategories = raw.map(r => ({
      id: r.UICATID,
      name: r.UICATTitle,
      fileCount: parseInt(r.UICATFileCount) || 0,
      parentIds: r.UICATParentIDs || [],
    }));
    return cachedCategories;
  } catch {
    return [];
  }
}

/** Cache for on-demand filedetails lookups */
const detailsCache = new Map<string, { description: string; changeLog: string; md5: string; downloadUrl: string; fileName: string }>();

/**
 * Fetch addon details (description, changelog, md5, downloadUrl, fileName) from the MMOUI filedetails endpoint.
 * Results are cached in memory.
 */
export async function fetchAddonDetails(uid: string): Promise<{ description: string; changeLog: string; md5: string; downloadUrl: string; fileName: string }> {
  const cached = detailsCache.get(uid);
  if (cached) return cached;

  const url = `https://api.mmoui.com/v3/game/ESO/filedetails/${encodeURIComponent(uid)}.json`;
  const data = await fetchUrl(url, { totalTimeoutMs: TIMEOUTS.net.small });
  const arr: { UIDescription?: string; UIChangeLog?: string; UIMD5?: string; UIDownload?: string; UIFileName?: string }[] = JSON.parse(data);
  const entry = arr[0] || {};
  const result = {
    description: entry.UIDescription || '',
    changeLog: entry.UIChangeLog || '',
    md5: entry.UIMD5 || '',
    downloadUrl: entry.UIDownload || '',
    fileName: entry.UIFileName || '',
  };
  detailsCache.set(uid, result);
  return result;
}

/**
 * Get the Downloads subfolder inside the AddOns folder, creating it if needed.
 */
function getDownloadsDir(addonsPath: string): string {
  const dir = path.join(path.dirname(addonsPath), 'Downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the actual CDN download URL from the addon download page.
 * The page embeds an iframe pointing to the real .zip on cdn.esoui.com.
 */
async function resolveDownloadUrl(addonId: string): Promise<string> {
  const pageUrl = `https://www.esoui.com/downloads/download${addonId}`;
  const html = await fetchUrl(pageUrl, { totalTimeoutMs: TIMEOUTS.net.small });

  // Try iframe src first (most reliable)
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+cdn\.esoui\.com[^"']+\.zip[^"']*)["']/i);
  if (iframeMatch) return iframeMatch[1];

  // Fallback: manual link
  const linkMatch = html.match(/href=["'](https?:\/\/cdn\.esoui\.com\/[^"']+\.zip[^"']*)["']/i);
  if (linkMatch) return linkMatch[1];

  throw new Error(`Could not find CDN download link on ${pageUrl}`);
}

/**
 * Download and install an addon from the online catalog.
 *
 * Split across the process boundary on purpose: the network part (details
 * lookup, CDN resolve, download) stays here in the main process, where the
 * catalog cache lives and where sockets are non-blocking anyway.  Everything
 * that touches the AddOns tree — checksum checks, extraction, database and
 * marker writes — runs in the filesystem worker, so a stuck folder produces a
 * timeout instead of freezing the app.
 */
export async function installAddon(
  addonId: string,
  addonsPath: string,
  onProgress?: (phase: 'resolving' | 'downloading' | 'extracting', percent?: number) => void,
  opts?: { overlayFor?: string }
): Promise<{ installed: string[]; missingDeps: string[]; unchanged: number; conflictsSwept: string[]; staleRemoved: string[] }> {
  // Look up addon info from cache to build a descriptive filename
  const catalogEntry = cachedList?.find((a) => a.id === addonId) ?? null;
  let zipName = `addon-${addonId}.zip`;
  if (catalogEntry) {
    // Sanitize name: remove characters not safe for filenames
    const safeName = catalogEntry.name.replace(/[<>:"\/\\|?*']/g, '_').replace(/_+/g, '_').trim();
    const safeVersion = catalogEntry.version.replace(/[<>:"\/\\|?*']/g, '_').trim();
    zipName = `${safeName}-${safeVersion}.zip`;
  }

  onProgress?.('resolving');
  let downloadUrl = '';
  let expectedMd5 = '';
  try {
    const details = await fetchAddonDetails(addonId);
    expectedMd5 = details.md5 || '';
    downloadUrl = details.downloadUrl || '';
  } catch {
    // Offline or lookup failed — handled below (cached ZIP is trusted as a fallback).
  }

  const { zipPath, cachedValid } = await callFs(
    'prepareDownload',
    [addonsPath, zipName, expectedMd5],
    TIMEOUTS.fs.install
  );

  if (!cachedValid) {
    if (!downloadUrl) downloadUrl = await resolveDownloadUrl(addonId);
    onProgress?.('downloading', 0);

    // Download with one retry on MD5 mismatch (transient CDN corruption)
    for (let attempt = 0; attempt < 2; attempt++) {
      await downloadFile(downloadUrl, zipPath, (received, total) => {
        onProgress?.('downloading', Math.round((received / total) * 100));
      });

      const { ok, actualMd5 } = await callFs('verifyZip', [zipPath, expectedMd5], TIMEOUTS.fs.install);
      if (ok) break;
      if (attempt === 1) {
        throw new Error(`MD5 mismatch: expected ${expectedMd5}, got ${actualMd5}`);
      }
    }
  } else {
    onProgress?.('downloading', 100);
  }

  // Extraction reports as a single step; it is fast compared to the download
  // and reporting sub-percentages would mean streaming progress out of the
  // worker for no real gain.
  onProgress?.('extracting', 0);
  const result = await callFs(
    'extractAndRegister',
    [zipPath, addonsPath, catalogEntry, opts],
    TIMEOUTS.fs.install
  );
  onProgress?.('extracting', 100);
  return result;
}
