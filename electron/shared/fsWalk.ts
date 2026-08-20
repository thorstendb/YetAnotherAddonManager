// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';

/**
 * Shared guards for recursive directory walks.
 *
 * Every walk in YAAM is SYNCHRONOUS and runs in the Electron main process.
 * A directory cycle there does not merely slow things down — it wedges the
 * whole process, IPC included, and the UI sits in "Scanning…" forever with no
 * way to recover.  A copying walk can additionally fill the disk.
 *
 * Cycles are not exotic: a Windows junction (mklink /J), a macOS/Linux
 * symlinked folder, or a network mount pointing back up the tree all produce
 * one.  Note that a junction reports isDirectory() === true and
 * isSymbolicLink() === false, so skipping symlinks alone is NOT enough —
 * identity has to be resolved via realpath.
 */

export const MAX_WALK_DEPTH = 32;

/**
 * Decide whether a recursive walk may descend into `dirPath`.
 *
 * Returns false — and the caller must not descend — when the depth limit is
 * exceeded, the path is unreadable, or its real path was already visited.
 * Records the path as visited on success.
 *
 * @param visited  Set shared across one walk; pass a fresh Set per top-level call.
 */
export function canEnterDir(dirPath: string, depth: number, visited: Set<string>): boolean {
  if (depth > MAX_WALK_DEPTH) {
    console.warn(`[YAAM] Walk aborted — max depth ${MAX_WALK_DEPTH} exceeded at ${dirPath}`);
    return false;
  }
  let real: string;
  try {
    real = fs.realpathSync(dirPath);
  } catch {
    return false; // unreadable, dangling link, permission denied
  }
  if (visited.has(real)) {
    console.warn(`[YAAM] Skipping already-visited directory (link loop?): ${dirPath}`);
    return false;
  }
  visited.add(real);
  return true;
}
