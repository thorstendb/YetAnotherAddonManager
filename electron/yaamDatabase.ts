// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import type { YaamMarker, YaamOverlayEntry } from './shared/types';
import { writeJsonAtomic } from './shared/atomicWrite';

/**
 * Per-addon metadata stored in the central YAAM database.
 * Keyed by addon folder name (must be unique in ESO).
 */
export interface YaamAddonEntry {
  /** ESOUI catalog UID (e.g. "1346") */
  esouid: string;
  /** ESOUI info URL */
  url: string;
  /** Catalog name at time of install/update */
  catalogName: string;
  /** Author from catalog */
  catalogAuthor: string;
  /** Version string from the ESOUI catalog record */
  catalogVersion: string;
  /** Catalog date (epoch seconds) at time of install/update — detects re-publishes */
  catalogDate?: number;
  /** Version string from the addon's local manifest (## Version) */
  localVersion: string;
  /** ISO timestamp of first install via YAAM */
  installedAt: string;
  /** ISO timestamp of last update via YAAM */
  updatedAt: string;
  /** Relative file paths from the original ZIP (install manifest for detecting runtime-created files) */
  installedFiles?: string[];
  /** Overlays (language patches, fixes) layered into this addon's folder */
  overlays?: YaamOverlayEntry[];
}

/** Full database structure */
export interface YaamDatabase {
  /** Schema version for future migrations */
  schemaVersion: number;
  /** Map of folderName → addon entry */
  addons: Record<string, YaamAddonEntry>;
}

const DB_FILE = 'yaam-addons.json';
const CURRENT_SCHEMA = 1;

/**
 * Get the YAAM data directory inside the ESO live folder.
 * e.g. .../Elder Scrolls Online/live/YAAM/
 */
export function getYaamDir(addonsPath: string): string {
  const dir = path.join(path.dirname(addonsPath), 'YAAM');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getDbPath(addonsPath: string): string {
  return path.join(getYaamDir(addonsPath), DB_FILE);
}

/** Load the database from disk. Returns empty DB if file doesn't exist. */
export function loadDatabase(addonsPath: string): YaamDatabase {
  const dbPath = getDbPath(addonsPath);
  try {
    if (fs.existsSync(dbPath)) {
      const raw = fs.readFileSync(dbPath, 'utf-8');
      const db = JSON.parse(raw) as YaamDatabase;
      if (db.schemaVersion && db.addons) return db;
    }
  } catch (err) {
    console.error('Failed to load YAAM database:', err);
  }
  return { schemaVersion: CURRENT_SCHEMA, addons: {} };
}

/** Save the database to disk. */
export function saveDatabase(db: YaamDatabase, addonsPath: string): void {
  const dbPath = getDbPath(addonsPath);
  try {
    writeJsonAtomic(dbPath, db);
  } catch (err) {
    console.error('Failed to save YAAM database:', err);
  }
}

/** Get a single entry by folder name. */
export function getEntry(addonsPath: string, folderName: string): YaamAddonEntry | undefined {
  const db = loadDatabase(addonsPath);
  return db.addons[folderName];
}

/** Set or update a single entry. */
export function setEntry(addonsPath: string, folderName: string, entry: YaamAddonEntry): void {
  const db = loadDatabase(addonsPath);
  db.addons[folderName] = entry;
  saveDatabase(db, addonsPath);
}

/** Update specific fields of an existing entry. */
export function updateEntry(addonsPath: string, folderName: string, updates: Partial<YaamAddonEntry>): boolean {
  const db = loadDatabase(addonsPath);
  const existing = db.addons[folderName];
  if (!existing) return false;
  db.addons[folderName] = { ...existing, ...updates };
  saveDatabase(db, addonsPath);
  return true;
}

/** Remove an entry by folder name. Returns true if it existed. */
export function removeEntry(addonsPath: string, folderName: string): boolean {
  const db = loadDatabase(addonsPath);
  if (!(folderName in db.addons)) return false;
  delete db.addons[folderName];
  saveDatabase(db, addonsPath);
  return true;
}

/** Batch update: set multiple entries at once (single write). */
export function setEntries(addonsPath: string, entries: Record<string, YaamAddonEntry>): void {
  const db = loadDatabase(addonsPath);
  Object.assign(db.addons, entries);
  saveDatabase(db, addonsPath);
}

/** Get all entries as a Record. */
export function getAllEntries(addonsPath: string): Record<string, YaamAddonEntry> {
  return loadDatabase(addonsPath).addons;
}

// ─── Tracking-state backup (DB + all markers) ───

/**
 * Back up the complete tracking state — the central DB plus every per-folder
 * .yaam.json marker — into YAAM/Backup/Tracking/<stamp>/.  Used before
 * destructive tracking operations (baseline commit, marker cleanup) so they
 * are undoable like every other YAAM action.
 * Returns the backup directory ('' when nothing was backed up).
 */
export function backupTrackingState(addonsPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dir = path.join(getYaamDir(addonsPath), 'Backup', 'Tracking', stamp);
  try {
    const db = loadDatabase(addonsPath);
    const markers: Record<string, YaamMarker> = {};
    if (fs.existsSync(addonsPath)) {
      for (const entry of fs.readdirSync(addonsPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const m = readMarkerFile(addonsPath, entry.name);
        if (m) markers[entry.name] = m;
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, 'yaam-addons.json'), db);
    writeJsonAtomic(path.join(dir, 'markers.json'), markers);
    return dir;
  } catch (err) {
    console.error('Failed to back up tracking state:', err);
    return '';
  }
}

/**
 * Restore a tracking-state backup: central DB and all markers are put back
 * exactly as captured.  Markers of folders that no longer exist are skipped;
 * markers created after the backup are removed (full state swap).
 */
export function restoreTrackingState(addonsPath: string, backupDir: string): { restored: boolean; markers: number; error?: string } {
  try {
    const dbFile = path.join(backupDir, 'yaam-addons.json');
    const markersFile = path.join(backupDir, 'markers.json');
    if (!fs.existsSync(dbFile) || !fs.existsSync(markersFile)) {
      return { restored: false, markers: 0, error: 'Tracking backup not found' };
    }
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf-8')) as YaamDatabase;
    const markers = JSON.parse(fs.readFileSync(markersFile, 'utf-8')) as Record<string, YaamMarker>;
    saveDatabase(db, addonsPath);
    let count = 0;
    if (fs.existsSync(addonsPath)) {
      for (const entry of fs.readdirSync(addonsPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const markerPath = path.join(addonsPath, entry.name, MARKER_FILE);
        const m = markers[entry.name];
        if (m) {
          const dbEntry = db.addons[entry.name];
          if (dbEntry) {
            writeMarkerFile(addonsPath, entry.name, dbEntry);
          } else {
            writeJsonAtomic(markerPath, m);
          }
          count++;
        } else if (fs.existsSync(markerPath)) {
          fs.unlinkSync(markerPath); // marker created after the backup
        }
      }
    }
    return { restored: true, markers: count };
  } catch (err) {
    return { restored: false, markers: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Per-folder .yaam.json marker files ───

const MARKER_FILE = '.yaam.json';

/**
 * Write a .yaam.json marker file into an addon folder.
 * This provides resilient tracking that survives DB loss.
 */
export function writeMarkerFile(addonsPath: string, folderName: string, entry: YaamAddonEntry): void {
  const markerPath = path.join(addonsPath, folderName, MARKER_FILE);
  const marker: YaamMarker = {
    esouid: entry.esouid,
    catalogVersion: entry.catalogVersion,
    catalogDate: entry.catalogDate,
    catalogName: entry.catalogName,
    localVersion: entry.localVersion || undefined,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
    overlays: entry.overlays?.length ? entry.overlays : undefined,
    installedFiles: entry.installedFiles?.length ? entry.installedFiles : undefined,
  };
  try {
    writeJsonAtomic(markerPath, marker);
  } catch (err) {
    console.error(`Failed to write ${MARKER_FILE} for ${folderName}:`, err);
  }
}

/**
 * Read a .yaam.json marker file from an addon folder.
 * Returns null if the file doesn't exist or is invalid.
 */
export function readMarkerFile(addonsPath: string, folderName: string): YaamMarker | null {
  const markerPath = path.join(addonsPath, folderName, MARKER_FILE);
  try {
    if (!fs.existsSync(markerPath)) return null;
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.esouid) return null;
    return {
      esouid: data.esouid,
      catalogVersion: data.catalogVersion || data.version || '',
      catalogDate: typeof data.catalogDate === 'number' ? data.catalogDate : undefined,
      catalogName: data.catalogName || data.name || '',
      localVersion: typeof data.localVersion === 'string' ? data.localVersion : undefined,
      installedAt: data.installedAt || '',
      updatedAt: data.updatedAt || '',
      overlays: Array.isArray(data.overlays) ? data.overlays as YaamOverlayEntry[] : undefined,
      installedFiles: Array.isArray(data.installedFiles) ? data.installedFiles as string[] : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Delete all .yaam.json marker files from addon folders and clear
 * catalogVersion in the DB so every addon falls to best-effort detection.
 * The complete tracking state is backed up first, so this is undoable via
 * restoreTrackingState.  Returns the count and the backup directory.
 */
export function cleanupMarkerFiles(addonsPath: string): { count: number; backupDir: string } {
  if (!addonsPath || !fs.existsSync(addonsPath)) return { count: 0, backupDir: '' };
  const backupDir = backupTrackingState(addonsPath);
  let count = 0;
  const db = loadDatabase(addonsPath);
  let dbChanged = false;
  try {
    const entries = fs.readdirSync(addonsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(addonsPath, entry.name, MARKER_FILE);
      try {
        if (fs.existsSync(markerPath)) {
          fs.unlinkSync(markerPath);
          count++;
        }
      } catch { /* skip */ }
      // Also clear catalogVersion/catalogDate in DB so Tier 3 kicks in
      if (db.addons[entry.name]?.catalogVersion) {
        db.addons[entry.name].catalogVersion = '';
        db.addons[entry.name].catalogDate = undefined;
        dbChanged = true;
      }
    }
  } catch (err) {
    console.error('Failed to cleanup marker files:', err);
  }
  if (dbChanged) saveDatabase(db, addonsPath);
  return { count, backupDir };
}

/**
 * Migrate old per-folder .yaam.json files into the central database.
 * Reads each addon folder, imports metadata, and deletes the old file.
 * Returns { migrated, errors } counts.
 */
export function migrateFromFolderFiles(addonsPath: string): { migrated: number; errors: number } {
  const result = { migrated: 0, errors: 0 };
  if (!addonsPath || !fs.existsSync(addonsPath)) return result;

  const db = loadDatabase(addonsPath);
  let changed = false;

  try {
    const entries = fs.readdirSync(addonsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(addonsPath, entry.name, '.yaam.json');
      try {
        if (!fs.existsSync(metaPath)) continue;
        const raw = fs.readFileSync(metaPath, 'utf-8');
        const old = JSON.parse(raw);
        if (!old.esouid) continue;

        // Only migrate if not already in DB (don't overwrite newer data).
        // If the addon IS already in the DB, leave the .yaam.json in place —
        // it is actively used by scanAddonsFolder as a "ground truth" marker
        // for what version is on disk.  Deleting it would cause the scan to
        // clear catalogVersion, defeating Tier-2 update detection.
        if (!db.addons[entry.name]) {
          db.addons[entry.name] = {
            esouid: old.esouid,
            url: old.url || '',
            catalogName: old.name || '',
            catalogAuthor: old.author || '',
            catalogVersion: old.version || '',
            localVersion: '', // will be filled by reconciliation
            installedAt: old.installedAt || new Date().toISOString(),
            updatedAt: old.updatedAt || new Date().toISOString(),
          };
          changed = true;

          // Delete migrated file (data now lives in the central DB)
          fs.unlinkSync(metaPath);
          result.migrated++;
        }
      } catch (err) {
        console.error(`Failed to migrate .yaam.json for ${entry.name}:`, err);
        result.errors++;
      }
    }
  } catch (err) {
    console.error('Failed to scan addons folder for migration:', err);
  }

  if (changed) saveDatabase(db, addonsPath);
  return result;
}
