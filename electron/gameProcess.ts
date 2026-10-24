// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Is ESO running?
 *
 * The game keeps SavedVariables in memory and writes them back at logout,
 * /reloadui and exit — anything YAAM changed in the meantime is overwritten.
 * At the character selection the files are safe to edit (they are read again
 * on login), but a process list cannot tell that screen from being in game,
 * so callers warn instead of refusing.
 */
import { execFile } from 'child_process';

/** Process names of the game client (Windows, macOS, Linux/Proton) */
const GAME_PROCESS = /^(eso64|eso)(\.exe)?$|^The Elder Scrolls Online$/i;

/** Testable part: does a process listing contain the game? */
export function listsGameProcess(names: string[]): boolean {
  return names.some((n) => GAME_PROCESS.test(n.trim().replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? ''));
}

/** Resolves false when the process list cannot be read — never blocks the caller */
export function isGameRunning(timeoutMs = 5_000): Promise<boolean> {
  const [cmd, args] = process.platform === 'win32'
    ? ['tasklist', ['/FO', 'CSV', '/NH']]
    : ['ps', ['-A', '-o', 'comm=']];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.warn('[YAAM] Process list unavailable:', err.message);
        resolve(false);
        return;
      }
      // tasklist CSV: "eso64.exe","1234",… — the image name is the first column
      const names = stdout.split(/\r?\n/).map((line) => (process.platform === 'win32' ? line.split('","')[0] : line));
      resolve(listsGameProcess(names));
    });
  });
}
