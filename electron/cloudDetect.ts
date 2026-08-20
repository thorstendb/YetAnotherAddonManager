// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Detect whether a path lives inside a cloud-synced location.
 *
 * Purely diagnostic: the result is one info line in the log, never a warning
 * or a dialog.  YAAM's job is to work correctly INSIDE such folders (atomic
 * differential writes, automatic conflict-copy cleanup) — this detection only
 * gives support conversations their missing context ("ah, iCloud").
 *
 * Detection is string/metadata work only — no file contents are read, so a
 * dataless cloud placeholder cannot block us here.
 */
export function detectCloudProvider(targetPath: string, home: string = os.homedir()): string | null {
  // Both sides must be resolved the same way: on macOS /var is a symlink to
  // /private/var, so resolving only one side breaks every prefix comparison.
  const real = (x: string): string => {
    try { return fs.realpathSync(x); } catch { return path.resolve(x); }
  };
  const p = real(targetPath);
  home = real(home);
  const sep = path.sep;
  const norm = (x: string) => x.endsWith(sep) ? x : x + sep;

  // Direct iCloud Drive location (all platforms where it exists as a folder)
  if (p.includes(`${sep}Library${sep}Mobile Documents${sep}`)) return 'iCloud Drive';
  if (p.includes(`${sep}iCloudDrive${sep}`)) return 'iCloud Drive'; // Windows client

  // macOS File-Provider mounts: ~/Library/CloudStorage/<Provider>-<Account>/
  const cloudStorage = path.join(home, 'Library', 'CloudStorage');
  if (p.startsWith(norm(cloudStorage))) {
    const seg = p.slice(norm(cloudStorage).length).split(sep)[0] || '';
    return seg.split('-')[0] || 'a cloud provider';
  }

  // OneDrive via environment (Windows sets these; harmless elsewhere)
  for (const env of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = process.env[env];
    if (root && p.startsWith(norm(path.resolve(root)))) return 'OneDrive';
  }

  // Dropbox default location
  if (p.startsWith(norm(path.join(home, 'Dropbox')))) return 'Dropbox';

  // macOS "Desktop & Documents Folders" iCloud sync: the visible path stays
  // ~/Documents, but the folder is mirrored under com~apple~CloudDocs.
  for (const which of ['Documents', 'Desktop']) {
    if (p.startsWith(norm(path.join(home, which)))) {
      const mirror = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', which);
      try {
        if (fs.existsSync(mirror)) return 'iCloud Drive (Desktop & Documents sync)';
      } catch { /* not readable — assume not synced */ }
    }
  }

  return null;
}
