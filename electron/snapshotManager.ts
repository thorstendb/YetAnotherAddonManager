// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';

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
  const dir = path.join(path.dirname(addonsPath), 'Backup', 'Snapshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Get the addon backup directory (Backup/AddOns/ next to AddOns/).
 */
function getAddonBackupDir(addonsPath: string): string {
  const dir = path.join(path.dirname(addonsPath), 'Backup', 'AddOns');
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
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

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
): { folderName: string; version: string; backupPath: string }[] {
  const backupDir = getAddonBackupDir(addonsPath);
  if (!fs.existsSync(backupDir)) return [];

  const entries = fs.readdirSync(backupDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const results: { folderName: string; version: string; backupPath: string }[] = [];
  for (const entry of entries) {
    // Parse "FolderName-Version" format (split on last hyphen)
    const lastDash = entry.name.lastIndexOf('-');
    if (lastDash <= 0) continue;
    const folderName = entry.name.substring(0, lastDash);
    const version = entry.name.substring(lastDash + 1);
    results.push({
      folderName,
      version,
      backupPath: path.join(backupDir, entry.name),
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

/** Recursively copy a directory */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
