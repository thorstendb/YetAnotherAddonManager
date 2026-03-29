// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IPC_CHANNELS } from './shared/types';
import { loadConfig, saveConfig } from './configStore';
import { scanAddonsFolder, cleanupUnusedLibraries, deleteAddon, deleteAddonAndExclusiveRefs } from './addonScanner';
import { fetchAddonCatalog, installAddon, cleanupDownloadsFolder } from './addonCatalogApi';
import { parseAddonSettings, setAddonSetting, batchSetAddonSettings, getSavedVarsInfo, deleteSavedVars, cleanupSettings, undoCleanupSettings, listSavedVarsBackups, restoreSavedVarsFile, exportProfile, importProfile, ExportData } from './settingsManager';
import { saveSnapshotIfChanged, listSnapshots, listAddonBackups, restoreAddonFromBackup, backupAddonFolder, SnapshotAddon, AddonSnapshot } from './snapshotManager';

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
  } catch {}
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

ipcMain.handle(IPC_CHANNELS.SAVE_UI_SETTINGS, async (_event, settings: { logHeight?: number; panelWidths?: number[] }) => {
  const config = loadConfig();
  if (settings.logHeight !== undefined) config.logHeight = settings.logHeight;
  if (settings.panelWidths !== undefined) config.panelWidths = settings.panelWidths;
  saveConfig(config);
  return config;
});

ipcMain.handle(IPC_CHANNELS.SCAN_ADDONS, async (_event, addonPath: string) => {
  try {
    return scanAddonsFolder(addonPath);
  } catch (err: any) {
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
  } catch (err: any) {
    console.error('Cleanup error:', err);
    return { moved: [], addons: [] };
  }
});

ipcMain.handle(IPC_CHANNELS.DELETE_ADDON, async (_event, addonPath: string, folderName: string) => {
  try {
    return deleteAddon(addonPath, folderName);
  } catch (err: any) {
    console.error('Delete error:', err);
    return [];
  }
});

ipcMain.handle(
  IPC_CHANNELS.DELETE_ADDON_AND_REFS,
  async (_event, addonPath: string, folderName: string) => {
    try {
      return deleteAddonAndExclusiveRefs(addonPath, folderName);
    } catch (err: any) {
      console.error('Delete with refs error:', err);
      return { removedAddon: folderName, removedLibs: [], addons: [] };
    }
  }
);

ipcMain.handle(IPC_CHANNELS.FETCH_ADDON_CATALOG, async (_event, forceRefresh: boolean) => {
  try {
    return await fetchAddonCatalog(forceRefresh);
  } catch (err: any) {
    console.error('Fetch addon catalog error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.INSTALL_ADDON, async (_event, addonId: string, addonsPath: string) => {
  try {
    return await installAddon(addonId, addonsPath, (phase, percent) => {
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase, percent });
      }
    });
  } catch (err: any) {
    console.error('Install addon error:', err);
    return { installed: [], missingDeps: [], error: err.message || String(err) };
  } finally {
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase: 'done' });
    }
  }
});

ipcMain.handle(IPC_CHANNELS.GET_ADDON_SETTINGS, async (_event, addonsPath: string) => {
  try {
    return parseAddonSettings(addonsPath);
  } catch (err: any) {
    console.error('Parse settings error:', err);
    return { version: 0, acknowledgedOutOfDateVersion: 0, addOnsEnabled: true, characters: {}, defaults: {} };
  }
});

ipcMain.handle(
  IPC_CHANNELS.SET_ADDON_SETTING,
  async (_event, addonsPath: string, character: string, addonName: string, enabled: boolean) => {
    try {
      return setAddonSetting(addonsPath, character, addonName, enabled);
    } catch (err: any) {
      console.error('Set addon setting error:', err);
      return { backupPath: '', error: err.message || String(err) };
    }
  }
);

ipcMain.handle(
  IPC_CHANNELS.BATCH_SET_ADDON_SETTINGS,
  async (_event, addonsPath: string, changes: { character: string; addonName: string; enabled: boolean }[]) => {
    try {
      return batchSetAddonSettings(addonsPath, changes);
    } catch (err: any) {
      console.error('Batch set addon settings error:', err);
      return { backupPath: '', applied: 0, error: err.message || String(err) };
    }
  }
);

ipcMain.handle(IPC_CHANNELS.GET_SAVED_VARS_INFO, async (_event, addonsPath: string, addonNames: string[]) => {
  try {
    return getSavedVarsInfo(addonsPath, addonNames);
  } catch (err: any) {
    console.error('Get saved vars info error:', err);
    return { addonFiles: {} };
  }
});

ipcMain.handle(IPC_CHANNELS.DELETE_SAVED_VARS, async (_event, addonsPath: string, addonName: string) => {
  try {
    return deleteSavedVars(addonsPath, addonName);
  } catch (err: any) {
    console.error('Delete saved vars error:', err);
    return { deleted: [], backupDir: '', error: err.message || String(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_SETTINGS, async (_event, addonsPath: string, existingAddonNames: string[]) => {
  try {
    return cleanupSettings(addonsPath, existingAddonNames);
  } catch (err: any) {
    console.error('Cleanup settings error:', err);
    return { removedFromSettings: [], removedSavedVars: [], backupPath: '', svBackupDir: '', error: err.message || String(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.UNDO_CLEANUP_SETTINGS, async (_event, addonsPath: string, settingsBackupPath: string, svBackupDir: string) => {
  try {
    return undoCleanupSettings(addonsPath, settingsBackupPath, svBackupDir);
  } catch (err: any) {
    console.error('Undo cleanup error:', err);
    return { restoredSettings: false, restoredSavedVars: [], error: err.message || String(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.CLEANUP_DOWNLOADS, async (_event, addonsPath: string) => {
  try {
    return cleanupDownloadsFolder(addonsPath);
  } catch (err: any) {
    console.error('Cleanup downloads error:', err);
    return { moved: [], error: err.message || String(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.SAVE_SNAPSHOT, async (_event, addonsPath: string, addons: SnapshotAddon[]) => {
  try {
    return saveSnapshotIfChanged(addonsPath, addons);
  } catch (err: any) {
    console.error('Save snapshot error:', err);
    return null;
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_SNAPSHOTS, async (_event, addonsPath: string) => {
  try {
    return listSnapshots(addonsPath);
  } catch (err: any) {
    console.error('List snapshots error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_ADDON_BACKUPS, async (_event, addonsPath: string) => {
  try {
    return listAddonBackups(addonsPath);
  } catch (err: any) {
    console.error('List addon backups error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_ADDON_BACKUP, async (_event, addonsPath: string, folderName: string, backupPath: string) => {
  try {
    return restoreAddonFromBackup(addonsPath, folderName, backupPath);
  } catch (err: any) {
    console.error('Restore addon backup error:', err);
    return false;
  }
});

ipcMain.handle(IPC_CHANNELS.BACKUP_ADDON_FOLDER, async (_event, addonsPath: string, folderName: string, version: string) => {
  try {
    return backupAddonFolder(addonsPath, folderName, version);
  } catch (err: any) {
    console.error('Backup addon folder error:', err);
    return '';
  }
});

ipcMain.handle(IPC_CHANNELS.LIST_SV_BACKUPS, async (_event, addonsPath: string) => {
  try {
    return listSavedVarsBackups(addonsPath);
  } catch (err: any) {
    console.error('List SV backups error:', err);
    return [];
  }
});

ipcMain.handle(IPC_CHANNELS.RESTORE_SV_FILE, async (_event, addonsPath: string, backupFilePath: string) => {
  try {
    return restoreSavedVarsFile(addonsPath, backupFilePath);
  } catch (err: any) {
    console.error('Restore SV file error:', err);
    return { restored: false, fileName: '', error: err.message || String(err) };
  }
});

// --- Export / Import ---

ipcMain.handle(IPC_CHANNELS.EXPORT_PROFILE, async (
  _event,
  addonsPath: string,
  addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[]
) => {
  try {
    return exportProfile(addonsPath, addonList);
  } catch (err: any) {
    console.error('Export profile error:', err);
    return { error: err.message || String(err) };
  }
});

ipcMain.handle(IPC_CHANNELS.IMPORT_PROFILE, async (_event, addonsPath: string, data: ExportData) => {
  try {
    return importProfile(addonsPath, data);
  } catch (err: any) {
    console.error('Import profile error:', err);
    return { addonsToInstall: [], restoredSettings: [], errors: [err.message || String(err)] };
  }
});

ipcMain.handle(IPC_CHANNELS.BATCH_INSTALL_ADDONS, async (
  _event,
  addonsPath: string,
  addonIds: string[]
) => {
  const results: { addonId: string; installed: string[]; error?: string }[] = [];
  const BATCH_SIZE = 4;
  for (let i = 0; i < addonIds.length; i += BATCH_SIZE) {
    const batch = addonIds.slice(i, i + BATCH_SIZE);
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
          return { addonId, installed: result.installed };
        } catch (err: any) {
          if (mainWindow) {
            mainWindow.webContents.send(IPC_CHANNELS.INSTALL_PROGRESS, { addonId, phase: 'done' });
          }
          return { addonId, installed: [] as string[], error: err.message || String(err) };
        }
      })
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ addonId: 'unknown', installed: [], error: String(r.reason) });
    }
  }
  return results;
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
