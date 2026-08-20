// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { canEnterDir } from './shared/fsWalk';
import { writeJsonAtomic } from './shared/atomicWrite';

/** A single addon entry in a snapshot */
export interface SnapshotAddon {
  folderName: string;
  version: string;
}

/** A saved snapshot of the addon state at a point in time */
export interface AddonSnapshot {
  /** ISO timestamp when the snapshot was taken */
  timestamp: string;
  /** List of installed addons and their versions */
  addons: SnapshotAddon[];
}

/**
 * Get the snapshots directory (Backup/Snapshots/ next to AddOns/).
 */
function getSnapshotsDir(addonsPath: string): string {
  const dir = path.join(path.dirname(addonsPath), 'YAAM', 'Backup', 'Snapshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Get the addon backup directory (Backup/AddOns/ next to AddOns/).
 */
function getAddonBackupDir(addonsPath: string): string {
  const dir = path.join(path.dirname(addonsPath), 'YAAM', 'Backup', 'AddOns');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * List all snapshot files sorted by timestamp (newest first).
 */
export function listSnapshots(addonsPath: string): AddonSnapshot[] {
  const dir = getSnapshotsDir(addonsPath);
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  const snapshots: AddonSnapshot[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      snapshots.push(JSON.parse(raw));
    } catch {
      // skip corrupt files
    }
  }
  return snapshots;
}

/**
 * Save a new snapshot if the current state differs from the latest snapshot.
 * Returns the snapshot if saved, or null if nothing changed.
 */
export function saveSnapshotIfChanged(
  addonsPath: string,
  currentAddons: SnapshotAddon[]
): AddonSnapshot | null {
  const existing = listSnapshots(addonsPath);
  const latest = existing[0];

  // Compare with latest snapshot
  if (latest) {
    const latestMap = new Map(latest.addons.map((a) => [a.folderName, a.version]));
    const currentMap = new Map(currentAddons.map((a) => [a.folderName, a.version]));

    // Check if both have the same addons with the same versions
    if (latestMap.size === currentMap.size) {
      let identical = true;
      for (const [name, version] of currentMap) {
        if (latestMap.get(name) !== version) {
          identical = false;
          break;
        }
      }
      if (identical) return null; // No change
    }
  }

  const snapshot: AddonSnapshot = {
    timestamp: new Date().toISOString(),
    addons: currentAddons.sort((a, b) => a.folderName.localeCompare(b.folderName)),
  };

  const dir = getSnapshotsDir(addonsPath);
  const ts = snapshot.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filePath = path.join(dir, `snapshot_${ts}.json`);
  writeJsonAtomic(filePath, snapshot);

  return snapshot;
}

/**
 * Back up an addon folder before it gets overwritten by an update.
 * Copies the folder to Backup/AddOns/{folderName}-{version}/
 */
export function backupAddonFolder(
  addonsPath: string,
  folderName: string,
  version: string
): string {
  const src = path.join(addonsPath, folderName);
  if (!fs.existsSync(src)) return '';

  const safeVersion = (version || 'unknown').replace(/[<>:"\/|?*]/g, '_').trim();
  const backupDir = getAddonBackupDir(addonsPath);
  const dest = path.join(backupDir, `${folderName}-${safeVersion}`);

  // If backup already exists for this exact version, skip
  if (fs.existsSync(dest)) return dest;

  copyDirSync(src, dest);
  return dest;
}

/**
 * List available addon backups: { folderName, version, backupPath }[]
 */
export function listAddonBackups(
  addonsPath: string
): { folderName: string; version: string; backupPath: string; sizeBytes: number; mtimeMs: number }[] {
  const backupDir = getAddonBackupDir(addonsPath);
  if (!fs.existsSync(backupDir)) return [];

  const entries = fs.readdirSync(backupDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const results: { folderName: string; version: string; backupPath: string; sizeBytes: number; mtimeMs: number }[] = [];
  for (const entry of entries) {
    // Parse "FolderName-Version" format (split on last hyphen)
    const lastDash = entry.name.lastIndexOf('-');
    if (lastDash <= 0) continue;
    const folderName = entry.name.substring(0, lastDash);
    const version = entry.name.substring(lastDash + 1);
    const fullPath = path.join(backupDir, entry.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch { /* ignore */ }
    results.push({
      folderName,
      version,
      backupPath: fullPath,
      sizeBytes: getDirSize(fullPath),
      mtimeMs,
    });
  }

  return results.sort((a, b) => a.folderName.localeCompare(b.folderName));
}

/**
 * Restore an addon from a backup — copies backup folder back into AddOns/.
 */
export function restoreAddonFromBackup(
  addonsPath: string,
  folderName: string,
  backupPath: string
): boolean {
  if (!fs.existsSync(backupPath)) return false;

  const dest = path.join(addonsPath, folderName);
  // Remove current version first
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  copyDirSync(backupPath, dest);
  return true;
}

/**
 * Delete specific addon backup folders by their paths.
 */
export function deleteAddonBackups(backupPaths: string[]): number {
  let deleted = 0;
  for (const bp of backupPaths) {
    if (fs.existsSync(bp)) {
      fs.rmSync(bp, { recursive: true, force: true });
      deleted++;
    }
  }
  return deleted;
}

/**
 * Get the total size of a directory in bytes.
 */
export function getDirSize(dirPath: string, depth = 0, visited: Set<string> = new Set()): number {
  if (!canEnterDir(dirPath, depth, visited)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue; // measure real files, not link targets
    if (entry.isDirectory()) {
      total += getDirSize(full, depth + 1, visited);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

/**
 * Recursively copy a directory.
 *
 * Bounded against directory cycles: an unbounded copying walk does not just
 * hang, it keeps writing until the disk is full.
 */
function copyDirSync(src: string, dest: string, depth = 0, visited: Set<string> = new Set()): void {
  if (!canEnterDir(src, depth, visited)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, depth + 1, visited);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
