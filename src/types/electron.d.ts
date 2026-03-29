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
      saveUiSettings: (settings: { logHeight?: number; panelWidths?: number[] }) => Promise<AppConfig>;
      saveInstalledVersions: (versions: Record<string, string>) => Promise<void>;
      onInstallProgress: (callback: (data: { addonId: string; phase: string; percent?: number }) => void) => () => void;
      acceptWelcome: () => Promise<AppConfig>;
      quitApp: () => Promise<void>;
      onCheckUnsaved: (callback: () => void) => () => void;
      respondUnsaved: (hasPending: boolean) => void;
      onSaveAndQuit: (callback: () => void) => () => void;
      onShowUnsavedDialog: (callback: () => void) => () => void;
      respondUnsavedDialog: (choice: 'save' | 'discard' | 'cancel') => void;
      saveSnapshot: (addonsPath: string, addons: SnapshotAddon[]) => Promise<AddonSnapshot | null>;
      listSnapshots: (addonsPath: string) => Promise<AddonSnapshot[]>;
      listAddonBackups: (addonsPath: string) => Promise<{ folderName: string; version: string; backupPath: string }[]>;
      restoreAddonBackup: (addonsPath: string, folderName: string, backupPath: string) => Promise<boolean>;
      backupAddonFolder: (addonsPath: string, folderName: string, version: string) => Promise<string>;
      listSvBackups: (addonsPath: string) => Promise<SvBackupEntry[]>;
      restoreSvFile: (addonsPath: string, backupFilePath: string) => Promise<{ restored: boolean; fileName: string; error?: string }>;
      openInExplorer: (fullPath: string) => Promise<void>;
      openExternalUrl: (url: string) => Promise<void>;
      getAppVersion: () => Promise<string>;
      exportProfile: (
        addonsPath: string,
        addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[]
      ) => Promise<ExportData | { error: string }>;
      importProfile: (
        addonsPath: string,
        data: ExportData
      ) => Promise<{ addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; errors: string[] }>;
      batchInstallAddons: (
        addonsPath: string,
        addonIds: string[]
      ) => Promise<{ addonId: string; installed: string[]; error?: string }[]>;
    };
  }
}

export {};
