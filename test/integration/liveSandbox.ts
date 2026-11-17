// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The real ESO installation the live tests are about */
export const REAL_LIVE = path.join(os.homedir(), 'Documents', 'Elder Scrolls Online', 'live');

/**
 * A throwaway copy of the live installation for tests that SCAN it.
 *
 * scanAddonsFolder is not read-only: it reconciles the YAAM database and
 * writes .yaam.json markers into addon folders.  Pointed at the real install,
 * every `vitest run` during development would let a work-in-progress scanner
 * write its results into the user's own data — the one place a bug must not
 * reach.  Reading files directly needs no copy; scanning does.
 *
 * The YAAM database is copied (the scan depends on tracking state), its
 * backups are not.  Returns null when there is no live installation.
 *
 * Callers dispose in try/finally right around the scan.  Neither afterAll nor
 * a process 'exit' handler is reliable here: vitest skips afterAll for a suite
 * whose tests are all skipped, and terminates workers without 'exit' — both
 * leaked a ~95 MB copy of the user's AddOns into the temp folder.
 */
export function makeLiveSandbox(
  parts: ('AddOns' | 'SavedVariables' | 'AddOnSettings.txt')[],
): { live: string; dispose: () => void } | null {
  if (!fs.existsSync(path.join(REAL_LIVE, 'AddOns'))) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-livebox-'));
  const live = path.join(root, 'live');
  fs.mkdirSync(live, { recursive: true });
  for (const part of parts) {
    const src = path.join(REAL_LIVE, part);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(live, part), { recursive: true, preserveTimestamps: true });
  }
  const db = path.join(REAL_LIVE, 'YAAM', 'yaam-addons.json');
  if (fs.existsSync(db)) {
    fs.mkdirSync(path.join(live, 'YAAM'), { recursive: true });
    fs.copyFileSync(db, path.join(live, 'YAAM', 'yaam-addons.json'));
  }
  return { live, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
