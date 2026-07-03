// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { CatalogAddon, CatalogCategory } from './shared/types';
import { scanSpecificAddons } from './addonScanner';
import { loadDatabase, saveDatabase, writeMarkerFile, getYaamDir } from './yaamDatabase';

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
 * Fetch data from a URL as a string.
 */
function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'YAAM/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Download a file from a URL, following redirects. Returns the path to the temp file.
 */
function downloadFile(url: string, destPath: string, maxRedirects = 5, onProgress?: (received: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'YAAM/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, destPath, maxRedirects - 1, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading from ${url}`));
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
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Fetch the complete addon catalog file list from the MMOUI API.
 */
export async function fetchAddonCatalog(forceRefresh = false): Promise<CatalogAddon[]> {
  if (cachedList && !forceRefresh) return cachedList;

  const data = await fetchUrl(API_URL);
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
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf-8');
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
    const data = await fetchUrl(CATEGORY_API_URL);
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
  const data = await fetchUrl(url);
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
  const html = await fetchUrl(pageUrl);

  // Try iframe src first (most reliable)
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+cdn\.esoui\.com[^"']+\.zip[^"']*)["']/i);
  if (iframeMatch) return iframeMatch[1];

  // Fallback: manual link
  const linkMatch = html.match(/href=["'](https?:\/\/cdn\.esoui\.com\/[^"']+\.zip[^"']*)["']/i);
  if (linkMatch) return linkMatch[1];

  throw new Error(`Could not find CDN download link on ${pageUrl}`);
}

/** MD5 hex digest of a file on disk. */
function md5OfFile(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Download and install an addon from the online catalog.
 * Downloads the zip to AddOns/Downloads/, then extracts to AddOns/.
 * Returns the list of installed directory names and any missing dependencies.
 *
 * opts.overlayFor: install this catalog entry as an OVERLAY (language patch /
 * fix pack) into the named folder — the folder's main identity in the YAAM
 * database is preserved and the overlay is tracked in its overlays[] list
 * instead of hijacking the entry (the historic LangPatch problem).
 */
export async function installAddon(
  addonId: string,
  addonsPath: string,
  onProgress?: (phase: 'resolving' | 'downloading' | 'extracting', percent?: number) => void,
  opts?: { overlayFor?: string }
): Promise<{ installed: string[]; missingDeps: string[] }> {
  const downloadsDir = getDownloadsDir(addonsPath);

  // Look up addon info from cache to build a descriptive filename
  let zipName = `addon-${addonId}.zip`;
  if (cachedList) {
    const addonInfo = cachedList.find((a) => a.id === addonId);
    if (addonInfo) {
      // Sanitize name: remove characters not safe for filenames
      const safeName = addonInfo.name.replace(/[<>:"\/\\|?*']/g, '_').replace(/_+/g, '_').trim();
      const safeVersion = addonInfo.version.replace(/[<>:"\/\\|?*']/g, '_').trim();
      zipName = `${safeName}-${safeVersion}.zip`;
    }
  }
  const zipPath = path.join(downloadsDir, zipName);

  // Resolve the download URL and the catalog's current checksum up front.
  // We need the checksum to decide whether a cached ZIP is still valid — a ZIP
  // is named "<Name>-<version>.zip", but the filename alone is not trustworthy:
  // a stale/mislabeled archive (e.g. an r41 zip sitting under an "…r43.zip"
  // name) would otherwise be silently reinstalled while the marker records r43.
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

  // A cached ZIP is reused only when its MD5 matches the catalog checksum.
  // If we have no checksum (offline / lookup failed), fall back to trusting the
  // cached file so offline reinstalls still work.
  const cachedZipValid = fs.existsSync(zipPath)
    && (expectedMd5 ? md5OfFile(zipPath) === expectedMd5 : true);

  if (!cachedZipValid) {
    if (fs.existsSync(zipPath)) {
      // Stale/corrupt cache — drop it before re-downloading.
      try { fs.unlinkSync(zipPath); } catch { /* ignore cleanup errors */ }
    }
    if (!downloadUrl) downloadUrl = await resolveDownloadUrl(addonId);
    onProgress?.('downloading', 0);

    // Download with one retry on MD5 mismatch (transient CDN corruption)
    let lastMd5Error = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      await downloadFile(downloadUrl, zipPath, 5, (received, total) => {
        onProgress?.('downloading', Math.round((received / total) * 100));
      });

      // Verify MD5 if available
      if (expectedMd5) {
        const actualMd5 = md5OfFile(zipPath);
        if (actualMd5 !== expectedMd5) {
          try { fs.unlinkSync(zipPath); } catch { /* ignore cleanup errors */ }
          lastMd5Error = `MD5 mismatch: expected ${expectedMd5}, got ${actualMd5}`;
          if (attempt === 0) continue; // retry once
          throw new Error(lastMd5Error);
        }
      }
      break; // success
    }
  } else {
    onProgress?.('downloading', 100);
  }

  // Extract ZIP using extractAllTo to avoid path sanitization issues
  // with folder names containing hyphens, dots, or numbers (e.g. LibAddonMenu-2.0)
  onProgress?.('extracting', 0);
  const zip = new AdmZip(zipPath);

  // Capture file manifest from ZIP before extraction (for detecting runtime-created files later)
  const zipFilesByDir = new Map<string, string[]>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const parts = entry.entryName.split('/');
    if (parts.length >= 2) {
      const dir = parts[0];
      // Store path relative to the addon folder (strip top-level dir)
      const relPath = parts.slice(1).join('/');
      if (!zipFilesByDir.has(dir)) zipFilesByDir.set(dir, []);
      zipFilesByDir.get(dir)!.push(relPath);
    }
  }

  zip.extractAllTo(addonsPath, true);
  onProgress?.('extracting', 100);

  // Remove stale manifests of the OTHER extension left behind by packaging
  // changes (author switched .addon ↔ .txt between releases — extraction never
  // deletes files, so the old manifest would shadow the new one forever).
  // The freshly extracted ZIP is authoritative for the manifest flavor.
  for (const [dir, files] of zipFilesByDir) {
    const shipsAddon = files.includes(`${dir}.addon`);
    const shipsTxt = files.includes(`${dir}.txt`);
    if (shipsAddon === shipsTxt) continue; // ships both or neither — leave as is
    const stale = path.join(addonsPath, dir, shipsAddon ? `${dir}.txt` : `${dir}.addon`);
    if (fs.existsSync(stale)) {
      try {
        fs.unlinkSync(stale);
        console.log(`[YAAM] Removed stale manifest ${path.basename(stale)} in ${dir} (ZIP ships ${shipsAddon ? '.addon' : '.txt'})`);
      } catch { /* non-fatal — the scanner's dual-manifest rule still picks the newer one */ }
    }
  }

  // Directories shipped in the ZIP (works for both fresh installs and updates)
  const shippedDirs = Array.from(zipFilesByDir.keys());

  // Detect truly new directories (used only for missing-dep check below)
  const afterDirs = fs.readdirSync(addonsPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Scan all shipped addon folders for version info and dependencies
  const installedAddons = scanSpecificAddons(addonsPath, shippedDirs);

  // Update central YAAM database with install metadata
  // (done AFTER scanning so we can store the real local manifest version)
  if (cachedList) {
    const catalogEntry = cachedList.find((a) => a.id === addonId);
    if (catalogEntry) {
      const now = new Date().toISOString();
      const localVersionByDir = new Map<string, string>();
      for (const a of installedAddons) localVersionByDir.set(a.folderName, a.version);
      // Sanity check: after an MD5-verified download the extracted manifest should
      // report the catalog version. If it doesn't, the archive shipped a different
      // version than the catalog advertises — surface it rather than silently
      // recording a version we didn't actually install.
      const primaryLocal = localVersionByDir.get(catalogEntry.name);
      if (primaryLocal && catalogEntry.version && primaryLocal.trim() !== catalogEntry.version.trim()) {
        console.warn(`[YAAM] Version divergence after install of ${catalogEntry.name}: manifest="${primaryLocal}" catalog="${catalogEntry.version}"`);
      }
      const db = loadDatabase(addonsPath);
      let changed = false;
      for (const dir of shippedDirs) {
        const existing = db.addons[dir];

        if (opts?.overlayFor === dir) {
          // ── Overlay install (language patch / fix pack) ──
          // The folder's MAIN identity stays untouched; the overlay is
          // upserted into overlays[] with its own catalog version history.
          const base = existing ?? {
            esouid: '',
            url: '',
            catalogName: '',
            catalogAuthor: '',
            catalogVersion: '',
            localVersion: '',
            installedAt: now,
            updatedAt: now,
          };
          const prev = base.overlays?.find((o) => o.esouid === catalogEntry.id);
          base.overlays = [
            ...(base.overlays ?? []).filter((o) => o.esouid !== catalogEntry.id),
            {
              esouid: catalogEntry.id,
              catalogName: catalogEntry.name,
              catalogVersion: catalogEntry.version,
              catalogDate: catalogEntry.date,
              installedAt: prev?.installedAt || now,
              updatedAt: now,
              installedFiles: zipFilesByDir.get(dir),
              needsReapply: false,
            },
          ];
          // Patches usually replace the folder's manifest — refresh the
          // files-unchanged anchor so Tier-2 tracking of the ORIGINAL stays
          // trusted (its installed version did not change).
          base.localVersion = localVersionByDir.get(dir) || base.localVersion;
          base.updatedAt = now;
          db.addons[dir] = base;
          writeMarkerFile(addonsPath, dir, base);
          changed = true;
          console.log(`[YAAM] Installed overlay #${catalogEntry.id} "${catalogEntry.name}" v${catalogEntry.version} into ${dir} (main identity preserved: #${base.esouid || 'untracked'})`);
          continue;
        }

        // ── Normal install / update of the folder's main addon ──
        // Keep tracked overlays; flag those whose files were just overwritten
        // by this install so the UI can offer a re-apply.
        const newFiles = new Set(zipFilesByDir.get(dir) ?? []);
        const overlays = existing?.overlays?.map((o) => {
          const overwritten = (o.installedFiles ?? []).some((f) => newFiles.has(f));
          if (overwritten && !o.needsReapply) {
            console.log(`[YAAM] Overlay "${o.catalogName}" in ${dir} was overwritten by main-addon install — flagged for re-apply`);
          }
          return overwritten ? { ...o, needsReapply: true } : o;
        });
        const entry = {
          esouid: catalogEntry.id,
          url: catalogEntry.infoUrl,
          catalogName: catalogEntry.name,
          catalogAuthor: catalogEntry.author,
          catalogVersion: catalogEntry.version,
          catalogDate: catalogEntry.date,
          localVersion: localVersionByDir.get(dir) || existing?.localVersion || '',
          installedAt: existing?.installedAt || now,
          updatedAt: now,
          installedFiles: zipFilesByDir.get(dir),
          overlays: overlays?.length ? overlays : undefined,
        };
        db.addons[dir] = entry;
        // Write per-folder .yaam.json marker for resilient tracking
        writeMarkerFile(addonsPath, dir, entry);
        changed = true;
      }
      if (changed) saveDatabase(db, addonsPath);
    }
  }

  // Collect all required dependencies
  const requiredDeps = new Set<string>();
  for (const addon of installedAddons) {
    for (const dep of addon.dependsOn) {
      requiredDeps.add(dep.name);
    }
  }

  // Check which deps are missing (use existing directory names as proxy)
  const allDirNames = new Set(afterDirs);
  const missingDeps = Array.from(requiredDeps).filter(
    (depName) => !depName.startsWith('ZO_') && !allDirNames.has(depName)
  );

  return { installed: shippedDirs, missingDeps };
}

/**
 * Preview .zip files in the top-level AddOns folder that would be moved.
 */
export function previewCleanupDownloads(addonsPath: string): string[] {
  const entries = fs.readdirSync(addonsPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.zip'))
    .map((e) => e.name)
    .sort();
}

/**
 * Move selected .zip files from the top-level AddOns folder into the Downloads subfolder.
 */
export function cleanupDownloadsSelected(addonsPath: string, fileNames: string[]): { moved: string[] } {
  const downloadsDir = getDownloadsDir(addonsPath);
  const moved: string[] = [];
  for (const name of fileNames) {
    const src = path.join(addonsPath, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(downloadsDir, name);
    if (fs.existsSync(dest)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      fs.renameSync(src, path.join(downloadsDir, `${base}_${ts}${ext}`));
    } else {
      fs.renameSync(src, dest);
    }
    moved.push(name);
  }
  return { moved };
}

/**
 * Undo a downloads cleanup: move the given .zip files from Downloads/ back
 * into the AddOns root (skips files that vanished or would overwrite).
 */
export function moveDownloadsBack(addonsPath: string, fileNames: string[]): { restored: string[]; errors: string[] } {
  const downloadsDir = getDownloadsDir(addonsPath);
  const restored: string[] = [];
  const errors: string[] = [];
  for (const name of fileNames) {
    const src = path.join(downloadsDir, name);
    const dest = path.join(addonsPath, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      errors.push(`${name}: already exists in AddOns/`);
      continue;
    }
    try {
      fs.renameSync(src, dest);
      restored.push(name);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { restored, errors };
}

/**
 * Move any .zip files from the top-level AddOns folder into the Downloads subfolder.
 * Returns the list of moved file names.
 */
export function cleanupDownloadsFolder(addonsPath: string): { moved: string[] } {
  const downloadsDir = getDownloadsDir(addonsPath);
  const moved: string[] = [];

  const entries = fs.readdirSync(addonsPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
      const src = path.join(addonsPath, entry.name);
      const dest = path.join(downloadsDir, entry.name);
      // If destination already exists, add a timestamp
      if (fs.existsSync(dest)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const ext = path.extname(entry.name);
        const base = path.basename(entry.name, ext);
        const destRenamed = path.join(downloadsDir, `${base}_${ts}${ext}`);
        fs.renameSync(src, destRenamed);
      } else {
        fs.renameSync(src, dest);
      }
      moved.push(entry.name);
    }
  }

  return { moved };
}
