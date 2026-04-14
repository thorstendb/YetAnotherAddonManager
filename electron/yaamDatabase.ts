// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import type { YaamMarker } from './shared/types';

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
  /** Version string from the addon's local manifest (## Version) */
  localVersion: string;
  /** ISO timestamp of first install via YAAM */
  installedAt: string;
  /** ISO timestamp of last update via YAAM */
  updatedAt: string;
  /** Relative file paths from the original ZIP (install manifest for detecting runtime-created files) */
  installedFiles?: string[];
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
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
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
    catalogName: entry.catalogName,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
  };
  try {
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
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
      catalogName: data.catalogName || data.name || '',
      installedAt: data.installedAt || '',
      updatedAt: data.updatedAt || '',
    };
  } catch {
    return null;
  }
}

/**
 * Delete all .yaam.json marker files from addon folders and clear
 * catalogVersion in the DB so every addon falls to best-effort detection.
 * Returns the number of marker files deleted.
 */
export function cleanupMarkerFiles(addonsPath: string): number {
  if (!addonsPath || !fs.existsSync(addonsPath)) return 0;
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
      // Also clear catalogVersion in DB so Tier 3 kicks in
      if (db.addons[entry.name]?.catalogVersion) {
        db.addons[entry.name].catalogVersion = '';
        dbChanged = true;
      }
    }
  } catch (err) {
    console.error('Failed to cleanup marker files:', err);
  }
  if (dbChanged) saveDatabase(db, addonsPath);
  return count;
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

        // Only migrate if not already in DB (don't overwrite newer data)
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
        }

        // Delete the old per-folder file
        fs.unlinkSync(metaPath);
        result.migrated++;
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
