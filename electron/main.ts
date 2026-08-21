// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { app, BrowserWindow, ipcMain, dialog, shell, session, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IPC_CHANNELS } from './shared/types';
import { loadConfig, saveConfig } from './configStore';
import { cleanupUnusedLibraries, deleteAddon, deleteAddonAndExclusiveRefs, previewUnusedLibraries, cleanupSelectedLibraries, reconcileYaamMetadata, ReconcileMatch, commitBaseline, BaselineEntry, previewFolderHygiene, applyFolderHygiene, undoFolderHygiene, HygieneUndoInfo, listRemovedEntries, restoreRemovedEntry } from './addonScanner';
import { callFs, shutdownFsWorker } from './fsWorkerHost';
import { detectCloudProvider } from './cloudDetect';
import { TIMEOUTS } from './shared/timeouts';
import { fetchAddonCatalog, fetchAddonDetails, fetchCategories, installAddon, updateCatalogSnapshot, commitCatalogSnapshot } from './addonCatalogApi';
import { setAddonSetting, batchSetAddonSettings, getSavedVarsInfo, deleteSavedVars, cleanupSettings, undoCleanupSettings, listSavedVarsBackups, restoreSavedVarsFile, exportProfile, importProfile, exportProfileAsZip, previewProfileZip, importProfileFromZip, ExportData, previewCleanupSettings, cleanupSettingsSelected } from './settingsManager';
import { saveSnapshotIfChanged, listSnapshots, listAddonBackups, restoreAddonFromBackup, backupAddonFolder, deleteAddonBackups, SnapshotAddon } from './snapshotManager';
import { migrateFromFolderFiles, getAllEntries, getYaamDir, cleanupMarkerFiles, restoreTrackingState } from './yaamDatabase';

/** Extract error message from unknown catch value */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Open folder in system file manager
ipcMain.handle(IPC_CHANNELS.OPEN_IN_EXPLORER, async (_event, folderPath: string) => {
  if (folderPath && typeof folderPath === 'string') {
    shell.showItemInFolder(path.resolve(folderPath));
  }
});

// Open external URL in default browser (only allow https)
ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (_event, url: string) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});

// Return app version from package.json
ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, async () => {
  return app.getVersion();
});

// Disable Chromium caches — we persist nothing via Electron's userData
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Use a temp directory for Electron's required userData (we don't need any of it)
const userDataDir = path.join(os.tmpdir(), 'YAAM-electron');
// Clean up stale temp dir from a previous run that couldn't delete on quit
// (Electron Cache locks on Windows).  Re-create fresh.
if (fs.existsSync(userDataDir)) {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* locked files will be overwritten */ }
}
if (!fs.existsSync(userDataDir)) {
  fs.mkdirSync(userDataDir, { recursive: true });
}
app.setPath('userData', userDataDir);

// Remove the old persistent electron-data folder if it still exists from before
const legacyDir = path.join(os.homedir(), 'Documents', 'ThEsoAddonManager', 'electron-data');
if (fs.existsSync(legacyDir)) {
  fs.rmSync(legacyDir, { recursive: true, force: true });
}

// Also remove old temp dir name from before
const legacyTmpDir = path.join(os.tmpdir(), 'ThEsoAddonManager-electron');
if (fs.existsSync(legacyTmpDir)) {
  fs.rmSync(legacyTmpDir, { recursive: true, force: true });
}

// Clean up temp userData on quit (best-effort; Electron may still hold locks on
// Cache files on Windows, so we also retry cleanup at next startup above).
app.on('will-quit', () => {
  shutdownFsWorker();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Ignore — stale temp dir will be cleaned on next launch
  }

  // A worker thread stuck in a blocking syscall (OneDrive "Files On-Demand",
  // dead network share) cannot be killed: terminate() only stops a thread that
  // returns to the JS runtime, and a pending read never does.  Such a thread
  // keeps the whole process alive — precisely the "has to be killed via task
  // manager" behaviour users report about Minion.
  //
  // The timer is unref'd, so it never delays a normal quit: if the process can
  // exit it is gone long before this fires.  It only fires when something is
  // holding the process hostage, and then a hard exit is correct — every write
  // YAAM performs is synchronous and already flushed by this point.
  // Escalate in two steps: app.exit() first, and if even that cannot complete
  // (Node waits for worker threads on exit, so it may not) fall back to
  // killing our own process.  Verified: terminate() and process.exit() both
  // fail against a thread blocked in read(); SIGKILL is what actually works.
  const forceExit = setTimeout(() => {
    console.warn('[YAAM] Forcing exit — a filesystem worker is stuck in a blocking call');
    app.exit(0);
    const hardKill = setTimeout(() => {
      console.warn('[YAAM] app.exit() did not complete — killing the process');
      process.kill(process.pid, 'SIGKILL');
    }, 1000);
    hardKill.unref();
  }, 2000);
  forceExit.unref();
});

// Enforce single instance — prevents restart loops from portable launcher
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// When a second instance launches, focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

let mainWindow: BrowserWindow | null = null;
let forceQuit = false;

function createWindow() {
  // Grant local-fonts permission for queryLocalFonts() API
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'local-fonts');
  });

  // Restore saved window bounds (position, size, maximized state)
  const config = loadConfig();
  const saved = config.windowBounds;
  let x: number | undefined;
  let y: number | undefined;
  let width = 1200;
  let height = 800;
  let shouldMaximize = false;

  if (saved) {
    // Validate that the saved position is still on a visible display
    const displays = screen.getAllDisplays();
    const visible = displays.some(d => {
      const b = d.bounds;
      return saved.x >= b.x - 100 && saved.x < b.x + b.width &&
             saved.y >= b.y - 100 && saved.y < b.y + b.height;
    });
    if (visible) {
      x = saved.x;
      y = saved.y;
    }
    width = saved.width;
    height = saved.height;
    shouldMaximize = !!saved.isMaximized;
  }

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    title: 'YAAM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (shouldMaximize) mainWindow.maximize();

  // Save window bounds on move/resize (debounced)
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const isMax = mainWindow.isMaximized();
      // When maximized, save the restore bounds (not the maximized bounds)
      const bounds = isMax ? (mainWindow.getNormalBounds?.() || mainWindow.getBounds()) : mainWindow.getBounds();
      const cfg = loadConfig();
      cfg.windowBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, isMaximized: isMax };
      saveConfig(cfg);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', saveBounds);
  mainWindow.on('unmaximize', saveBounds);

  // In dev mode, load from Vite dev server; in production, load built files
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.on('close', (e) => {
    if (forceQuit || !mainWindow) return;
    e.preventDefault();
    mainWindow.webContents.send(IPC_CHANNELS.CHECK_UNSAVED);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC Handlers ---

ipcMain.handle(IPC_CHANNELS.GET_CONFIG, async () => {
  return loadConfig();
});

ipcMain.handle(IPC_CHANNELS.SET_ADDON_PATH, async (_event, addonPath: string) => {
  const config = loadConfig();
  config.addonPath = addonPath;
  saveConfig(config);
  return config;
});

ipcMain.handle(IPC_CHANNELS.SAVE_UI_SETTINGS, async (_event, settings: { logHeight?: number; panelWidths?: number[]; fontScale?: number; fontFamily?: string; skipCleanupConfirm?: boolean; autoUpdateOnStart?: boolean }) => {
  const config = loadConfig();
  if (settings.logHeight !== undefined) config.logHeight = settings.logHeight;
  if (settings.panelWidths !== undefined) config.panelWidths = settings.panelWidths;
  if (settings.fontScale !== undefined) config.fontScale = settings.fontScale;
  if (settings.fontFamily !== undefined) config.fontFamily = settings.fontFamily;
  if (settings.skipCleanupConfirm !== undefined) config.skipCleanupConfirm = settings.skipCleanupConfirm;
  if (settings.autoUpdateOnStart !== undefined) config.autoUpdateOnStart = settings.autoUpdateOnStart;
  saveConfig(config);
  return config;
});

ipcMain.handle(IPC_CHANNELS.DETECT_CLOUD_SYNC, async (_event, targetPath: string) => {
  try {
    return detectCloudProvider(targetPath);
  } catch {
    return null;
  }
});

ipcMain.handle(IPC_CHANNELS.SCAN_ADDONS, async (_event, addonPath: string) => {
  // Runs in the filesystem worker so a blocking syscall (OneDrive "Files
  // On-Demand", dead network share) can be timed out and aborted instead of
  // wedging the main process.  Errors are propagated: the renderer logs them
  // and shows the user what happened — returning [] silently was exactly the
  // behaviour that made "stuck at Scanning…" impossible to diagnose.
  return await callFs('scanAddons', [addonPath], TIMEOUTS.fs.scan);
});

ipcMain.handle(IPC_CHANNELS.RECONCILE_YAAM_META, async (_event, addonsPath: string, matches: ReconcileMatch[]) => {
  try {
    return await callFs('reconcileYaamMetadata', [addonsPath, matches], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Reconcile error:', err);
    return { created: 0, updated: 0, details: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.COMMIT_BASELINE, async (_event, addonsPath: string, entries: BaselineEntry[]) => {
  try {
    return await callFs('commitBaseline', [addonsPath, entries], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Commit baseline error:', err);
    return { anchored: 0, details: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.PREVIEW_FOLDER_HYGIENE, async (_event, addonsPath: string) => {
  try {
    return await callFs('previewFolderHygiene', [addonsPath], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Preview folder hygiene error:', err);
    return { strayManifests: [], duplicates: [], unclaimedRootFiles: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.APPLY_FOLDER_HYGIENE, async (_event, addonsPath: string, actions: { repairs: string[]; removals: string[] }) => {
  try {
    return await callFs('applyFolderHygiene', [addonsPath, actions], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Apply folder hygiene error:', err);
    return { repaired: [], removed: [], errors: [String(err)], undo: { hygieneDir: '', removals: [], repairs: [] } };
  }
});

ipcMain.handle(IPC_CHANNELS.UNDO_FOLDER_HYGIENE, async (_event, addonsPath: string, undo: HygieneUndoInfo) => {
  try {
    return await callFs('undoFolderHygiene', [addonsPath, undo], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Undo folder hygiene error:', err);
    return { restored: 0, errors: [String(err)] };
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_TRACKING_STATE, async (_event, addonsPath: string, backupDir: string) => {
  try {
    return await callFs('restoreTrackingState', [addonsPath, backupDir], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Restore tracking state error:', err);
    return { restored: false, markers: 0, error: String(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_REMOVED, async (_event, addonsPath: string) => {
  try {
    return await callFs('listRemovedEntries', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('List removed error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_REMOVED, async (_event, addonsPath: string, relPath: string) => {
  try {
    return await callFs('restoreRemovedEntry', [addonsPath, relPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Restore removed error:', err);
    return { restored: false, target: '', error: String(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.MOVE_DOWNLOADS_BACK, async (_event, addonsPath: string, fileNames: string[]) => {
  try {
    return await callFs('moveDownloadsBack', [addonsPath, fileNames], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Move downloads back error:', err);
    return { restored: [], errors: [String(err)] };
  }
});

ipcMain.handle(IPC_CHANNELS.GET_YAAM_DB, async (_event, addonsPath: string) => {
  try {
    return await callFs('getAllEntries', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Get YAAM DB error:', err);
    return {};
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_YAAM_MARKERS, async (_event, addonsPath: string) => {
  try {
    return await callFs('cleanupMarkerFiles', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Cleanup markers error:', err);
    return 0;
  }
});

ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select AddOns Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_UNUSED, async (_event, addonPath: string) => {
  try {
    return await callFs('cleanupUnusedLibraries', [addonPath], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Cleanup error:', err);
    return { moved: [], addons: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.DELETE_ADDON, async (_event, addonPath: string, folderName: string) => {
  try {
    return await callFs('deleteAddon', [addonPath, folderName], TIMEOUTS.fs.install);
  } catch (err: unknown) {
    console.error('Delete error:', err);
    return [];
  }
});

ipcMain.handle(
  IPC_CHANNELS.DELETE_ADDON_AND_REFS,
  async (_event, addonPath: string, folderName: string) => {
    try {
      return await callFs('deleteAddonAndExclusiveRefs', [addonPath, folderName], TIMEOUTS.fs.install);
    } catch (err: unknown) {
      console.error('Delete with refs error:', err);
      return { removedAddon: folderName, removedLibs: [], addons: [] };
    }
  }
);

ipcMain.handle(IPC_CHANNELS.FETCH_ADDON_CATALOG, async (_event, forceRefresh: boolean) => {
  try {
    return await fetchAddonCatalog(forceRefresh);
  } catch (err: unknown) {
    console.error('Fetch addon catalog error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.UPDATE_CATALOG_SNAPSHOT, async (_event, addonsPath: string) => {
  try {
    const catalog = await fetchAddonCatalog();
    const diff = updateCatalogSnapshot(addonsPath, catalog);
    if (!diff) return null;
    // Serialize Map/Set for IPC transport
    return {
      changed: Array.from(diff.changed.entries()),
      added: Array.from(diff.added),
      removed: Array.from(diff.removed),
    };
  } catch (err: unknown) {
    console.error('Update catalog snapshot error:', err);
    return null;
  }
});

ipcMain.handle(IPC_CHANNELS.COMMIT_CATALOG_SNAPSHOT, async (_event, addonsPath: string) => {
  try {
    const catalog = await fetchAddonCatalog();
    commitCatalogSnapshot(addonsPath, catalog);
    return true;
  } catch (err: unknown) {
    console.error('Commit catalog snapshot error:', err);
    return false;
  }
});

ipcMain.handle(IPC_CHANNELS.FETCH_ADDON_DETAILS, async (_event, uid: string) => {
  try {
    return await fetchAddonDetails(uid);
  } catch (err: unknown) {
    console.error('Fetch addon details error:', err);
    return { description: '', changeLog: '', md5: '', downloadUrl: '', fileName: '' };
  }
});

ipcMain.handle(IPC_CHANNELS.FETCH_CATEGORIES, async () => {
  try {
    return await fetchCategories();
  } catch (err: unknown) {
    console.error('Fetch categories error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.INSTALL_ADDON, async (_event, addonId: string, addonsPath: string, opts?: { overlayFor?: string }) => {
  const allResults: { installed: string[]; missingDeps: string[]; conflictsSwept: string[]; staleRemoved: string[] } =
    { installed: [], missingDeps: [], conflictsSwept: [], staleRemoved: [] };
  const processedIds = new Set<string>();
  const idsToProcess = [addonId];

  const sendProgress = (phase: string, percent?: number) => {
    if (!mainWindow) return;
    const current = processedIds.size;
    const total = current + idsToProcess.length;
    mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase, percent, current, total });
  };

  while (idsToProcess.length > 0) {
    const currentId = idsToProcess.shift()!;
    if (processedIds.has(currentId)) continue;
    processedIds.add(currentId);

    sendProgress('resolving');

    try {
      // overlayFor applies only to the requested addon, never to pulled-in deps
      const result = await installAddon(currentId, addonsPath, (phase, percent) => {
        sendProgress(phase, percent);
      }, currentId === addonId ? opts : undefined);
      allResults.installed.push(...result.installed);
      allResults.conflictsSwept.push(...result.conflictsSwept);
      allResults.staleRemoved.push(...result.staleRemoved);

      // Resolve missing deps → queue for install
      if (result.missingDeps.length > 0) {
        const catalog = await fetchAddonCatalog();
        const dirToAddon = new Map<string, string>();
        for (const ca of catalog) {
          for (const d of ca.directories) {
            dirToAddon.set(d, ca.id);
          }
        }
        for (const depName of result.missingDeps) {
          const depId = dirToAddon.get(depName);
          if (depId && !processedIds.has(depId)) {
            idsToProcess.push(depId);
          } else if (!depId) {
            allResults.missingDeps.push(depName);
          }
        }
      }
    } catch (err: unknown) {
      console.error(`Install addon ${currentId} error:`, err);
      if (currentId === addonId) {
        return { installed: allResults.installed, missingDeps: allResults.missingDeps, error: errMsg(err) };
      }
      allResults.missingDeps.push(currentId);
    }
  }
  if (mainWindow) {
    mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase: 'done' });
  }
  return allResults;
});

ipcMain.handle(IPC_CHANNELS.GET_ADDON_SETTINGS, async (_event, addonsPath: string) => {
  // The renderer substitutes its own defaults on failure and logs the reason.
  return await callFs('getAddonSettings', [addonsPath], TIMEOUTS.fs.settings);
});

ipcMain.handle(
  IPC_CHANNELS.SET_ADDON_SETTING,
  async (_event, addonsPath: string, character: string, addonName: string, enabled: boolean) => {
    try {
      return await callFs('setAddonSetting', [addonsPath, character, addonName, enabled], TIMEOUTS.fs.settings);
    } catch (err: unknown) {
      console.error('Set addon setting error:', err);
      return { backupPath: '', error: errMsg(err) };
    }
  }
);

ipcMain.handle(
  IPC_CHANNELS.BATCH_SET_ADDON_SETTINGS,
  async (_event, addonsPath: string, changes: { character: string; addonName: string; enabled: boolean }[]) => {
    try {
      return await callFs('batchSetAddonSettings', [addonsPath, changes], TIMEOUTS.fs.settings);
    } catch (err: unknown) {
      console.error('Batch set addon settings error:', err);
      return { backupPath: '', applied: 0, skipped: [], error: errMsg(err) };
    }
  }
);

ipcMain.handle(IPC_CHANNELS.GET_SAVED_VARS_INFO, async (_event, addonsPath: string, addonNames: string[]) => {
  return await callFs('getSavedVarsInfo', [addonsPath, addonNames], TIMEOUTS.fs.savedVars);
});

ipcMain.handle(IPC_CHANNELS.DELETE_SAVED_VARS, async (_event, addonsPath: string, addonName: string) => {
  try {
    return await callFs('deleteSavedVars', [addonsPath, addonName], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Delete saved vars error:', err);
    return { deleted: [], backupDir: '', error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_SETTINGS, async (_event, addonsPath: string, existingAddonNames: string[]) => {
  try {
    return await callFs('cleanupSettings', [addonsPath, existingAddonNames], TIMEOUTS.fs.settings);
  } catch (err: unknown) {
    console.error('Cleanup settings error:', err);
    return { removedFromSettings: [], removedSavedVars: [], backupPath: '', svBackupDir: '', error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.UNDO_CLEANUP_SETTINGS, async (_event, addonsPath: string, settingsBackupPath: string, svBackupDir: string) => {
  try {
    return await callFs('undoCleanupSettings', [addonsPath, settingsBackupPath, svBackupDir], TIMEOUTS.fs.settings);
  } catch (err: unknown) {
    console.error('Undo cleanup error:', err);
    return { restoredSettings: false, restoredSavedVars: [], error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_DOWNLOADS, async (_event, addonsPath: string) => {
  try {
    return await callFs('cleanupDownloadsFolder', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Cleanup downloads error:', err);
    return { moved: [], error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.SAVE_SNAPSHOT, async (_event, addonsPath: string, addons: SnapshotAddon[]) => {
  try {
    return await callFs('saveSnapshotIfChanged', [addonsPath, addons], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Save snapshot error:', err);
    return null;
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_SNAPSHOTS, async (_event, addonsPath: string) => {
  try {
    return await callFs('listSnapshots', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('List snapshots error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_ADDON_BACKUPS, async (_event, addonsPath: string) => {
  try {
    return await callFs('listAddonBackups', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('List addon backups error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_ADDON_BACKUP, async (_event, addonsPath: string, folderName: string, backupPath: string) => {
  try {
    return await callFs('restoreAddonFromBackup', [addonsPath, folderName, backupPath], TIMEOUTS.fs.backup);
  } catch (err: unknown) {
    console.error('Restore addon backup error:', err);
    return false;
  }
});

ipcMain.handle(IPC_CHANNELS.BACKUP_ADDON_FOLDER, async (_event, addonsPath: string, folderName: string, version: string) => {
  try {
    return await callFs('backupAddonFolder', [addonsPath, folderName, version], TIMEOUTS.fs.backup);
  } catch (err: unknown) {
    console.error('Backup addon folder error:', err);
    return '';
  }
});

ipcMain.handle(IPC_CHANNELS.DELETE_ADDON_BACKUPS, async (_event, backupPaths: string[]) => {
  try {
    return await callFs('deleteAddonBackups', [backupPaths], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Delete addon backups error:', err);
    return 0;
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_SV_BACKUPS, async (_event, addonsPath: string) => {
  try {
    return await callFs('listSavedVarsBackups', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('List SV backups error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_SV_FILE, async (_event, addonsPath: string, backupFilePath: string) => {
  try {
    return await callFs('restoreSavedVarsFile', [addonsPath, backupFilePath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Restore SV file error:', err);
    return { restored: false, fileName: '', error: errMsg(err) };
  }
});

// --- Export / Import ---

ipcMain.handle(IPC_CHANNELS.EXPORT_PROFILE, async (
  _event,
  addonsPath: string,
  addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
  bundleFolders?: string[],
  runtimeFilesMap?: Record<string, string[]>
) => {
  try {
    return await callFs('exportProfile', [
      addonsPath,
      addonList,
      bundleFolders,
      // Forwarded through the worker's progress channel.
      (phase: string, percent: number) => {
        if (mainWindow) {
          mainWindow.webContents.send(IPC_CHANNELS.EXPORT_PROGRESS, { phase, percent });
        }
      },
      runtimeFilesMap,
    ], TIMEOUTS.fs.backup);
  } catch (err: unknown) {
    console.error('Export profile error:', err);
    return { error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.IMPORT_PROFILE, async (_event, addonsPath: string, data: ExportData) => {
  try {
    return await callFs('importProfile', [addonsPath, data], TIMEOUTS.fs.backup);
  } catch (err: unknown) {
    console.error('Import profile error:', err);
    return { addonsToInstall: [], restoredSettings: [], restoredBundles: [], errors: [errMsg(err)] };
  }
});

ipcMain.handle(IPC_CHANNELS.EXPORT_PROFILE_ZIP, async (
  _event,
  addonsPath: string,
  addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
  bundleFolders?: string[],
  exportOptions?: { includeAddonSettings?: boolean; includeSavedVars?: boolean; includeUserSettings?: boolean; excludeRuntimeFiles?: Record<string, string[]> }
) => {
  try {
    const buf = await callFs('exportProfileAsZip', [
      addonsPath,
      addonList,
      bundleFolders,
      exportOptions,
      (phase: string, percent: number) => {
        if (mainWindow) mainWindow.webContents.send(IPC_CHANNELS.EXPORT_PROGRESS, { phase, percent });
      },
    ], TIMEOUTS.fs.backup);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save Profile ZIP',
      defaultPath: `yaam-profile-${ts}.zip`,
      filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    fs.writeFileSync(result.filePath, buf);
    return { filePath: result.filePath, size: buf.length };
  } catch (err: unknown) {
    console.error('Export profile ZIP error:', err);
    return { error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.PREVIEW_PROFILE_ZIP, async (_event, zipPath: string) => {
  try {
    return await callFs('previewProfileZip', [zipPath], TIMEOUTS.fs.backup);
  } catch (err: unknown) {
    console.error('Preview profile ZIP error:', err);
    return { error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.IMPORT_PROFILE_ZIP, async (
  _event,
  addonsPath: string,
  zipPath: string,
  options?: { importAddonSettings?: boolean; importUserSettings?: boolean; savedVarFilter?: Record<string, boolean>; addonFilter?: Record<string, boolean> }
) => {
  try {
    return await callFs('importProfileFromZip', [addonsPath, zipPath, options], TIMEOUTS.fs.backup);
  } catch (err: unknown) {
    console.error('Import profile ZIP error:', err);
    return { addonsToInstall: [], restoredSettings: [], restoredBundles: [], errors: [errMsg(err)] };
  }
});

ipcMain.handle(IPC_CHANNELS.BATCH_INSTALL_ADDONS, async (
  _event,
  addonsPath: string,
  addonIds: string[],
  resolveDeps = true
) => {
  const results: { addonId: string; installed: string[]; error?: string }[] = [];
  const processedIds = new Set<string>();
  const idsToProcess = [...addonIds];
  const BATCH_SIZE = 4;

  while (idsToProcess.length > 0) {
    // Take the next chunk of unprocessed IDs, deduplicated
    const currentBatch = [...new Set(idsToProcess.splice(0))];
    for (const id of currentBatch) processedIds.add(id);

    for (let i = 0; i < currentBatch.length; i += BATCH_SIZE) {
      const batch = currentBatch.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (addonId) => {
          try {
            const result = await installAddon(addonId, addonsPath, (phase, percent) => {
              if (mainWindow) {
                mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase, percent });
              }
            });
            if (mainWindow) {
              mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase: 'done' });
            }
            return { addonId, installed: result.installed, missingDeps: result.missingDeps };
          } catch (err: unknown) {
            if (mainWindow) {
              mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase: 'done' });
            }
            return { addonId, installed: [] as string[], missingDeps: [] as string[], error: errMsg(err) };
          }
        })
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          results.push({ addonId: r.value.addonId, installed: r.value.installed, error: r.value.error });

          // Resolve missing dependencies → find their catalog IDs and queue them
          if (resolveDeps && r.value.missingDeps.length > 0) {
            const catalog = await fetchAddonCatalog();
            // Build a map: directory name → catalog addon
            const dirToAddon = new Map<string, { id: string; name: string }>();
            for (const ca of catalog) {
              for (const d of ca.directories) {
                dirToAddon.set(d, { id: ca.id, name: ca.name });
              }
            }
            for (const depName of r.value.missingDeps) {
              const match = dirToAddon.get(depName);
              if (match && !processedIds.has(match.id)) {
                idsToProcess.push(match.id);
              }
            }
          }
        } else {
          results.push({ addonId: 'unknown', installed: [], error: String(r.reason) });
        }
      }
    }
  }
  return results;
});

// --- System Fonts ---

ipcMain.handle(IPC_CHANNELS.GET_SYSTEM_FONTS, async () => {
  try {
    if (!mainWindow) return [];
    // Use Chromium's Local Font Access API (available since Chrome 103 / Electron 20+)
    const fonts: string[] = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const fd = await self.queryLocalFonts();
          return [...new Set(fd.map(f => f.family))].sort();
        } catch { return []; }
      })()
    `);
    return fonts;
  } catch (err: unknown) {
    console.error('Failed to enumerate system fonts:', err);
    return [];
  }
});

// --- Cleanup Preview & Selected ---

ipcMain.handle(IPC_CHANNELS.PREVIEW_CLEANUP_LIBS, async (_event, addonsPath: string) => {
  try {
    return await callFs('previewUnusedLibraries', [addonsPath], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Preview cleanup libs error:', err);
    return { unreferenced: [], optionalOnly: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_LIBS_SELECTED, async (_event, addonsPath: string, folderNames: string[]) => {
  try {
    return await callFs('cleanupSelectedLibraries', [addonsPath, folderNames], TIMEOUTS.fs.scan);
  } catch (err: unknown) {
    console.error('Cleanup selected libs error:', err);
    return { moved: [], addons: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.PREVIEW_CLEANUP_SETTINGS, async (_event, addonsPath: string, existingAddonNames: string[]) => {
  try {
    return await callFs('previewCleanupSettings', [addonsPath, existingAddonNames], TIMEOUTS.fs.settings);
  } catch (err: unknown) {
    console.error('Preview cleanup settings error:', err);
    return { orphanedSettings: [], orphanedSavedVars: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_SETTINGS_SELECTED, async (_event, addonsPath: string, existingAddonNames: string[], settingsToRemove: string[], savedVarsToRemove: string[]) => {
  try {
    return await callFs('cleanupSettingsSelected', [addonsPath, existingAddonNames, settingsToRemove, savedVarsToRemove], TIMEOUTS.fs.settings);
  } catch (err: unknown) {
    console.error('Cleanup selected settings error:', err);
    return { removedFromSettings: [], removedSavedVars: [], backupPath: '', svBackupDir: '', error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.PREVIEW_CLEANUP_DOWNLOADS, async (_event, addonsPath: string) => {
  try {
    return await callFs('previewCleanupDownloads', [addonsPath], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Preview cleanup downloads error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_DOWNLOADS_SELECTED, async (_event, addonsPath: string, fileNames: string[]) => {
  try {
    return await callFs('cleanupDownloadsSelected', [addonsPath, fileNames], TIMEOUTS.fs.quick);
  } catch (err: unknown) {
    console.error('Cleanup selected downloads error:', err);
    return { moved: [] };
  }
});

// --- App Lifecycle ---

ipcMain.handle(IPC_CHANNELS.ACCEPT_WELCOME, async () => {
  const config = loadConfig();
  config.welcomeAccepted = true;
  saveConfig(config);
  return config;
});

ipcMain.handle(IPC_CHANNELS.QUIT_APP, async () => {
  forceQuit = true;
  app.quit();
});

ipcMain.on(IPC_CHANNELS.UNSAVED_RESPONSE, (_event, hasPending: boolean) => {
  if (!mainWindow) return;
  if (!hasPending) {
    forceQuit = true;
    mainWindow.close();
    return;
  }
  // Show custom in-app dialog instead of native OS dialog
  mainWindow.webContents.send(IPC_CHANNELS.SHOW_UNSAVED_DIALOG);
});

// Renderer sends the user's choice from the custom dialog
ipcMain.on(IPC_CHANNELS.UNSAVED_DIALOG_RESPONSE, (_event, choice: 'save' | 'discard' | 'cancel') => {
  if (!mainWindow) return;
  if (choice === 'save') {
    mainWindow.webContents.send(IPC_CHANNELS.SAVE_AND_QUIT);
  } else if (choice === 'discard') {
    forceQuit = true;
    mainWindow.close();
  }
  // 'cancel' — do nothing
});

app.whenReady().then(() => {
  const config = loadConfig();
  if (config.addonPath) {
    const addonsPath = config.addonPath;
    const liveDir = path.dirname(addonsPath);
    const yaamDir = getYaamDir(addonsPath);

    // Migration 1: Move yaam-addons.json from Documents/YAAM/ to live/YAAM/
    const oldDbPath = path.join(os.homedir(), 'Documents', 'YAAM', 'yaam-addons.json');
    const newDbPath = path.join(yaamDir, 'yaam-addons.json');
    if (fs.existsSync(oldDbPath) && !fs.existsSync(newDbPath)) {
      try {
        fs.renameSync(oldDbPath, newDbPath);
        console.log('Migrated yaam-addons.json to live/YAAM/');
      } catch (err) {
        console.error('Failed to migrate yaam-addons.json:', err);
        // Fallback: copy instead of move (cross-device)
        try {
          fs.copyFileSync(oldDbPath, newDbPath);
          fs.unlinkSync(oldDbPath);
          console.log('Migrated yaam-addons.json to live/YAAM/ (copy+delete)');
        } catch (err2) {
          console.error('Failed to copy yaam-addons.json:', err2);
        }
      }
    }

    // Migration 2: Move live/Backup/ to live/YAAM/Backup/
    const oldBackupDir = path.join(liveDir, 'Backup');
    const newBackupDir = path.join(yaamDir, 'Backup');
    if (fs.existsSync(oldBackupDir) && !fs.existsSync(newBackupDir)) {
      try {
        fs.renameSync(oldBackupDir, newBackupDir);
        console.log('Migrated Backup/ to YAAM/Backup/');
      } catch (err) {
        console.error('Failed to migrate Backup/ folder:', err);
      }
    }

    // Migration 3: Migrate old per-folder .yaam.json files
    const migration = migrateFromFolderFiles(addonsPath);
    if (migration.migrated > 0) {
      console.log(`Migrated ${migration.migrated} .yaam.json files to central database`);
    }
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
