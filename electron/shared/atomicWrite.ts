// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { threadId } from 'worker_threads';

/**
 * Write a file atomically: serialize to a temp file in the SAME directory,
 * then rename over the target.
 *
 * rename() is atomic within a filesystem, so a reader — ESO, another addon
 * manager, or a cloud sync client — sees either the old file or the complete
 * new one, never a truncated mix.  A plain writeFileSync truncates first and
 * then fills: on a synced folder (iCloud "Documents", OneDrive) that window is
 * enough for the sync client to capture a half-written state and turn it into
 * a conflict copy ("AddOnSettings 2.txt"), which for AddOnSettings.txt means
 * the user loses their per-character addon selection.
 *
 * The temp file must live in the target directory — a rename across
 * filesystems is not atomic and would fall back to copy+delete.
 */
export function writeFileAtomic(targetPath: string, data: string | Buffer, encoding: BufferEncoding = 'utf-8'): void {
  // pid alone is not unique inside worker threads (they share it).
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}-${threadId}.yaamtmp`
  );
  try {
    if (typeof data === 'string') fs.writeFileSync(tmpPath, data, encoding);
    else fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}

/** Atomic JSON write with the project's standard formatting. */
export function writeJsonAtomic(targetPath: string, value: unknown): void {
  writeFileAtomic(targetPath, JSON.stringify(value, null, 2), 'utf-8');
}
