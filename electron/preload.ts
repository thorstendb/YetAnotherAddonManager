// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { contextBridge, ipcRenderer, IpcRendererEvent, clipboard } from 'electron';
import { AddonInfo, AddonSettingsData, AppConfig, CatalogAddon, SavedVarsInfo, IPC_CHANNELS } from './shared/types';
import { SnapshotAddon, AddonSnapshot } from './snapshotManager';
import { SvBackupEntry, ExportData } from './settingsManager';

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
  setAddonPath: (addonPath: string): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_ADDON_PATH, addonPath),
  scanAddons: (addonPath: string): Promise<AddonInfo[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCAN_ADDONS, addonPath),
  selectFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER),
  cleanupUnused: (addonPath: string): Promise<{ moved: string[]; addons: AddonInfo[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_UNUSED, addonPath),
  deleteAddon: (addonPath: string, folderName: string): Promise<AddonInfo[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_ADDON, addonPath, folderName),
  deleteAddonAndRefs: (
    addonPath: string,
    folderName: string
  ): Promise<{ removedAddon: string; removedLibs: string[]; addons: AddonInfo[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_ADDON_AND_REFS, addonPath, folderName),
  fetchAddonCatalog: (forceRefresh?: boolean): Promise<CatalogAddon[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FETCH_ADDON_CATALOG, forceRefresh || false),
  fetchAddonDetails: (uid: string): Promise<{ description: string; changeLog: string; md5: string; downloadUrl: string; fileName: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.FETCH_ADDON_DETAILS, uid),
  fetchCategories: (): Promise<{ id: string; name: string; fileCount: number; parentIds: string[] }[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FETCH_CATEGORIES),
  installAddon: (
    addonId: string,
    addonsPath: string
  ): Promise<{ installed: string[]; missingDeps: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.INSTALL_ADDON, addonId, addonsPath),
  getAddonSettings: (addonsPath: string): Promise<AddonSettingsData> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_ADDON_SETTINGS, addonsPath),
  setAddonSetting: (
    addonsPath: string,
    character: string,
    addonName: string,
    enabled: boolean
  ): Promise<{ backupPath: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_ADDON_SETTING, addonsPath, character, addonName, enabled),
  batchSetAddonSettings: (
    addonsPath: string,
    changes: { character: string; addonName: string; enabled: boolean }[]
  ): Promise<{ backupPath: string; applied: number; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BATCH_SET_ADDON_SETTINGS, addonsPath, changes),
  getSavedVarsInfo: (addonsPath: string, addonNames: string[]): Promise<SavedVarsInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SAVED_VARS_INFO, addonsPath, addonNames),
  deleteSavedVars: (
    addonsPath: string,
    addonName: string
  ): Promise<{ deleted: string[]; backupDir: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_SAVED_VARS, addonsPath, addonName),
  cleanupSettings: (
    addonsPath: string,
    existingAddonNames: string[]
  ): Promise<{ removedFromSettings: string[]; removedSavedVars: string[]; backupPath: string; svBackupDir: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_SETTINGS, addonsPath, existingAddonNames),
  undoCleanupSettings: (
    addonsPath: string,
    settingsBackupPath: string,
    svBackupDir: string
  ): Promise<{ restoredSettings: boolean; restoredSavedVars: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.UNDO_CLEANUP_SETTINGS, addonsPath, settingsBackupPath, svBackupDir),
  cleanupDownloads: (
    addonsPath: string
  ): Promise<{ moved: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_DOWNLOADS, addonsPath),
  saveUiSettings: (settings: { logHeight?: number; panelWidths?: number[]; fontSize?: number; fontFamily?: string; skipCleanupConfirm?: boolean }): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_UI_SETTINGS, settings),

  onInstallProgress: (callback: (data: { addonId: string; phase: string; percent?: number; current?: number; total?: number }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { addonId: string; phase: string; percent?: number; current?: number; total?: number }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.INSTALL_PROGRESS, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.INSTALL_PROGRESS, handler); };
  },
  onExportProgress: (callback: (data: { phase: string; percent: number }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { phase: string; percent: number }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.EXPORT_PROGRESS, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.EXPORT_PROGRESS, handler); };
  },
  acceptWelcome: (): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.ACCEPT_WELCOME),
  quitApp: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUIT_APP),
  onCheckUnsaved: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.CHECK_UNSAVED, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.CHECK_UNSAVED, handler); };
  },
  respondUnsaved: (hasPending: boolean) => {
    ipcRenderer.send(IPC_CHANNELS.UNSAVED_RESPONSE, hasPending);
  },
  onSaveAndQuit: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SAVE_AND_QUIT, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.SAVE_AND_QUIT, handler); };
  },
  onShowUnsavedDialog: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SHOW_UNSAVED_DIALOG, handler);
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.SHOW_UNSAVED_DIALOG, handler); };
  },
  respondUnsavedDialog: (choice: 'save' | 'discard' | 'cancel') => {
    ipcRenderer.send(IPC_CHANNELS.UNSAVED_DIALOG_RESPONSE, choice);
  },
  saveSnapshot: (addonsPath: string, addons: SnapshotAddon[]): Promise<AddonSnapshot | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_SNAPSHOT, addonsPath, addons),
  listSnapshots: (addonsPath: string): Promise<AddonSnapshot[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_SNAPSHOTS, addonsPath),
  listAddonBackups: (addonsPath: string): Promise<{ folderName: string; version: string; backupPath: string; sizeBytes: number; mtimeMs: number }[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_ADDON_BACKUPS, addonsPath),
  restoreAddonBackup: (addonsPath: string, folderName: string, backupPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.RESTORE_ADDON_BACKUP, addonsPath, folderName, backupPath),
  backupAddonFolder: (addonsPath: string, folderName: string, version: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.BACKUP_ADDON_FOLDER, addonsPath, folderName, version),
  deleteAddonBackups: (backupPaths: string[]): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_ADDON_BACKUPS, backupPaths),
  listSvBackups: (addonsPath: string): Promise<SvBackupEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_SV_BACKUPS, addonsPath),
  restoreSvFile: (addonsPath: string, backupFilePath: string): Promise<{ restored: boolean; fileName: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.RESTORE_SV_FILE, addonsPath, backupFilePath),
  openInExplorer: (fullPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_IN_EXPLORER, fullPath),
  openExternalUrl: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url),
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION),
  exportProfile: (
    addonsPath: string,
    addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
    bundleFolders?: string[],
    runtimeFilesMap?: Record<string, string[]>
  ): Promise<ExportData | { error: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PROFILE, addonsPath, addonList, bundleFolders, runtimeFilesMap),
  exportProfileAsZip: (
    addonsPath: string,
    addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
    bundleFolders?: string[],
    exportOptions?: { includeAddonSettings?: boolean; includeSavedVars?: boolean; includeUserSettings?: boolean; excludeRuntimeFiles?: Record<string, string[]> }
  ): Promise<{ filePath?: string; size?: number; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PROFILE_ZIP, addonsPath, addonList, bundleFolders, exportOptions),
  importProfile: (
    addonsPath: string,
    data: ExportData
  ): Promise<{ addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; restoredBundles: string[]; errors: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_PROFILE, addonsPath, data),
  previewProfileZip: (
    zipPath: string
  ): Promise<{ totalAddons: number; totalLibraries: number; bundledCount: number; hasSettings: boolean; hasUserSettings: boolean; savedVarsCount: number; savedVarFiles: string[]; exportedAt: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_PROFILE_ZIP, zipPath),
  importProfileFromZip: (
    addonsPath: string,
    zipPath: string,
    options?: { importAddonSettings?: boolean; importUserSettings?: boolean; savedVarFilter?: Record<string, boolean>; addonFilter?: Record<string, boolean> }
  ): Promise<{ addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; restoredBundles: string[]; errors: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_PROFILE_ZIP, addonsPath, zipPath, options),
  batchInstallAddons: (
    addonsPath: string,
    addonIds: string[]
  ): Promise<{ addonId: string; installed: string[]; error?: string }[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.BATCH_INSTALL_ADDONS, addonsPath, addonIds),
  getSystemFonts: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SYSTEM_FONTS),
  previewCleanupLibs: (addonsPath: string): Promise<{ unreferenced: string[]; optionalOnly: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CLEANUP_LIBS, addonsPath),
  cleanupLibsSelected: (addonsPath: string, folderNames: string[]): Promise<{ moved: string[]; addons: AddonInfo[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_LIBS_SELECTED, addonsPath, folderNames),
  previewCleanupSettings: (addonsPath: string, existingAddonNames: string[]): Promise<{ orphanedSettings: string[]; orphanedSavedVars: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CLEANUP_SETTINGS, addonsPath, existingAddonNames),
  cleanupSettingsSelected: (
    addonsPath: string,
    existingAddonNames: string[],
    settingsToRemove: string[],
    savedVarsToRemove: string[]
  ): Promise<{ removedFromSettings: string[]; removedSavedVars: string[]; backupPath: string; svBackupDir: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_SETTINGS_SELECTED, addonsPath, existingAddonNames, settingsToRemove, savedVarsToRemove),
  previewCleanupDownloads: (addonsPath: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CLEANUP_DOWNLOADS, addonsPath),
  cleanupDownloadsSelected: (addonsPath: string, fileNames: string[]): Promise<{ moved: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_DOWNLOADS_SELECTED, addonsPath, fileNames),
  writeClipboard: (text: string): void => clipboard.writeText(text),
  reconcileYaamMeta: (
    addonsPath: string,
    matches: { folderName: string; esouid: string; name: string; author: string; version: string; url: string; catalogDate: number; localVersion: string; confident: boolean }[]
  ): Promise<{ created: number; updated: number; details: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.RECONCILE_YAAM_META, addonsPath, matches),
  getYaamDb: (addonsPath: string): Promise<Record<string, { esouid: string; url: string; catalogName: string; catalogAuthor: string; catalogVersion: string; localVersion: string; installedAt: string; updatedAt: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_YAAM_DB, addonsPath),
  cleanupYaamMarkers: (addonsPath: string): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEANUP_YAAM_MARKERS, addonsPath),
  updateCatalogSnapshot: (addonsPath: string): Promise<{ changed: [string, { oldVersion: string; newVersion: string }][]; added: string[]; removed: string[] } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CATALOG_SNAPSHOT, addonsPath),
});
