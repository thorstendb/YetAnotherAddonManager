// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IPC_CHANNELS } from './shared/types';
import { loadConfig, saveConfig } from './configStore';
import { scanAddonsFolder, cleanupUnusedLibraries, deleteAddon, deleteAddonAndExclusiveRefs, previewUnusedLibraries, cleanupSelectedLibraries } from './addonScanner';
import { fetchAddonCatalog, installAddon, cleanupDownloadsFolder, previewCleanupDownloads, cleanupDownloadsSelected } from './addonCatalogApi';
import { parseAddonSettings, setAddonSetting, batchSetAddonSettings, getSavedVarsInfo, deleteSavedVars, cleanupSettings, undoCleanupSettings, listSavedVarsBackups, restoreSavedVarsFile, exportProfile, importProfile, ExportData, previewCleanupSettings, cleanupSettingsSelected } from './settingsManager';
import { saveSnapshotIfChanged, listSnapshots, listAddonBackups, restoreAddonFromBackup, backupAddonFolder, deleteAddonBackups, getDirSize, SnapshotAddon } from './snapshotManager';

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

// Clean up temp userData on quit
app.on('will-quit', () => {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (err) {
    console.error('Failed to clean up temp dir:', err);
  }
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

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'YAAM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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

ipcMain.handle(IPC_CHANNELS.SAVE_UI_SETTINGS, async (_event, settings: { logHeight?: number; panelWidths?: number[]; fontSize?: number; fontFamily?: string; skipCleanupConfirm?: boolean }) => {
  const config = loadConfig();
  if (settings.logHeight !== undefined) config.logHeight = settings.logHeight;
  if (settings.panelWidths !== undefined) config.panelWidths = settings.panelWidths;
  if (settings.fontSize !== undefined) config.fontSize = settings.fontSize;
  if (settings.fontFamily !== undefined) config.fontFamily = settings.fontFamily;
  if (settings.skipCleanupConfirm !== undefined) config.skipCleanupConfirm = settings.skipCleanupConfirm;
  saveConfig(config);
  return config;
});

ipcMain.handle(IPC_CHANNELS.SCAN_ADDONS, async (_event, addonPath: string) => {
  try {
    return scanAddonsFolder(addonPath);
  } catch (err: unknown) {
    console.error('Scan error:', err);
    return [];
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
    return cleanupUnusedLibraries(addonPath);
  } catch (err: unknown) {
    console.error('Cleanup error:', err);
    return { moved: [], addons: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.DELETE_ADDON, async (_event, addonPath: string, folderName: string) => {
  try {
    return deleteAddon(addonPath, folderName);
  } catch (err: unknown) {
    console.error('Delete error:', err);
    return [];
  }
});

ipcMain.handle(
  IPC_CHANNELS.DELETE_ADDON_AND_REFS,
  async (_event, addonPath: string, folderName: string) => {
    try {
      return deleteAddonAndExclusiveRefs(addonPath, folderName);
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

ipcMain.handle(IPC_CHANNELS.INSTALL_ADDON, async (_event, addonId: string, addonsPath: string) => {
  const allResults: { installed: string[]; missingDeps: string[] } = { installed: [], missingDeps: [] };
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
      const result = await installAddon(currentId, addonsPath, (phase, percent) => {
        sendProgress(phase, percent);
      });
      allResults.installed.push(...result.installed);

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
  try {
    return parseAddonSettings(addonsPath);
  } catch (err: unknown) {
    console.error('Parse settings error:', err);
    return { version: 0, acknowledgedOutOfDateVersion: 0, addOnsEnabled: true, characters: {}, defaults: {} };
  }
});

ipcMain.handle(
  IPC_CHANNELS.SET_ADDON_SETTING,
  async (_event, addonsPath: string, character: string, addonName: string, enabled: boolean) => {
    try {
      return setAddonSetting(addonsPath, character, addonName, enabled);
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
      return batchSetAddonSettings(addonsPath, changes);
    } catch (err: unknown) {
      console.error('Batch set addon settings error:', err);
      return { backupPath: '', applied: 0, error: errMsg(err) };
    }
  }
);

ipcMain.handle(IPC_CHANNELS.GET_SAVED_VARS_INFO, async (_event, addonsPath: string, addonNames: string[]) => {
  try {
    return getSavedVarsInfo(addonsPath, addonNames);
  } catch (err: unknown) {
    console.error('Get saved vars info error:', err);
    return { addonFiles: {} };
  }
});

ipcMain.handle(IPC_CHANNELS.DELETE_SAVED_VARS, async (_event, addonsPath: string, addonName: string) => {
  try {
    return deleteSavedVars(addonsPath, addonName);
  } catch (err: unknown) {
    console.error('Delete saved vars error:', err);
    return { deleted: [], backupDir: '', error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_SETTINGS, async (_event, addonsPath: string, existingAddonNames: string[]) => {
  try {
    return cleanupSettings(addonsPath, existingAddonNames);
  } catch (err: unknown) {
    console.error('Cleanup settings error:', err);
    return { removedFromSettings: [], removedSavedVars: [], backupPath: '', svBackupDir: '', error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.UNDO_CLEANUP_SETTINGS, async (_event, addonsPath: string, settingsBackupPath: string, svBackupDir: string) => {
  try {
    return undoCleanupSettings(addonsPath, settingsBackupPath, svBackupDir);
  } catch (err: unknown) {
    console.error('Undo cleanup error:', err);
    return { restoredSettings: false, restoredSavedVars: [], error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_DOWNLOADS, async (_event, addonsPath: string) => {
  try {
    return cleanupDownloadsFolder(addonsPath);
  } catch (err: unknown) {
    console.error('Cleanup downloads error:', err);
    return { moved: [], error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.SAVE_SNAPSHOT, async (_event, addonsPath: string, addons: SnapshotAddon[]) => {
  try {
    return saveSnapshotIfChanged(addonsPath, addons);
  } catch (err: unknown) {
    console.error('Save snapshot error:', err);
    return null;
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_SNAPSHOTS, async (_event, addonsPath: string) => {
  try {
    return listSnapshots(addonsPath);
  } catch (err: unknown) {
    console.error('List snapshots error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_ADDON_BACKUPS, async (_event, addonsPath: string) => {
  try {
    return listAddonBackups(addonsPath);
  } catch (err: unknown) {
    console.error('List addon backups error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_ADDON_BACKUP, async (_event, addonsPath: string, folderName: string, backupPath: string) => {
  try {
    return restoreAddonFromBackup(addonsPath, folderName, backupPath);
  } catch (err: unknown) {
    console.error('Restore addon backup error:', err);
    return false;
  }
});

ipcMain.handle(IPC_CHANNELS.BACKUP_ADDON_FOLDER, async (_event, addonsPath: string, folderName: string, version: string) => {
  try {
    return backupAddonFolder(addonsPath, folderName, version);
  } catch (err: unknown) {
    console.error('Backup addon folder error:', err);
    return '';
  }
});

ipcMain.handle(IPC_CHANNELS.DELETE_ADDON_BACKUPS, async (_event, backupPaths: string[]) => {
  try {
    return deleteAddonBackups(backupPaths);
  } catch (err: unknown) {
    console.error('Delete addon backups error:', err);
    return 0;
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_SV_BACKUPS, async (_event, addonsPath: string) => {
  try {
    return listSavedVarsBackups(addonsPath);
  } catch (err: unknown) {
    console.error('List SV backups error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_SV_FILE, async (_event, addonsPath: string, backupFilePath: string) => {
  try {
    return restoreSavedVarsFile(addonsPath, backupFilePath);
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
  bundleFolders?: string[]
) => {
  try {
    return exportProfile(addonsPath, addonList, bundleFolders, (phase, percent) => {
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.EXPORT_PROGRESS, { phase, percent });
      }
    });
  } catch (err: unknown) {
    console.error('Export profile error:', err);
    return { error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.IMPORT_PROFILE, async (_event, addonsPath: string, data: ExportData) => {
  try {
    return importProfile(addonsPath, data);
  } catch (err: unknown) {
    console.error('Import profile error:', err);
    return { addonsToInstall: [], restoredSettings: [], errors: [errMsg(err)] };
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
    // Take the next chunk of unprocessed IDs
    const currentBatch = idsToProcess.splice(0);
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
    return previewUnusedLibraries(addonsPath);
  } catch (err: unknown) {
    console.error('Preview cleanup libs error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_LIBS_SELECTED, async (_event, addonsPath: string, folderNames: string[]) => {
  try {
    return cleanupSelectedLibraries(addonsPath, folderNames);
  } catch (err: unknown) {
    console.error('Cleanup selected libs error:', err);
    return { moved: [], addons: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.PREVIEW_CLEANUP_SETTINGS, async (_event, addonsPath: string, existingAddonNames: string[]) => {
  try {
    return previewCleanupSettings(addonsPath, existingAddonNames);
  } catch (err: unknown) {
    console.error('Preview cleanup settings error:', err);
    return { orphanedSettings: [], orphanedSavedVars: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_SETTINGS_SELECTED, async (_event, addonsPath: string, existingAddonNames: string[], settingsToRemove: string[], savedVarsToRemove: string[]) => {
  try {
    return cleanupSettingsSelected(addonsPath, existingAddonNames, settingsToRemove, savedVarsToRemove);
  } catch (err: unknown) {
    console.error('Cleanup selected settings error:', err);
    return { removedFromSettings: [], removedSavedVars: [], backupPath: '', svBackupDir: '', error: errMsg(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.PREVIEW_CLEANUP_DOWNLOADS, async (_event, addonsPath: string) => {
  try {
    return previewCleanupDownloads(addonsPath);
  } catch (err: unknown) {
    console.error('Preview cleanup downloads error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_DOWNLOADS_SELECTED, async (_event, addonsPath: string, fileNames: string[]) => {
  try {
    return cleanupDownloadsSelected(addonsPath, fileNames);
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

ipcMain.handle(IPC_CHANNELS.SAVE_INSTALLED_VERSIONS, async (_event, versions: Record<string, string>) => {
  const config = loadConfig();
  if (!config.installedCatalogVersions) config.installedCatalogVersions = {};
  Object.assign(config.installedCatalogVersions, versions);
  // Remove entries with empty values (used to signal deletion after restore)
  for (const [key, val] of Object.entries(config.installedCatalogVersions)) {
    if (!val) delete config.installedCatalogVersions[key];
  }
  saveConfig(config);
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
