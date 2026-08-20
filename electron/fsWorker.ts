// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Filesystem worker.
 *
 * All heavy filesystem work runs here instead of in the Electron main process.
 * The reason is not speed, it is recoverability: YAAM's scanning code is
 * synchronous by design, and a blocking syscall cannot be cancelled from
 * JavaScript — no setTimeout fires while a thread sits in readFileSync().
 *
 * That happens in practice: an AddOns folder inside a OneDrive "Files
 * On-Demand" location (the ESO default lives under Documents, which OneDrive
 * commonly syncs) blocks every read until the file has been downloaded, and an
 * unreachable network share does the same.  In the main process that wedges
 * IPC as a whole and the UI hangs in "Scanning…" forever.
 *
 * In a worker the very same synchronous code can simply be terminated, so the
 * host can give up, restart the worker and tell the user what happened.
 *
 * The modules used here are deliberately stateless, so running them in both
 * the worker and the main process (during the staged migration) is safe.
 */
import { parentPort } from 'worker_threads';
import { PROGRESS_MARKER, FsRequest, FsResponse } from './shared/fsProtocol';
import {
  scanAddonsFolder, cleanupUnusedLibraries, deleteAddon, deleteAddonAndExclusiveRefs,
  previewUnusedLibraries, cleanupSelectedLibraries, reconcileYaamMetadata, commitBaseline,
  previewFolderHygiene, applyFolderHygiene, undoFolderHygiene, listRemovedEntries,
  restoreRemovedEntry,
} from './addonScanner';
import {
  parseAddonSettings, setAddonSetting, batchSetAddonSettings, getSavedVarsInfo,
  deleteSavedVars, previewCleanupSettings, cleanupSettingsSelected, cleanupSettings,
  undoCleanupSettings, listSavedVarsBackups, restoreSavedVarsFile, exportProfile,
  importProfile, exportProfileAsZip, previewProfileZip, importProfileFromZip,
} from './settingsManager';
import {
  saveSnapshotIfChanged, listSnapshots, backupAddonFolder, listAddonBackups,
  restoreAddonFromBackup, deleteAddonBackups,
} from './snapshotManager';
import {
  getAllEntries, cleanupMarkerFiles, restoreTrackingState, migrateFromFolderFiles,
} from './yaamDatabase';
import {
  prepareDownload, verifyZip, extractAndRegister, previewCleanupDownloads,
  cleanupDownloadsSelected, moveDownloadsBack, cleanupDownloadsFolder,
} from './addonFiles';

/**
 * The operations the worker exposes.  The host derives its argument and
 * return types from this object, so adding an entry here is all it takes to
 * make a new operation available and type-safe on both sides.
 */
const handlers = {
  // ── Scanning and folder maintenance ──
  scanAddons: scanAddonsFolder,
  cleanupUnusedLibraries,
  deleteAddon,
  deleteAddonAndExclusiveRefs,
  previewUnusedLibraries,
  cleanupSelectedLibraries,
  reconcileYaamMetadata,
  commitBaseline,
  previewFolderHygiene,
  applyFolderHygiene,
  undoFolderHygiene,
  listRemovedEntries,
  restoreRemovedEntry,

  // ── AddonSettings.txt and SavedVariables ──
  getAddonSettings: parseAddonSettings,
  setAddonSetting,
  batchSetAddonSettings,
  getSavedVarsInfo,
  deleteSavedVars,
  previewCleanupSettings,
  cleanupSettingsSelected,
  cleanupSettings,
  undoCleanupSettings,
  listSavedVarsBackups,
  restoreSavedVarsFile,
  exportProfile,
  importProfile,
  exportProfileAsZip,
  previewProfileZip,
  importProfileFromZip,

  // ── Snapshots and backups ──
  saveSnapshotIfChanged,
  listSnapshots,
  backupAddonFolder,
  listAddonBackups,
  restoreAddonFromBackup,
  deleteAddonBackups,

  // ── YAAM database and marker files ──
  getAllEntries,
  cleanupMarkerFiles,
  restoreTrackingState,
  migrateFromFolderFiles,

  // ── Installation and the Downloads folder ──
  prepareDownload,
  verifyZip,
  extractAndRegister,
  previewCleanupDownloads,
  cleanupDownloadsSelected,
  moveDownloadsBack,
  cleanupDownloadsFolder,
};

export type FsOps = typeof handlers;
export type FsOpName = keyof FsOps;

// Protocol lives in shared/fsProtocol so the host can import it without
// pulling this module (and every filesystem module) into the main process.

if (!parentPort) {
  throw new Error('fsWorker must be started as a worker thread');
}

const port = parentPort;

port.on('message', (req: FsRequest) => {
  const handler = (handlers as Record<string, ((...args: never[]) => unknown) | undefined>)[req.op];
  if (!handler) {
    port.postMessage({ id: req.id, kind: 'result', ok: false, error: `Unknown operation: ${req.op}` } satisfies FsResponse);
    return;
  }
  // Restore progress callbacks the host had to strip out.
  const args = req.args.map((a) =>
    a === PROGRESS_MARKER
      ? (...progressArgs: unknown[]) =>
          port.postMessage({ id: req.id, kind: 'progress', args: progressArgs } satisfies FsResponse)
      : a
  );
  try {
    const value = handler(...(args as never[]));
    port.postMessage({ id: req.id, kind: 'result', ok: true, value } satisfies FsResponse);
  } catch (err: unknown) {
    // Error objects do not survive structured cloning with their stack intact —
    // send a plain string and let the host rebuild an Error.
    const message = err instanceof Error ? (err.stack || err.message) : String(err);
    port.postMessage({ id: req.id, kind: 'result', ok: false, error: message } satisfies FsResponse);
  }
});
