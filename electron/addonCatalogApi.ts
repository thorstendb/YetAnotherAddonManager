// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { CatalogAddon } from './shared/types';
import { scanAddonsFolder } from './addonScanner';

const API_URL = 'https://api.mmoui.com/v3/game/ESO/filelist.json';

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
        file.close();
        resolve();
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

/**
 * Download and install an addon from the online catalog.
 * Downloads the zip to AddOns/Downloads/, then extracts to AddOns/.
 * Returns the list of installed directory names and any missing dependencies.
 */
export async function installAddon(
  addonId: string,
  addonsPath: string,
  onProgress?: (phase: 'resolving' | 'downloading' | 'extracting', percent?: number) => void
): Promise<{ installed: string[]; missingDeps: string[] }> {
  const downloadsDir = getDownloadsDir(addonsPath);

  // Look up addon info from cache to build a descriptive filename
  let zipName = `addon-${addonId}.zip`;
  if (cachedList) {
    const addonInfo = cachedList.find((a) => a.id === addonId);
    if (addonInfo) {
      // Sanitize name: remove characters not safe for filenames
      const safeName = addonInfo.name.replace(/[<>:"\/ |?*]/g, '_').replace(/_+/g, '_').trim();
      const safeVersion = addonInfo.version.replace(/[<>:"\/ |?*]/g, '_').trim();
      zipName = `${safeName}-${safeVersion}.zip`;
    }
  }
  const zipPath = path.join(downloadsDir, zipName);

  // Record existing directories before install
  const existingDirs = new Set(
    fs.readdirSync(addonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  );

  // Skip download if the exact same versioned ZIP already exists (reinstall case)
  if (!fs.existsSync(zipPath)) {
    // Resolve the real CDN download URL from the ESOUI download page
    onProgress?.('resolving');
    const downloadUrl = await resolveDownloadUrl(addonId);
    onProgress?.('downloading', 0);
    await downloadFile(downloadUrl, zipPath, 5, (received, total) => {
      onProgress?.('downloading', Math.round((received / total) * 100));
    });
  } else {
    onProgress?.('downloading', 100);
  }

  // Extract ZIP using extractAllTo to avoid path sanitization issues
  // with folder names containing hyphens, dots, or numbers (e.g. LibAddonMenu-2.0)
  onProgress?.('extracting', 0);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(addonsPath, true);
  onProgress?.('extracting', 100);

  // Find newly created directories
  const afterDirs = fs.readdirSync(addonsPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const newDirs = afterDirs.filter((d) => !existingDirs.has(d));

  // Scan newly installed addons for dependencies
  const allAddons = scanAddonsFolder(addonsPath);
  const installedAddons = allAddons.filter((a) => newDirs.includes(a.folderName));

  // Collect all required dependencies
  const requiredDeps = new Set<string>();
  for (const addon of installedAddons) {
    for (const dep of addon.dependsOn) {
      requiredDeps.add(dep.name);
    }
  }

  // Check which deps are missing
  const installedNames = new Set(allAddons.map((a) => a.folderName));
  const installedTitles = new Set(allAddons.map((a) => a.title));
  const missingDeps = Array.from(requiredDeps).filter(
    (depName) => !depName.startsWith('ZO_') && !installedNames.has(depName) && !installedTitles.has(depName)
  );

  return { installed: newDirs, missingDeps };
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
