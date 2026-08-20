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
import { canEnterDir } from './shared/fsWalk';
import { writeJsonAtomic } from './shared/atomicWrite';
import { threadId } from 'worker_threads';

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

/** Same pattern the hygiene scanner uses for Finder/iCloud conflict copies. */
const CONFLICT_COPY_RE = /^(.+?) (\d+)(\.[^.]+)?$/;

/**
 * Extract a ZIP differentially and atomically.
 *
 * Differential: an entry whose on-disk content is already byte-identical is
 * skipped.  Measured on this project's real Downloads folder, ~75% of all
 * files are unchanged between two releases — skipping them shrinks the write
 * window that cloud sync clients (iCloud, OneDrive) can collide with.
 *
 * Atomic: changed files are written to a temp name and renamed over the
 * target.  An in-place overwrite of a large file is NOT atomic — a sync
 * client can pick up the half-written state and turn it into a conflict copy
 * ("file 2.lua"), which is exactly the damage found in the field.
 *
 * All entry paths are validated against the extraction root first (zip-slip);
 * a traversal entry aborts the whole install before anything is written.
 */
function extractZipDifferential(zip: AdmZip, addonsPath: string): { written: number; unchanged: number } {
  const root = path.resolve(addonsPath);
  const entries = zip.getEntries();

  // Validation pass — refuse the archive outright before touching the disk.
  for (const entry of entries) {
    const dest = path.resolve(root, entry.entryName);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new Error(`ZIP entry escapes the AddOns folder: ${entry.entryName}`);
    }
  }

  let written = 0;
  let unchanged = 0;
  for (const entry of entries) {
    const dest = path.resolve(root, entry.entryName);
    if (entry.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    const data = entry.getData();
    try {
      const st = fs.statSync(dest);
      // Size check first — only read the file when it could actually match.
      if (st.isFile() && st.size === data.length && data.equals(fs.readFileSync(dest))) {
        unchanged++;
        continue;
      }
    } catch { /* target missing — plain new file */ }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.yaamtmp`;
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dest);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
    written++;
  }
  return { written, unchanged };
}

/**
 * Sweep freshly written addon folders for cloud-sync conflict copies.
 *
 * When the AddOns folder lives inside a synced location (iCloud "Documents",
 * OneDrive), the sync client reacts to our writes and can materialize
 * "file 2.lua"-style conflict copies — 354 of them were found on a real
 * install, regenerating with every update.  ESO never loads these (manifests
 * reference exact names), so removing them is always safe.
 *
 * A name is only treated as a conflict copy when the original exists next to
 * it AND the ZIP itself does not ship a file of that name — an addon that
 * legitimately ships "Icon 2.dds" is left alone.
 *
 * Copies are moved (never deleted) into the same Removed/_hygiene/<stamp>/
 * structure the hygiene dialog uses, so the existing restore UI covers them.
 */
function sweepConflictCopies(
  addonsPath: string,
  zipFilesByDir: Map<string, string[]>
): string[] {
  const swept: string[] = [];
  const moves: { src: string; rel: string }[] = [];

  const collect = (dir: string, relBase: string, shipped: Set<string>, depth: number, visited: Set<string>) => {
    if (!canEnterDir(dir, depth, visited)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const m = CONFLICT_COPY_RE.exec(e.name);
      if (m) {
        const original = m[1] + (m[3] ?? '');
        if (names.has(original) && !shipped.has(rel)) {
          moves.push({ src: path.join(dir, e.name), rel });
          continue; // whole subtree goes with it
        }
      }
      if (e.isDirectory()) collect(path.join(dir, e.name), rel, shipped, depth + 1, visited);
    }
  };

  for (const [dir, files] of zipFilesByDir) {
    const shipped = new Set(files.map((f) => `${dir}/${f}`));
    // Also whitelist the directories the ZIP creates
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) shipped.add(`${dir}/${parts.slice(0, i).join('/')}`);
    }
    collect(path.join(addonsPath, dir), dir, shipped, 0, new Set());

    // A conflict copy of the WHOLE addon folder ("SomeAddon 2/") sits next to
    // it in the AddOns root — cover that too.
    let rootEntries: fs.Dirent[];
    try { rootEntries = fs.readdirSync(addonsPath, { withFileTypes: true }); } catch { continue; }
    for (const e of rootEntries) {
      const m = CONFLICT_COPY_RE.exec(e.name);
      if (m && m[1] + (m[3] ?? '') === dir && !zipFilesByDir.has(e.name)) {
        moves.push({ src: path.join(addonsPath, e.name), rel: e.name });
      }
    }
  }

  if (moves.length === 0) return swept;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const removedRoot = path.join(path.dirname(addonsPath), 'Removed', '_hygiene', stamp);
  for (const { src, rel } of moves) {
    try {
      const dest = path.join(removedRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      swept.push(rel);
    } catch { /* locked by the sync client — the hygiene scan offers it later */ }
  }
  if (swept.length > 0) {
    try {
      writeJsonAtomic(path.join(removedRoot, '_meta.json'), { removals: swept });
    } catch { /* listing falls back to first-level entries */ }
  }
  return swept;
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
): { installed: string[]; missingDeps: string[]; unchanged: number; conflictsSwept: string[]; staleRemoved: string[] } {
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

  // Snapshot the previous install manifests BEFORE writing — needed below to
  // remove files the new release no longer ships.
  const prevDb = loadDatabase(addonsPath);

  const { unchanged } = extractZipDifferential(zip, addonsPath);

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

  // Remove files the PREVIOUS release shipped but the new one does not.
  // Extraction never deletes, so without this every update leaves a mixed
  // state behind: new files next to orphans of the old version (old modules,
  // renamed lua files) that ESO may still load via a stale manifest.  Only
  // files recorded in OUR OWN install manifest are candidates — runtime files
  // and user additions are never listed there, and overlay-installed files
  // are explicitly protected.
  const staleRemoved: string[] = [];
  if (!opts?.overlayFor) {
    for (const [dir, files] of zipFilesByDir) {
      const prev = prevDb.addons[dir];
      if (!prev?.installedFiles?.length) continue;
      const newFiles = new Set(files);
      const overlayFiles = new Set<string>();
      for (const o of prev.overlays ?? []) {
        for (const f of o.installedFiles ?? []) overlayFiles.add(f);
      }
      for (const rel of prev.installedFiles) {
        if (newFiles.has(rel) || overlayFiles.has(rel)) continue;
        const target = path.join(addonsPath, dir, rel);
        // resolve-guard: installedFiles comes from our own marker, but the
        // marker lives in a folder other tools write to — never trust it blindly.
        if (!path.resolve(target).startsWith(path.resolve(addonsPath, dir) + path.sep)) continue;
        try {
          if (fs.existsSync(target) && fs.statSync(target).isFile()) {
            fs.unlinkSync(target);
            staleRemoved.push(`${dir}/${rel}`);
            // Prune now-empty parent directories up to the addon root.
            let parent = path.dirname(target);
            const stop = path.resolve(addonsPath, dir);
            while (parent !== stop && fs.readdirSync(parent).length === 0) {
              fs.rmdirSync(parent);
              parent = path.dirname(parent);
            }
          }
        } catch { /* non-fatal — the file simply stays */ }
      }
    }
  }

  // Clean up conflict copies a cloud sync client may have created — both
  // pre-existing ones and those materializing right now in reaction to the
  // writes above.
  const conflictsSwept = sweepConflictCopies(addonsPath, zipFilesByDir);

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

  return { installed: shippedDirs, missingDeps, unchanged, conflictsSwept, staleRemoved };
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
