// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { AddonInfo, AddonSettingsData, AppConfig, CatalogAddon, SavedVarsInfo } from '../electron/shared/types';
import { ExportData } from '../electron/settingsManager';

interface SnapshotAddon {
  folderName: string;
  version: string;
}

interface AddonSnapshot {
  timestamp: string;
  addons: SnapshotAddon[];
}

interface SvBackupEntry {
  fileName: string;
  backupDirName: string;
  backupFilePath: string;
  type: 'backup' | 'cleanup';
  timestamp: string;
}

declare global {
  interface Window {
    electronAPI: {
      getConfig: () => Promise<AppConfig>;
      setAddonPath: (addonPath: string) => Promise<AppConfig>;
      scanAddons: (addonPath: string) => Promise<AddonInfo[]>;
      selectFolder: () => Promise<string | null>;
      cleanupUnused: (addonPath: string) => Promise<{ moved: string[]; addons: AddonInfo[] }>;
      deleteAddon: (addonPath: string, folderName: string) => Promise<AddonInfo[]>;
      deleteAddonAndRefs: (
        addonPath: string,
        folderName: string
      ) => Promise<{ removedAddon: string; removedLibs: string[]; addons: AddonInfo[] }>;
      fetchAddonCatalog: (forceRefresh?: boolean) => Promise<CatalogAddon[]>;
      installAddon: (
        addonId: string,
        addonsPath: string
      ) => Promise<{ installed: string[]; missingDeps: string[]; error?: string }>;
      getAddonSettings: (addonsPath: string) => Promise<AddonSettingsData>;
      setAddonSetting: (
        addonsPath: string,
        character: string,
        addonName: string,
        enabled: boolean
      ) => Promise<{ backupPath: string; error?: string }>;
      batchSetAddonSettings: (
        addonsPath: string,
        changes: { character: string; addonName: string; enabled: boolean }[]
      ) => Promise<{ backupPath: string; applied: number; error?: string }>;
      getSavedVarsInfo: (addonsPath: string, addonNames: string[]) => Promise<SavedVarsInfo>;
      deleteSavedVars: (
        addonsPath: string,
        addonName: string
      ) => Promise<{ deleted: string[]; backupDir: string; error?: string }>;
      cleanupSettings: (
        addonsPath: string,
        existingAddonNames: string[]
      ) => Promise<{ removedFromSettings: string[]; removedSavedVars: string[]; backupPath: string; svBackupDir: string; error?: string }>;
      undoCleanupSettings: (
        addonsPath: string,
        settingsBackupPath: string,
        svBackupDir: string
      ) => Promise<{ restoredSettings: boolean; restoredSavedVars: string[]; error?: string }>;
      cleanupDownloads: (
        addonsPath: string
      ) => Promise<{ moved: string[]; error?: string }>;
      saveUiSettings: (settings: { logHeight?: number; panelWidths?: number[]; fontSize?: number; fontFamily?: string; skipCleanupConfirm?: boolean }) => Promise<AppConfig>;
      saveInstalledVersions: (versions: Record<string, string>) => Promise<void>;
      onInstallProgress: (callback: (data: { addonId: string; phase: string; percent?: number; current?: number; total?: number }) => void) => () => void;
      onExportProgress: (callback: (data: { phase: string; percent: number }) => void) => () => void;
      acceptWelcome: () => Promise<AppConfig>;
      quitApp: () => Promise<void>;
      onCheckUnsaved: (callback: () => void) => () => void;
      respondUnsaved: (hasPending: boolean) => void;
      onSaveAndQuit: (callback: () => void) => () => void;
      onShowUnsavedDialog: (callback: () => void) => () => void;
      respondUnsavedDialog: (choice: 'save' | 'discard' | 'cancel') => void;
      saveSnapshot: (addonsPath: string, addons: SnapshotAddon[]) => Promise<AddonSnapshot | null>;
      listSnapshots: (addonsPath: string) => Promise<AddonSnapshot[]>;
      fetchAddonDetails: (uid: string) => Promise<{ description: string; changeLog: string; md5: string; downloadUrl: string; fileName: string }>;
      fetchCategories: () => Promise<{ id: string; name: string; fileCount: number; parentIds: string[] }[]>;
      listAddonBackups: (addonsPath: string) => Promise<{ folderName: string; version: string; backupPath: string; sizeBytes: number; mtimeMs: number }[]>;
      restoreAddonBackup: (addonsPath: string, folderName: string, backupPath: string) => Promise<boolean>;
      backupAddonFolder: (addonsPath: string, folderName: string, version: string) => Promise<string>;
      deleteAddonBackups: (backupPaths: string[]) => Promise<number>;
      listSvBackups: (addonsPath: string) => Promise<SvBackupEntry[]>;
      restoreSvFile: (addonsPath: string, backupFilePath: string) => Promise<{ restored: boolean; fileName: string; error?: string }>;
      openInExplorer: (fullPath: string) => Promise<void>;
      openExternalUrl: (url: string) => Promise<void>;
      getAppVersion: () => Promise<string>;
      exportProfile: (
        addonsPath: string,
        addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
        bundleFolders?: string[],
        runtimeFilesMap?: Record<string, string[]>
      ) => Promise<ExportData | { error: string }>;
      exportProfileAsZip: (
        addonsPath: string,
        addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
        bundleFolders?: string[],
        exportOptions?: { includeAddonSettings?: boolean; includeSavedVars?: boolean; includeUserSettings?: boolean; excludeRuntimeFiles?: Record<string, string[]> }
      ) => Promise<{ filePath?: string; size?: number; canceled?: boolean; error?: string }>;
      importProfile: (
        addonsPath: string,
        data: ExportData
      ) => Promise<{ addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; restoredBundles: string[]; errors: string[] }>;
      previewProfileZip: (
        zipPath: string
      ) => Promise<{ totalAddons: number; totalLibraries: number; bundledCount: number; hasSettings: boolean; hasUserSettings: boolean; savedVarsCount: number; savedVarFiles: string[]; exportedAt: string; addonList: { folderName: string; isLibrary: boolean }[]; error?: string }>;
      importProfileFromZip: (
        addonsPath: string,
        zipPath: string,
        options?: { importAddonSettings?: boolean; importUserSettings?: boolean; savedVarFilter?: Record<string, boolean>; addonFilter?: Record<string, boolean> }
      ) => Promise<{ addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; restoredBundles: string[]; errors: string[] }>;
      batchInstallAddons: (
        addonsPath: string,
        addonIds: string[]
      ) => Promise<{ addonId: string; installed: string[]; error?: string }[]>;
      getSystemFonts: () => Promise<string[]>;
      previewCleanupLibs: (addonsPath: string) => Promise<{ unreferenced: string[]; optionalOnly: string[] }>;
      cleanupLibsSelected: (addonsPath: string, folderNames: string[]) => Promise<{ moved: string[]; addons: AddonInfo[] }>;
      previewCleanupSettings: (addonsPath: string, existingAddonNames: string[]) => Promise<{ orphanedSettings: string[]; orphanedSavedVars: string[] }>;
      cleanupSettingsSelected: (
        addonsPath: string,
        existingAddonNames: string[],
        settingsToRemove: string[],
        savedVarsToRemove: string[]
      ) => Promise<{ removedFromSettings: string[]; removedSavedVars: string[]; backupPath: string; svBackupDir: string; error?: string }>;
      previewCleanupDownloads: (addonsPath: string) => Promise<string[]>;
      cleanupDownloadsSelected: (addonsPath: string, fileNames: string[]) => Promise<{ moved: string[] }>;
      writeClipboard: (text: string) => void;
      reconcileYaamMeta: (
        addonsPath: string,
        matches: { folderName: string; esouid: string; name: string; author: string; version: string; url: string; localVersion: string; confident: boolean }[]
      ) => Promise<{ created: number; updated: number; details: string[] }>;
      getYaamDb: (addonsPath: string) => Promise<Record<string, { esouid: string; url: string; catalogName: string; catalogAuthor: string; catalogVersion: string; localVersion: string; installedAt: string; updatedAt: string }>>;
    };
  }
}

export {};
