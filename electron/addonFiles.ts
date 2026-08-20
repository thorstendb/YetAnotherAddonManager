// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Filesystem side of addon installation and of the Downloads folder.
 *
 * Split out of addonCatalogApi so the worker can run these without pulling in
 * the network code and, more importantly, without a second copy of the catalog
 * cache that lives there — two caches drifting apart would be a subtle and
 * very unpleasant bug.  Everything here touches the AddOns tree, which is the
 * part that can block (OneDrive, network shares), so it belongs in the worker.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { CatalogAddon } from './shared/types';
import { scanSpecificAddons } from './addonScanner';
import { loadDatabase, saveDatabase, writeMarkerFile } from './yaamDatabase';

/**
 * Get the Downloads subfolder inside the AddOns folder, creating it if needed.
 */
function getDownloadsDir(addonsPath: string): string {
  const dir = path.join(path.dirname(addonsPath), 'Downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** MD5 hex digest of a file on disk. */
function md5OfFile(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Decide whether the cached ZIP for this addon can be reused.
 *
 * A ZIP is named "<Name>-<version>.zip", but the filename alone is not
 * trustworthy: a stale/mislabeled archive (e.g. an r41 zip sitting under an
 * "…r43.zip" name) would otherwise be silently reinstalled while the marker
 * records r43.  Only a matching checksum counts.  With no checksum available
 * (offline / lookup failed) the cached file is trusted so offline reinstalls
 * still work.  A stale file is removed right away.
 */
export function prepareDownload(
  addonsPath: string,
  zipName: string,
  expectedMd5: string
): { zipPath: string; cachedValid: boolean } {
  const zipPath = path.join(getDownloadsDir(addonsPath), zipName);
  const exists = fs.existsSync(zipPath);
  const cachedValid = exists && (expectedMd5 ? md5OfFile(zipPath) === expectedMd5 : true);
  if (!cachedValid && exists) {
    try { fs.unlinkSync(zipPath); } catch { /* ignore cleanup errors */ }
  }
  return { zipPath, cachedValid };
}

/**
 * Verify a freshly downloaded ZIP against the catalog checksum.
 * Deletes the file on mismatch so a retry starts clean.
 */
export function verifyZip(zipPath: string, expectedMd5: string): { ok: boolean; actualMd5: string } {
  if (!expectedMd5) return { ok: true, actualMd5: '' };
  const actualMd5 = md5OfFile(zipPath);
  if (actualMd5 !== expectedMd5) {
    try { fs.unlinkSync(zipPath); } catch { /* ignore cleanup errors */ }
    return { ok: false, actualMd5 };
  }
  return { ok: true, actualMd5 };
}

/**
 * Extract an addon ZIP into the AddOns folder and record it in the YAAM
 * database.  Returns the installed directory names and any missing
 * dependencies.
 *
 * opts.overlayFor: install this catalog entry as an OVERLAY (language patch /
 * fix pack) into the named folder — the folder's main identity in the YAAM
 * database is preserved and the overlay is tracked in its overlays[] list
 * instead of hijacking the entry (the historic LangPatch problem).
 */
export function extractAndRegister(
  zipPath: string,
  addonsPath: string,
  catalogEntry: CatalogAddon | null,
  opts?: { overlayFor?: string }
): { installed: string[]; missingDeps: string[] } {
  // Extract ZIP using extractAllTo to avoid path sanitization issues
  // with folder names containing hyphens, dots, or numbers (e.g. LibAddonMenu-2.0)
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
  if (catalogEntry) {
    {
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
