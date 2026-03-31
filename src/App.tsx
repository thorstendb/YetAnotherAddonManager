// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AddonInfo, AddonSettingsData, CatalogAddon, SavedVarsInfo, compareVersionStrings, dateToVersion } from '../electron/shared/types';
import PathBar from './components/PathBar';
import StatusBar from './components/StatusBar';
import TreePanel from './components/TreePanel';
import AddonTreeItem from './components/AddonTreeItem';
// SearchBar removed — per-panel search is built into TreePanel
import ContextMenu, { ContextMenuItem } from './components/ContextMenu';
import LogPanel, { LogEntry } from './components/LogPanel';
import OnlineBrowser from './components/OnlineBrowser';
import WelcomeDialog from './components/WelcomeDialog';
import UnsavedDialog from './components/UnsavedDialog';
import RestoreDialog from './components/RestoreDialog';
import ImportExportDialog from './components/ImportExportDialog';
import AboutDialog from './components/AboutDialog';
import SettingsDialog from './components/SettingsDialog';
import CleanupDialog, { CleanupType } from './components/CleanupDialog';
import BackupCleanupDialog from './components/BackupCleanupDialog';
import UpdateAllDialog, { UpdatableAddon } from './components/UpdateAllDialog';
import './styles/App.css';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shorten "EU Megaserver-Alandhur" → "EU Alandhur" for display. */
export function shortenCharName(name: string): string {
  return name.replace(/\s+Megaserver-/, ' ');
}

function App() {
  const [addonPath, setAddonPath] = useState('');
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedAddon, setSelectedAddon] = useState<string | null>(null);
  const [addonSearchQuery, setAddonSearchQuery] = useState('');
  const [libSearchQuery, setLibSearchQuery] = useState('');
  const [addonCharFilter, setAddonCharFilter] = useState<string>('');
  const [libCharFilter, setLibCharFilter] = useState<string>('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    addon: AddonInfo;
  } | null>(null);
  const [catalogDirNames, setCatalogDirNames] = useState<Set<string>>(new Set());
  const [addonSettings, setAddonSettings] = useState<AddonSettingsData | null>(null);
  const [savedVarsInfo, setSavedVarsInfo] = useState<SavedVarsInfo>({ addonFiles: {} });
  const [catalogAddons, setCatalogAddons] = useState<CatalogAddon[]>([]);
  const [logHeight, setLogHeight] = useState(240);
  const [installingAddon, setInstallingAddon] = useState<string | null>(null);
  const [panelWidths, setPanelWidths] = useState<number[]>([1, 1, 1]);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [updateRemaining, setUpdateRemaining] = useState(0);
  const [catalogHighlightId, setCatalogHighlightId] = useState<string | null>(null);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const [installedCatalogVersions, setInstalledCatalogVersions] = useState<Record<string, string>>({});
  const [installProgress, setInstallProgress] = useState<Record<string, { phase: string; percent?: number; current?: number; total?: number }>>({});
  const [welcomeAccepted, setWelcomeAccepted] = useState<boolean | null>(null); // null = loading
  // Pending character setting changes: { "character\0addonName": enabled }
  const [pendingCharSettings, setPendingCharSettings] = useState<Map<string, boolean>>(new Map());
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [restoreSnapshots, setRestoreSnapshots] = useState<{ timestamp: string; addons: { folderName: string; version: string }[] }[]>([]);
  const [restoreBackups, setRestoreBackups] = useState<{ folderName: string; version: string; backupPath: string }[]>([]);
  const [restoreSvBackups, setRestoreSvBackups] = useState<{ fileName: string; backupDirName: string; backupFilePath: string; type: 'backup' | 'cleanup'; timestamp: string }[]>([]);
  const [updateTotal, setUpdateTotal] = useState(0);
  const updateCancelRef = useRef(false);
  const [showImportExport, setShowImportExport] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [fontFamily, setFontFamily] = useState("'Segoe UI', sans-serif");
  const [skipCleanupConfirm, setSkipCleanupConfirm] = useState(false);
  const [cleanupDialog, setCleanupDialog] = useState<{
    type: CleanupType;
    items: string[];
    savedVarItems?: string[];
  } | null>(null);
  const [backupCleanupBackups, setBackupCleanupBackups] = useState<{
    folderName: string; version: string; backupPath: string; sizeBytes: number;
  }[] | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    folderName: string;
    title: string;
    action: () => void;
  } | null>(null);
  const [updateAllList, setUpdateAllList] = useState<UpdatableAddon[] | null>(null);

  // Theme state: persisted in localStorage
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('yaam-theme') as 'dark' | 'light') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('yaam-theme', theme);
  }, [theme]);

  // Apply font settings to body
  useEffect(() => {
    document.body.style.fontSize = `${fontSize}px`;
    document.body.style.fontFamily = fontFamily;
  }, [fontSize, fontFamily]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // Refs to tree scroll containers for auto-scrolling on navigate
  const addonsScrollRef = useRef<HTMLDivElement>(null);
  const libsScrollRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);

  // Logging helper
  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs((prev) => [...prev, { timestamp: new Date(), message, level }]);
  }, []);

  // Load saved config on mount (guarded against StrictMode double-run)
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    window.electronAPI.getConfig().then((config) => {
      if (config.logHeight) setLogHeight(config.logHeight);
      if (config.panelWidths) setPanelWidths(config.panelWidths);
      if (config.installedCatalogVersions) setInstalledCatalogVersions(config.installedCatalogVersions);
      if (config.fontSize) setFontSize(config.fontSize);
      if (config.fontFamily) setFontFamily(config.fontFamily);
      if (config.skipCleanupConfirm) setSkipCleanupConfirm(config.skipCleanupConfirm);
      if (config.welcomeAccepted) {
        setWelcomeAccepted(true);
        addLog('YAAM started', 'info');
        if (config.addonPath) {
          setAddonPath(config.addonPath);
          scanPath(config.addonPath);
        }
      } else {
        setWelcomeAccepted(false);
      }
    });
  }, []);

  // Listen for install progress events from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onInstallProgress((data) => {
      if (data.phase === 'done') {
        setInstallProgress(prev => {
          const next = { ...prev };
          delete next[data.addonId];
          return next;
        });
      } else {
        setInstallProgress(prev => ({ ...prev, [data.addonId]: { phase: data.phase, percent: data.percent, current: data.current, total: data.total } }));
      }
    });
    return cleanup;
  }, []);

  const scanPath = useCallback(async (pathToScan: string) => {
    if (!pathToScan) return;
    setLoading(true);
    addLog(`Scanning: ${pathToScan}`);
    try {
      const results = await window.electronAPI.scanAddons(pathToScan);
      setAddons(results);
      const libs = results.filter((a) => a.isLibrary).length;
      addLog(`Found ${results.length} addons (${results.length - libs} addons, ${libs} libraries)`, 'success');

      // Load addon settings, saved vars, and addon catalog in parallel
      // Include sub-addon names so their SavedVariables aren't misattributed
      const addonNames = results.flatMap((a: AddonInfo) => [a.folderName, ...a.subAddons.map((s: AddonInfo) => s.folderName)]);
      const [settings, svInfo, onlineList] = await Promise.all([
        window.electronAPI.getAddonSettings(pathToScan).catch(() => null),
        window.electronAPI.getSavedVarsInfo(pathToScan, addonNames).catch(() => ({ addonFiles: {} })),
        window.electronAPI.fetchAddonCatalog(false).catch(() => []),
      ]);

      if (settings) setAddonSettings(settings);
      setSavedVarsInfo(svInfo);

      // Build set of all directory names known in the catalog
      const dirSet = new Set<string>();
      for (const addon of onlineList) {
        for (const dir of addon.directories) {
          dirSet.add(dir);
        }
      }
      setCatalogDirNames(dirSet);
      setCatalogAddons(onlineList);
      // Clear recently-updated tracking since we have fresh data
      setRecentlyUpdated(new Set());

      // Save a snapshot of the current addon state (only if changed)
      const snapshotAddons = results.map((a: AddonInfo) => ({ folderName: a.folderName, version: a.version }));
      window.electronAPI.saveSnapshot(pathToScan, snapshotAddons).catch(() => {});
    } catch (err: unknown) {
      addLog(`Scan failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addLog]);

  const handleSetPath = useCallback(
    async (newPath: string) => {
      setAddonPath(newPath);
      await window.electronAPI.setAddonPath(newPath);
      addLog(`Path set: ${newPath}`);
      scanPath(newPath);
    },
    [scanPath, addLog]
  );

  const handleBrowse = useCallback(async () => {
    const selected = await window.electronAPI.selectFolder();
    if (selected) {
      handleSetPath(selected);
    }
  }, [handleSetPath]);

  const handleRefresh = useCallback(() => {
    if (addonPath) handleSetPath(addonPath);
  }, [addonPath, handleSetPath]);

  // --- Computed data ---

  // Build a lookup map: folderName -> AddonInfo, and title -> AddonInfo
  // Includes sub-addon names/titles for dependency resolution
  const addonMap = useMemo(() => {
    const map = new Map<string, AddonInfo>();
    for (const a of addons) {
      map.set(a.folderName, a);
      if (a.title && a.title !== a.folderName) {
        map.set(a.title, a);
      }
      for (const sub of a.subAddons) {
        map.set(sub.folderName, sub);
        if (sub.title && sub.title !== sub.folderName) {
          map.set(sub.title, sub);
        }
      }
    }
    return map;
  }, [addons]);

  // Set of installed directory names for the online browser
  const installedDirNames = useMemo(() => new Set(addons.map((a) => a.folderName)), [addons]);

  // Set of addons NOT found in the catalog and without their own download URL
  const notInCatalog = useMemo(() => {
    if (catalogDirNames.size === 0) return new Set<string>();
    const catalogNames = new Set(catalogAddons.map(a => a.name));
    const catalogIds = new Set(catalogAddons.map(a => a.id));
    const missing = new Set<string>();
    for (const addon of addons) {
      // Has a catalogId that matches → definitely in catalog
      if (addon.catalogId && catalogIds.has(addon.catalogId)) continue;
      if (!catalogDirNames.has(addon.folderName) && !catalogNames.has(addon.title) && !addon.downloadUrl) {
        missing.add(addon.folderName);
      }
    }
    return missing;
  }, [addons, catalogDirNames, catalogAddons]);

  // Catalog ID lookup: maps ESOUI UID → CatalogAddon (exact, O(1))
  const catalogById = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    for (const addon of catalogAddons) {
      map.set(addon.id, addon);
    }
    return map;
  }, [catalogAddons]);

  // Map from folder/title name -> CatalogAddon for local addon matching.
  // When multiple catalog entries share the same key (directory or name),
  // keep the entry with the most total downloads (almost always the main addon).
  // ID-based matching (catalogId) is preferred and bypasses this map entirely.
  const catalogByDir = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    for (const addon of catalogAddons) {
      for (const dir of addon.directories) {
        const existing = map.get(dir);
        if (!existing || addon.totalDownloads > existing.totalDownloads) {
          map.set(dir, addon);
        }
      }
      // Map by addon name (for title-based matching + dependency lookups)
      const existingByName = map.get(addon.name);
      if (!existingByName || addon.totalDownloads > existingByName.totalDownloads) {
        map.set(addon.name, addon);
      }
    }
    return map;
  }, [catalogAddons]);

  // Set of catalog addon names that appear in more than one catalog entry
  const catalogNameConflicts = useMemo(() => {
    const nameCount = new Map<string, number>();
    for (const addon of catalogAddons) {
      nameCount.set(addon.name, (nameCount.get(addon.name) || 0) + 1);
    }
    const conflicts = new Set<string>();
    for (const [name, count] of nameCount) {
      if (count > 1) conflicts.add(name);
    }
    return conflicts;
  }, [catalogAddons]);

  /** Look up the catalog entry for an installed addon.
   *  Priority chain:
   *  1. catalogId from manifest URL (ESOUI UID) — exact, unique
   *  2. addon title → catalog name match
   *  3. folder name → directories match (fallback) */
  const getCatalogAddon = useCallback(
    (addon: AddonInfo): CatalogAddon | undefined =>
      (addon.catalogId ? catalogById.get(addon.catalogId) : undefined)
        ?? catalogByDir.get(addon.title)
        ?? catalogByDir.get(addon.folderName),
    [catalogById, catalogByDir]
  );

  /** Detect addons matched by title whose folder name is NOT in the
   *  catalog's directories list — indicates a name / directory mismatch. */
  const catalogMismatch = useMemo(() => {
    const set = new Set<string>();
    for (const addon of addons) {
      const cat = getCatalogAddon(addon);
      if (cat && !cat.directories.includes(addon.folderName)) {
        set.add(addon.folderName);
      }
    }
    return set;
  }, [addons, getCatalogAddon]);

  // Set of all known addon names (folder names + titles) for dependency checking
  const knownAddonNames = useMemo(() => new Set(addonMap.keys()), [addonMap]);

  // Get character settings for a specific addon - always returns ALL characters
  // Merges base settings with any pending (unsaved) changes
  const getCharacterSettingsForAddon = useCallback(
    (folderName: string): Record<string, boolean> | undefined => {
      if (!addonSettings) return undefined;
      const charNames = Object.keys(addonSettings.characters);
      if (charNames.length === 0) return undefined;
      // The game treats addons with no entry in AddOnSettings.txt as enabled.
      // Fallback chain: pending change → character entry → #Default entry → true
      const defaultValue = folderName in addonSettings.defaults ? addonSettings.defaults[folderName] : true;
      const result: Record<string, boolean> = {};
      for (const [charName, charAddons] of Object.entries(addonSettings.characters)) {
        const key = `${charName}\0${folderName}`;
        if (pendingCharSettings.has(key)) {
          result[charName] = pendingCharSettings.get(key)!;
        } else {
          result[charName] = folderName in charAddons ? charAddons[folderName] : defaultValue;
        }
      }
      return result;
    },
    [addonSettings, pendingCharSettings]
  );

  // Toggle a character's addon setting — local only, no disk write.
  // If the new value matches the original on-disk value, remove from pending
  // so the Save button auto-disables when all changes are reverted.
  const handleToggleCharSetting = useCallback(
    (addonName: string, character: string, enabled: boolean) => {
      setPendingCharSettings((prev) => {
        const next = new Map(prev);
        const key = `${character}\0${addonName}`;
        // Determine the on-disk (original) value
        // The game treats missing entries as enabled; consult #Default as fallback
        const defaultValue = addonSettings?.defaults[addonName] ?? true;
        const origValue = addonSettings?.characters[character]?.[addonName] ?? defaultValue;
        if (enabled === origValue) {
          // Reverted to original — no longer pending
          next.delete(key);
        } else {
          next.set(key, enabled);
        }
        return next;
      });
    },
    [addonSettings]
  );

  // Save all pending character settings to disk (single batch write)
  const handleSaveCharSettings = useCallback(async () => {
    if (!addonPath || pendingCharSettings.size === 0) return;
    setLoading(true);
    try {
      const changes: { character: string; addonName: string; enabled: boolean }[] = [];
      for (const [key, enabled] of pendingCharSettings) {
        const [character, addonName] = key.split('\0');
        changes.push({ character, addonName, enabled });
      }
      const res = await window.electronAPI.batchSetAddonSettings(addonPath, changes);
      if (res.error) {
        addLog(`Save failed: ${res.error}`, 'error');
      } else {
        addLog(`Saved ${res.applied} character setting change(s). Note: The game must be closed or at the login screen — /reloadui is not enough.`, 'success');
      }
      // Refresh settings from disk
      const newSettings = await window.electronAPI.getAddonSettings(addonPath);
      setAddonSettings(newSettings);
      setPendingCharSettings(new Map());
    } catch (err: unknown) {
      addLog(`Save failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, pendingCharSettings, addLog]);

  // Keep a ref to pending state and save handler for IPC close-guard
  const pendingRef = useRef(pendingCharSettings);
  pendingRef.current = pendingCharSettings;
  const saveRef = useRef(handleSaveCharSettings);
  saveRef.current = handleSaveCharSettings;

  // Listen for close-guard IPC from main process
  useEffect(() => {
    const cleanupCheck = window.electronAPI.onCheckUnsaved(() => {
      window.electronAPI.respondUnsaved(pendingRef.current.size > 0);
    });
    const cleanupSave = window.electronAPI.onSaveAndQuit(async () => {
      await saveRef.current();
      window.electronAPI.quitApp();
    });
    const cleanupDialog = window.electronAPI.onShowUnsavedDialog(() => {
      setShowUnsavedDialog(true);
    });
    return () => { cleanupCheck(); cleanupSave(); cleanupDialog(); };
  }, []);

  // Separate addons from libraries
  const libraries = useMemo(() => addons.filter((a) => a.isLibrary), [addons]);
  const regularAddons = useMemo(() => addons.filter((a) => !a.isLibrary), [addons]);

  // Compute which libraries are referenced, and by whom
  // Includes sub-addon dependencies so bundled libs aren't flagged as unreferenced
  const { referencedLibs, unreferencedLibs, referencedByMap } = useMemo(() => {
    const refLibs = new Set<string>();
    const refByMap = new Map<string, Set<string>>();

    for (const addon of addons) {
      const allDeps = [
        ...addon.dependsOn,
        ...addon.optionalDependsOn,
        ...addon.subAddons.flatMap((s) => [...s.dependsOn, ...s.optionalDependsOn]),
      ];
      for (const dep of allDeps) {
        refLibs.add(dep.name);
        if (!refByMap.has(dep.name)) refByMap.set(dep.name, new Set());
        refByMap.get(dep.name)!.add(addon.folderName);
      }
    }

    const unrefLibs = new Set(
      libraries
        .filter((lib) => !refLibs.has(lib.folderName) && !refLibs.has(lib.title))
        .map((lib) => lib.folderName)
    );

    return { referencedLibs: refLibs, unreferencedLibs: unrefLibs, referencedByMap: refByMap };
  }, [addons, libraries]);

  // Get "referenced by" list for a given library
  const getReferencedBy = useCallback(
    (lib: AddonInfo): string[] => {
      const refs = new Set<string>();
      const byFolder = referencedByMap.get(lib.folderName);
      const byTitle = referencedByMap.get(lib.title);
      if (byFolder) byFolder.forEach((r) => refs.add(r));
      if (byTitle) byTitle.forEach((r) => refs.add(r));
      return Array.from(refs).sort();
    },
    [referencedByMap]
  );

  // Filter by search query (also searches sub-addon names)
  const filterAddons = useCallback(
    (list: AddonInfo[], query: string) => {
      if (!query.trim()) return list;
      const q = query.toLowerCase();
      return list.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.folderName.toLowerCase().includes(q) ||
          a.author.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.subAddons.some((s) =>
            s.title.toLowerCase().includes(q) ||
            s.folderName.toLowerCase().includes(q)
          )
      );
    },
    []
  );

  // Available character names from settings
  const characterNames = useMemo(() => {
    if (!addonSettings) return [];
    return Object.keys(addonSettings.characters).sort();
  }, [addonSettings]);

  const filteredAddons = useMemo(() => {
    let list = filterAddons(regularAddons, addonSearchQuery);
    if (addonCharFilter && addonSettings) {
      const charAddons = addonSettings.characters[addonCharFilter];
      if (charAddons) {
        list = list.filter((a) => {
          if (a.folderName in charAddons) return charAddons[a.folderName];
          // Not in character section: consult #Default, then treat as enabled
          return a.folderName in addonSettings.defaults ? addonSettings.defaults[a.folderName] : true;
        });
      }
    }
    return list.sort((a, b) => a.title.localeCompare(b.title));
  }, [filterAddons, regularAddons, addonSearchQuery, addonCharFilter, addonSettings]);

  // Libraries: all sorted by name (unreferenced still get ⚠ marker)
  const filteredLibraries = useMemo(() => {
    let list = filterAddons(libraries, libSearchQuery);
    if (libCharFilter && addonSettings) {
      const charAddons = addonSettings.characters[libCharFilter];
      if (charAddons) {
        list = list.filter((a) => {
          if (a.folderName in charAddons) return charAddons[a.folderName];
          return a.folderName in addonSettings.defaults ? addonSettings.defaults[a.folderName] : true;
        });
      }
    }
    return list.sort((a, b) => a.title.localeCompare(b.title));
  }, [filterAddons, libraries, libSearchQuery, libCharFilter, addonSettings]);

  // Version comparison: uses shared compareVersionStrings from types.ts
  // Handles semver, date-based, revision suffixes, pre-release tags, etc.

  /**
   * Get the best available version string for comparison.
   * Fallback chain: addon.version → catalog date-based version → ''
   * This ensures addons without a ## Version header can still be compared
   * using the catalog upload date as a proxy.
   */
  const getEffectiveVersion = useCallback(
    (addon: AddonInfo, catalogAddon?: CatalogAddon): string => {
      if (addon.version) return addon.version;
      // No local version: use catalog date as date-based version proxy
      if (catalogAddon && catalogAddon.date) return dateToVersion(catalogAddon.date);
      return '';
    },
    []
  );

  /**
   * Central update-availability check used by updateCount, Update All, and
   * passed to OnlineBrowser so every surface uses identical logic.
   * Returns true when the catalog version is newer than the local version.
   */
  const isUpdateAvailable = useCallback(
    (addon: AddonInfo, catalogAddon: CatalogAddon): boolean => {
      // Already installed this exact catalog revision
      if (installedCatalogVersions[catalogAddon.id] === catalogAddon.version) return false;
      // Skip recently-updated addons (local version hasn't been rescanned yet)
      if (recentlyUpdated.has(catalogAddon.id)) return false;
      const localVer = getEffectiveVersion(addon, catalogAddon);
      return compareVersionStrings(localVer, catalogAddon.version, catalogAddon.date) < 0;
    },
    [installedCatalogVersions, recentlyUpdated, getEffectiveVersion]
  );

  // Count of addons that have a newer version in the catalog (for Update All button)
  const updateCount = useMemo(() => {
    const seen = new Set<string>();
    let count = 0;
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (catalogAddon && !seen.has(catalogAddon.id)) {
        seen.add(catalogAddon.id);
        if (isUpdateAvailable(addon, catalogAddon)) count++;
      }
    }
    return count;
  }, [addons, getCatalogAddon, isUpdateAvailable]);

  // Set of folder names that have an update available (used for sorting to top)
  const updatableFolders = useMemo(() => {
    const set = new Set<string>();
    const seen = new Set<string>();
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (catalogAddon && !seen.has(catalogAddon.id)) {
        seen.add(catalogAddon.id);
        if (isUpdateAvailable(addon, catalogAddon)) {
          // Mark all directories belonging to this catalog addon as updatable
          for (const dir of catalogAddon.directories) set.add(dir);
          // Also mark the addon's own folder (title-matched addons may not be in directories)
          set.add(addon.folderName);
        }
      }
    }
    return set;
  }, [addons, getCatalogAddon, isUpdateAvailable]);

  // --- Navigation ---

  const handleNavigate = useCallback(
    (name: string) => {
      const target = addonMap.get(name);
      if (target) {
        // If the target is a sub-addon, navigate to its parent instead
        const navTarget = target.parentAddon
          ? addonMap.get(target.parentAddon) || target
          : target;
        setSelectedAddon(navTarget.folderName);
        requestAnimationFrame(() => {
          const el = document.querySelector(`[data-addon-id="${navTarget.folderName}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      }
    },
    [addonMap]
  );

  // Navigate to an addon in the catalog Browse tree
  const handleNavigateCatalog = useCallback((addonId: string) => {
    // Toggle: setting a new value triggers the useEffect in OnlineBrowser
    setCatalogHighlightId(null);
    requestAnimationFrame(() => setCatalogHighlightId(addonId));
  }, []);

  // --- Context menu ---

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, addon: AddonInfo) => {
      setContextMenu({ x: e.clientX, y: e.clientY, addon });
    },
    []
  );

  const handleDeleteAddon = useCallback(
    async (folderName: string, alsoDeleteSavedVars: boolean = false) => {
      if (!addonPath) return;
      addLog(`Deleting "${folderName}"...`, 'warn');
      try {
        // Backup addon before deletion so it appears in Go Back
        const addon = addons.find(a => a.folderName === folderName);
        let backupPath = '';
        if (addon && addon.version) {
          backupPath = await window.electronAPI.backupAddonFolder(addonPath, folderName, addon.version);
        }
        if (alsoDeleteSavedVars) {
          // Delete SavedVars for parent + all sub-addon names
          const names = [folderName, ...(addon?.subAddons.map(s => s.folderName) || [])];
          const allDeleted: string[] = [];
          for (const name of names) {
            const svResult = await window.electronAPI.deleteSavedVars(addonPath, name);
            allDeleted.push(...svResult.deleted);
          }
          if (allDeleted.length > 0) {
            addLog(`Removed SavedVariables: ${allDeleted.join(', ')} (backed up)`, 'info');
          }
        }
        const updated = await window.electronAPI.deleteAddon(addonPath, folderName);
        setAddons(updated);
        setSelectedAddon(null);
        const revertAction = backupPath ? {
          label: '↩ Undo',
          onClick: async () => {
            try {
              const ok = await window.electronAPI.restoreAddonBackup(addonPath, folderName, backupPath);
              if (ok) {
                addLog(`Restored "${folderName}" from backup`, 'success');
                scanPath(addonPath);
              } else {
                addLog(`Restore failed: backup not found`, 'error');
              }
            } catch (e: unknown) { addLog(`Restore failed: ${errMsg(e)}`, 'error'); }
          },
        } : undefined;
        setLogs((prev) => [...prev, { timestamp: new Date(), message: `Deleted "${folderName}" (moved to Removed/)`, level: 'success' as const, action: revertAction }]);
      } catch (err: unknown) {
        addLog(`Delete failed: ${errMsg(err)}`, 'error');
      }
    },
    [addonPath, addons, addLog, scanPath]
  );

  const handleDeleteAddonAndRefs = useCallback(
    async (folderName: string, alsoDeleteSavedVars: boolean = false) => {
      if (!addonPath) return;
      addLog(`Deleting "${folderName}" with exclusive refs...`, 'warn');
      try {
        // Backup addon (and its exclusive libs) before deletion so they appear in Go Back
        const addon = addons.find(a => a.folderName === folderName);
        const backupPaths: { folder: string; path: string }[] = [];
        if (addon && addon.version) {
          const bp = await window.electronAPI.backupAddonFolder(addonPath, folderName, addon.version);
          if (bp) backupPaths.push({ folder: folderName, path: bp });
        }
        // Also backup dependent libraries that may get deleted
        if (addon) {
          const depNames = new Set([
            ...addon.dependsOn.map(d => d.name),
            ...addon.optionalDependsOn.map(d => d.name),
            ...addon.subAddons.flatMap(s => [...s.dependsOn.map(d => d.name), ...s.optionalDependsOn.map(d => d.name)]),
          ]);
          for (const depName of depNames) {
            const depAddon = addons.find(a => a.folderName === depName || a.title === depName);
            if (depAddon && depAddon.version) {
              const bp = await window.electronAPI.backupAddonFolder(addonPath, depAddon.folderName, depAddon.version);
              if (bp) backupPaths.push({ folder: depAddon.folderName, path: bp });
            }
          }
        }
        if (alsoDeleteSavedVars) {
          // Delete SavedVars for parent + all sub-addon names
          const names = [folderName, ...(addon?.subAddons.map(s => s.folderName) || [])];
          const allDeleted: string[] = [];
          for (const name of names) {
            const svResult = await window.electronAPI.deleteSavedVars(addonPath, name);
            allDeleted.push(...svResult.deleted);
          }
          if (allDeleted.length > 0) {
            addLog(`Removed SavedVariables: ${allDeleted.join(', ')} (backed up)`, 'info');
          }
        }
        const result = await window.electronAPI.deleteAddonAndRefs(addonPath, folderName);
        setAddons(result.addons);
        setSelectedAddon(null);
        const deletedNames = [folderName, ...result.removedLibs];
        const msg = result.removedLibs.length > 0
          ? `Deleted "${folderName}" + exclusive libs: ${result.removedLibs.join(', ')}`
          : `Deleted "${folderName}" (no exclusive libs)`;
        const revertAction = backupPaths.length > 0 ? {
          label: '↩ Undo',
          onClick: async () => {
            try {
              let restored = 0;
              for (const { folder, path: bp } of backupPaths) {
                if (deletedNames.includes(folder)) {
                  const ok = await window.electronAPI.restoreAddonBackup(addonPath, folder, bp);
                  if (ok) restored++;
                }
              }
              if (restored > 0) {
                addLog(`Restored ${restored} addon(s) from backup`, 'success');
                scanPath(addonPath);
              } else {
                addLog('Restore failed: no backups found', 'error');
              }
            } catch (e: unknown) { addLog(`Restore failed: ${errMsg(e)}`, 'error'); }
          },
        } : undefined;
        setLogs((prev) => [...prev, { timestamp: new Date(), message: msg, level: 'success' as const, action: revertAction }]);
      } catch (err: unknown) {
        addLog(`Delete failed: ${errMsg(err)}`, 'error');
      }
    },
    [addonPath, addons, addLog, scanPath]
  );

  const handleCleanup = useCallback(async () => {
    if (!addonPath) return;
    if (skipCleanupConfirm) {
      // Direct cleanup without preview
      setLoading(true);
      addLog(`Running cleanup...`);
      try {
        const backupPaths: { folder: string; path: string }[] = [];
        for (const lib of libraries) {
          if (unreferencedLibs.has(lib.folderName) && lib.version) {
            const bp = await window.electronAPI.backupAddonFolder(addonPath, lib.folderName, lib.version);
            if (bp) backupPaths.push({ folder: lib.folderName, path: bp });
          }
        }
        const result = await window.electronAPI.cleanupUnused(addonPath);
        setAddons(result.addons);
        if (result.moved.length > 0) {
          const revertAction = backupPaths.length > 0 ? {
            label: '↩ Undo',
            onClick: async () => {
              try {
                let restored = 0;
                for (const { folder, path: bp } of backupPaths) {
                  const ok = await window.electronAPI.restoreAddonBackup(addonPath, folder, bp);
                  if (ok) restored++;
                }
                if (restored > 0) {
                  addLog(`Restored ${restored} lib(s) from backup`, 'success');
                  scanPath(addonPath);
                } else {
                  addLog('Restore failed: no backups found', 'error');
                }
              } catch (e: unknown) { addLog(`Restore failed: ${errMsg(e)}`, 'error'); }
            },
          } : undefined;
          setLogs((prev) => [...prev, { timestamp: new Date(), message: `Cleanup: moved ${result.moved.length} unreferenced libs to Removed/: ${result.moved.join(', ')}`, level: 'success' as const, action: revertAction }]);
        } else {
          addLog('Cleanup: no unreferenced libraries to remove', 'info');
        }
      } catch (err: unknown) {
        addLog(`Cleanup failed: ${errMsg(err)}`, 'error');
      } finally {
        setLoading(false);
      }
      return;
    }
    // Show preview dialog
    try {
      const items = await window.electronAPI.previewCleanupLibs(addonPath);
      if (items.length === 0) {
        addLog('Cleanup: no unreferenced libraries to remove', 'info');
        return;
      }
      setCleanupDialog({ type: 'libs', items });
    } catch (err: unknown) {
      addLog(`Cleanup preview failed: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addLog, libraries, unreferencedLibs, skipCleanupConfirm, scanPath]);

  const handleCleanupLibsConfirm = useCallback(async (selectedItems: string[]) => {
    setCleanupDialog(null);
    if (!addonPath || selectedItems.length === 0) return;
    setLoading(true);
    addLog(`Removing ${selectedItems.length} unreferenced libraries...`);
    try {
      const backupPaths: { folder: string; path: string }[] = [];
      for (const folderName of selectedItems) {
        const lib = libraries.find(l => l.folderName === folderName);
        if (lib && lib.version) {
          const bp = await window.electronAPI.backupAddonFolder(addonPath, folderName, lib.version);
          if (bp) backupPaths.push({ folder: folderName, path: bp });
        }
      }
      const result = await window.electronAPI.cleanupLibsSelected(addonPath, selectedItems);
      setAddons(result.addons);
      if (result.moved.length > 0) {
        const revertAction = backupPaths.length > 0 ? {
          label: '↩ Undo',
          onClick: async () => {
            try {
              let restored = 0;
              for (const { folder, path: bp } of backupPaths) {
                const ok = await window.electronAPI.restoreAddonBackup(addonPath, folder, bp);
                if (ok) restored++;
              }
              if (restored > 0) {
                addLog(`Restored ${restored} lib(s) from backup`, 'success');
                scanPath(addonPath);
              } else {
                addLog('Restore failed: no backups found', 'error');
              }
            } catch (e: unknown) { addLog(`Restore failed: ${errMsg(e)}`, 'error'); }
          },
        } : undefined;
        setLogs((prev) => [...prev, { timestamp: new Date(), message: `Cleanup: moved ${result.moved.length} libs to Removed/: ${result.moved.join(', ')}`, level: 'success' as const, action: revertAction }]);
      }
    } catch (err: unknown) {
      addLog(`Cleanup failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addLog, libraries, scanPath]);

  const handleUpdateAll = useCallback(() => {
    if (!addonPath) return;

    // If already updating, cancel it
    if (updatingAll) {
      updateCancelRef.current = true;
      addLog('Cancelling Update All...', 'warn');
      return;
    }

    // Find installed addons that have a matching catalog entry with a newer version
    const updatable: UpdatableAddon[] = [];
    const seen = new Set<string>();
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (catalogAddon && !seen.has(catalogAddon.id)) {
        seen.add(catalogAddon.id);
        if (isUpdateAvailable(addon, catalogAddon)) {
          // Ambiguous: no catalogId in manifest → matched only by title/dir,
          // OR title matches a name used by multiple catalog entries
          const ambiguous = !addon.catalogId
            || catalogNameConflicts.has(catalogAddon.name);
          updatable.push({
            folderName: addon.folderName,
            title: addon.title,
            localVersion: getEffectiveVersion(addon, catalogAddon),
            catalogVersion: catalogAddon.version,
            catalogId: catalogAddon.id,
            ambiguous,
          });
        }
      }
    }

    if (updatable.length === 0) {
      addLog('Update All: nothing to update — all addons are up-to-date', 'info');
      return;
    }

    // Show selection dialog
    setUpdateAllList(updatable);
  }, [addons, addonPath, getCatalogAddon, addLog, updatingAll, isUpdateAvailable, getEffectiveVersion, catalogNameConflicts]);

  const handleUpdateAllConfirm = useCallback(async (selectedCatalogIds: string[]) => {
    setUpdateAllList(null);
    if (!addonPath || selectedCatalogIds.length === 0) return;

    const selectedSet = new Set(selectedCatalogIds);
    const updatable: { addon: AddonInfo; catalogAddon: CatalogAddon }[] = [];
    const seen = new Set<string>();
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (catalogAddon && !seen.has(catalogAddon.id) && selectedSet.has(catalogAddon.id)) {
        seen.add(catalogAddon.id);
        updatable.push({ addon, catalogAddon });
      }
    }

    if (updatable.length === 0) return;

    setUpdatingAll(true);
    setUpdateRemaining(updatable.length);
    setUpdateTotal(updatable.length);
    updateCancelRef.current = false;
    setLoading(true);
    addLog(`Updating ${updatable.length} addon(s) from catalog in parallel...`);

    let success = 0;
    let failed = 0;
    let cancelled = 0;
    const newVersions: Record<string, string> = {};

    try {
      // Process in parallel batches of 4
      const BATCH_SIZE = 4;
      for (let i = 0; i < updatable.length; i += BATCH_SIZE) {
        if (updateCancelRef.current) {
          cancelled = updatable.length - i;
          break;
        }
        const batch = updatable.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async ({ addon, catalogAddon }) => {
            if (updateCancelRef.current) throw new Error('cancelled');
            // Backup current version before updating
            if (addon.version) {
              await window.electronAPI.backupAddonFolder(addonPath, addon.folderName, addon.version);
            }
            addLog(`Updating "${addon.folderName}" ${addon.version} → ${catalogAddon.version}...`);
            try {
              const result = await window.electronAPI.installAddon(catalogAddon.id, addonPath);
              if (result.error) {
                addLog(`Failed to update "${addon.folderName}": ${result.error}`, 'error');
                return false;
              } else {
                addLog(`Updated "${addon.folderName}" (${result.installed.join(', ')})`, 'success');
                setRecentlyUpdated((prev) => new Set(prev).add(catalogAddon.id));
                newVersions[catalogAddon.id] = catalogAddon.version;
                return true;
              }
            } catch (err: unknown) {
              addLog(`Error updating "${addon.folderName}": ${errMsg(err)}`, 'error');
              return false;
            }
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) success++;
          else failed++;
        }
        setUpdateRemaining(Math.max(0, updatable.length - i - batch.length));
      }
    } catch (err: unknown) {
      addLog(`Update All encountered an error: ${errMsg(err)}`, 'error');
    } finally {
      // Persist installed catalog versions so update detection survives restarts
      if (Object.keys(newVersions).length > 0) {
        setInstalledCatalogVersions(prev => ({ ...prev, ...newVersions }));
        await window.electronAPI.saveInstalledVersions(newVersions);
      }
      setInstallingAddon(null);
      setUpdatingAll(false);
      setUpdateRemaining(0);
      setUpdateTotal(0);
      updateCancelRef.current = false;
      const summaryParts = [`${success} updated`, `${failed} failed`];
      if (cancelled > 0) summaryParts.push(`${cancelled} cancelled`);
      addLog(`Update All complete: ${summaryParts.join(', ')}`, success > 0 ? 'success' : 'warn');
      await scanPath(addonPath);
    }
  }, [addons, addonPath, getCatalogAddon, addLog, scanPath]);

  const handleCleanupSettings = useCallback(async () => {
    if (!addonPath || addons.length === 0) return;
    const existingNames = addons.flatMap((a) => [a.folderName, ...a.subAddons.map(s => s.folderName)]);
    if (skipCleanupConfirm) {
      // Direct cleanup without preview
      setLoading(true);
      addLog('Cleaning up settings and SavedVariables...');
      try {
        const result = await window.electronAPI.cleanupSettings(addonPath, existingNames);
        if (result.error) {
          addLog(`Cleanup settings error: ${result.error}`, 'error');
        } else {
          const totalRemoved = result.removedFromSettings.length + result.removedSavedVars.length;
          if (totalRemoved === 0) {
            addLog('Settings cleanup: nothing to clean', 'info');
          } else {
            if (result.removedFromSettings.length > 0) {
              addLog(`Removed ${result.removedFromSettings.length} orphaned entries from AddOnSettings.txt: ${result.removedFromSettings.join(', ')}`, 'success');
            }
            if (result.removedSavedVars.length > 0) {
              addLog(`Removed ${result.removedSavedVars.length} orphaned SavedVariables (backed up): ${result.removedSavedVars.join(', ')}`, 'success');
            }
            addCleanupUndoEntry(result.backupPath, result.svBackupDir, totalRemoved);
          }
          const newSettings = await window.electronAPI.getAddonSettings(addonPath);
          setAddonSettings(newSettings);
        }
      } catch (err: unknown) {
        addLog(`Settings cleanup failed: ${errMsg(err)}`, 'error');
      } finally {
        setLoading(false);
      }
      return;
    }
    // Show preview dialog
    try {
      const preview = await window.electronAPI.previewCleanupSettings(addonPath, existingNames);
      if (preview.orphanedSettings.length === 0 && preview.orphanedSavedVars.length === 0) {
        addLog('Settings cleanup: nothing to clean', 'info');
        return;
      }
      setCleanupDialog({ type: 'settings', items: preview.orphanedSettings, savedVarItems: preview.orphanedSavedVars });
    } catch (err: unknown) {
      addLog(`Cleanup preview failed: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addons, addLog, skipCleanupConfirm]);

  const addCleanupUndoEntry = useCallback((backupPath: string, svBackupDir: string, totalRemoved: number) => {
    setLogs((prev) => [
      ...prev,
      {
        timestamp: new Date(),
        message: `Cleanup complete — ${totalRemoved} item(s) removed.`,
        level: 'info' as const,
        action: {
          label: '↩ Undo',
          onClick: async () => {
            try {
              const undo = await window.electronAPI.undoCleanupSettings(addonPath, backupPath, svBackupDir);
              if (undo.error) {
                addLog(`Undo failed: ${undo.error}`, 'error');
              } else {
                const parts: string[] = [];
                if (undo.restoredSettings) parts.push('AddOnSettings.txt restored');
                if (undo.restoredSavedVars.length > 0) parts.push(`${undo.restoredSavedVars.length} SavedVariables restored`);
                addLog(`Undo cleanup: ${parts.join('; ')}`, 'success');
                const newSettings = await window.electronAPI.getAddonSettings(addonPath);
                setAddonSettings(newSettings);
              }
            } catch (err: unknown) {
              addLog(`Undo failed: ${errMsg(err)}`, 'error');
            }
          },
        },
      },
    ]);
  }, [addonPath, addLog]);

  const handleCleanupSettingsConfirm = useCallback(async (selectedSettings: string[], selectedSvItems?: string[]) => {
    setCleanupDialog(null);
    if (!addonPath) return;
    const existingNames = addons.flatMap((a) => [a.folderName, ...a.subAddons.map(s => s.folderName)]);
    setLoading(true);
    addLog('Cleaning up selected settings and SavedVariables...');
    try {
      const result = await window.electronAPI.cleanupSettingsSelected(addonPath, existingNames, selectedSettings, selectedSvItems || []);
      if (result.error) {
        addLog(`Cleanup settings error: ${result.error}`, 'error');
      } else {
        const totalRemoved = result.removedFromSettings.length + result.removedSavedVars.length;
        if (totalRemoved === 0) {
          addLog('Settings cleanup: nothing removed', 'info');
        } else {
          if (result.removedFromSettings.length > 0) {
            addLog(`Removed ${result.removedFromSettings.length} orphaned entries from AddOnSettings.txt: ${result.removedFromSettings.join(', ')}`, 'success');
          }
          if (result.removedSavedVars.length > 0) {
            addLog(`Removed ${result.removedSavedVars.length} orphaned SavedVariables (backed up): ${result.removedSavedVars.join(', ')}`, 'success');
          }
          addCleanupUndoEntry(result.backupPath, result.svBackupDir, totalRemoved);
        }
        const newSettings = await window.electronAPI.getAddonSettings(addonPath);
        setAddonSettings(newSettings);
      }
    } catch (err: unknown) {
      addLog(`Settings cleanup failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addons, addLog, addCleanupUndoEntry]);

  // Handle install from online browser - refresh local scan
  const handleOnlineInstall = useCallback(
    (addon: CatalogAddon) => {
      if (addonPath) {
        // Track installed catalog version to prevent false update detection
        setInstalledCatalogVersions(prev => ({ ...prev, [addon.id]: addon.version }));
        window.electronAPI.saveInstalledVersions({ [addon.id]: addon.version });
        scanPath(addonPath);
      }
    },
    [addonPath, scanPath]
  );

  // Move .zip archives from AddOns root to Downloads/ subfolder
  const handleClearLogs = useCallback(() => setLogs([]), []);

  // Open the restore dialog with snapshot and backup data
  const handleGoBack = useCallback(async () => {
    if (!addonPath) return;
    try {
      const [snaps, bks, svBks] = await Promise.all([
        window.electronAPI.listSnapshots(addonPath),
        window.electronAPI.listAddonBackups(addonPath),
        window.electronAPI.listSvBackups(addonPath),
      ]);
      setRestoreSnapshots(snaps);
      setRestoreBackups(bks);
      setRestoreSvBackups(svBks);
      setShowRestoreDialog(true);
      addLog('Opened restore dialog');
    } catch (err: unknown) {
      addLog(`Failed to load restore data: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addLog]);

  // Restore an addon from a backup
  const handleRestoreBackup = useCallback(
    async (folderName: string, version: string, backupPath: string) => {
      if (!addonPath) return;
      addLog(`Restoring "${folderName}" to version ${version}...`);
      try {
        const ok = await window.electronAPI.restoreAddonBackup(addonPath, folderName, backupPath);
        if (ok) {
          addLog(`Restored "${folderName}" to version ${version}`, 'success');
          // Clear installedCatalogVersions for this addon so update detection works again
          const localAddon = addonMap.get(folderName);
          const catalogAddon = localAddon ? getCatalogAddon(localAddon) : catalogByDir.get(folderName);
          if (catalogAddon) {
            setInstalledCatalogVersions(prev => {
              const next = { ...prev };
              delete next[catalogAddon.id];
              return next;
            });
            // Persist the removal: save empty string to signal deletion
            window.electronAPI.saveInstalledVersions({ [catalogAddon.id]: '' });
          }
          await scanPath(addonPath);
          // Refresh restore dialog data
          const [snaps, bks, svBks] = await Promise.all([
            window.electronAPI.listSnapshots(addonPath),
            window.electronAPI.listAddonBackups(addonPath),
            window.electronAPI.listSvBackups(addonPath),
          ]);
          setRestoreSnapshots(snaps);
          setRestoreBackups(bks);
          setRestoreSvBackups(svBks);
        } else {
          addLog(`Failed to restore "${folderName}"`, 'error');
        }
      } catch (err: unknown) {
        addLog(`Restore failed: ${errMsg(err)}`, 'error');
      }
    },
    [addonPath, addLog, scanPath, addonMap, getCatalogAddon, catalogByDir]
  );

  const handleRestoreSvFile = useCallback(
    async (backupFilePath: string) => {
      if (!addonPath) return;
      const fileName = backupFilePath.split(/[/\\]/).pop() || backupFilePath;
      addLog(`Restoring SavedVariable "${fileName}"...`);
      try {
        const result = await window.electronAPI.restoreSvFile(addonPath, backupFilePath);
        if (result.restored) {
          addLog(`Restored "${result.fileName}" to SavedVariables`, 'success');
          // Refresh SV backups list in dialog
          const svBks = await window.electronAPI.listSvBackups(addonPath);
          setRestoreSvBackups(svBks);
        } else {
          addLog(`Failed to restore "${fileName}": ${result.error || 'unknown error'}`, 'error');
        }
      } catch (err: unknown) {
        addLog(`Restore failed: ${errMsg(err)}`, 'error');
      }
    },
    [addonPath, addLog]
  );

  const handleCleanupDownloads = useCallback(async () => {
    if (!addonPath) return;
    if (skipCleanupConfirm) {
      // Direct cleanup without preview
      setLoading(true);
      addLog('Moving .zip archives to Downloads folder...');
      try {
        const result = await window.electronAPI.cleanupDownloads(addonPath);
        if (result.error) {
          addLog(`Cleanup archives error: ${result.error}`, 'error');
        } else if (result.moved.length > 0) {
          addLog(`Moved ${result.moved.length} archive(s) to Downloads/: ${result.moved.join(', ')}`, 'success');
        } else {
          addLog('No .zip archives found in AddOns folder', 'info');
        }
      } catch (err: unknown) {
        addLog(`Cleanup archives failed: ${errMsg(err)}`, 'error');
      } finally {
        setLoading(false);
      }
      return;
    }
    // Show preview dialog
    try {
      const items = await window.electronAPI.previewCleanupDownloads(addonPath);
      if (items.length === 0) {
        addLog('No .zip archives found in AddOns folder', 'info');
        return;
      }
      setCleanupDialog({ type: 'downloads', items });
    } catch (err: unknown) {
      addLog(`Cleanup preview failed: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addLog, skipCleanupConfirm]);

  const handleCleanupDownloadsConfirm = useCallback(async (selectedItems: string[]) => {
    setCleanupDialog(null);
    if (!addonPath || selectedItems.length === 0) return;
    setLoading(true);
    addLog(`Moving ${selectedItems.length} archive(s) to Downloads folder...`);
    try {
      const result = await window.electronAPI.cleanupDownloadsSelected(addonPath, selectedItems);
      if (result.moved.length > 0) {
        addLog(`Moved ${result.moved.length} archive(s) to Downloads/: ${result.moved.join(', ')}`, 'success');
      }
    } catch (err: unknown) {
      addLog(`Cleanup archives failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addLog]);

  const handleCleanupBackups = useCallback(async () => {
    if (!addonPath) return;
    try {
      const list = await window.electronAPI.listAddonBackups(addonPath);
      setBackupCleanupBackups(list);
    } catch (err: unknown) {
      addLog(`Failed to list backups: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addLog]);

  const handleCleanupBackupsConfirm = useCallback(async (backupPaths: string[]) => {
    setBackupCleanupBackups(null);
    if (backupPaths.length === 0) return;
    try {
      const deleted = await window.electronAPI.deleteAddonBackups(backupPaths);
      addLog(`Deleted ${deleted} old backup(s)`, 'success');
    } catch (err: unknown) {
      addLog(`Backup cleanup failed: ${errMsg(err)}`, 'error');
    }
  }, [addLog]);

  // Install/reinstall an addon from the catalog (used by tree items)
  const handleInstallAddon = useCallback(
    async (catalogAddon: CatalogAddon) => {
      if (!addonPath) return;
      setInstallingAddon(catalogAddon.id);
      addLog(`Installing "${catalogAddon.name}" from catalog...`);
      try {
        // Backup existing addon if it's an update (match by directory or title)
        const existingAddon = addons.find((a) =>
          catalogAddon.directories.includes(a.folderName) || a.title === catalogAddon.name
        );
        let backupPath = '';
        const backupFolder = existingAddon?.folderName || '';
        if (existingAddon && existingAddon.version) {
          backupPath = await window.electronAPI.backupAddonFolder(addonPath, existingAddon.folderName, existingAddon.version);
        }
        const result = await window.electronAPI.installAddon(catalogAddon.id, addonPath);
        if (result.error) {
          addLog(`Failed to install "${catalogAddon.name}": ${result.error}`, 'error');
        } else {
          if (result.missingDeps.length > 0) {
            addLog(`Missing dependencies: ${result.missingDeps.join(', ')}`, 'warn');
          }
          // Track installed catalog version to prevent false update detection
          setInstalledCatalogVersions(prev => ({ ...prev, [catalogAddon.id]: catalogAddon.version }));
          window.electronAPI.saveInstalledVersions({ [catalogAddon.id]: catalogAddon.version });
          scanPath(addonPath);
          // Log with Revert button if this was an update (backup exists)
          const revertAction = backupPath && backupFolder ? {
            label: '↩ Undo',
            onClick: async () => {
              try {
                const ok = await window.electronAPI.restoreAddonBackup(addonPath, backupFolder, backupPath);
                if (ok) {
                  addLog(`Restored "${backupFolder}" to previous version`, 'success');
                  scanPath(addonPath);
                } else {
                  addLog('Restore failed: backup not found', 'error');
                }
              } catch (e: unknown) { addLog(`Restore failed: ${errMsg(e)}`, 'error'); }
            },
          } : undefined;
          setLogs((prev) => [...prev, { timestamp: new Date(), message: `Installed "${catalogAddon.name}" (${result.installed.join(', ')})`, level: 'success' as const, action: revertAction }]);
        }
      } catch (err: unknown) {
        addLog(`Error installing "${catalogAddon.name}": ${errMsg(err)}`, 'error');
      } finally {
        setInstallingAddon(null);
      }
    },
    [addonPath, addons, addLog, scanPath]
  );

  // Simple delete (no savedvars) for inline delete button
  const handleSimpleDelete = useCallback(
    (folderName: string) => {
      const addon = addons.find(a => a.folderName === folderName);
      const title = addon?.title || folderName;
      setDeleteConfirm({ folderName, title, action: () => handleDeleteAddon(folderName) });
    },
    [addons, handleDeleteAddon]
  );

  // Delete + SavedVariables
  const handleDeleteWithSV = useCallback(
    (folderName: string) => {
      const addon = addons.find(a => a.folderName === folderName);
      const title = addon?.title || folderName;
      setDeleteConfirm({ folderName, title: `${title} + SavedVariables`, action: () => handleDeleteAddon(folderName, true) });
    },
    [addons, handleDeleteAddon]
  );

  // Delete + exclusive refs
  const handleDeleteAndRefsSimple = useCallback(
    (folderName: string) => {
      const addon = addons.find(a => a.folderName === folderName);
      const title = addon?.title || folderName;
      setDeleteConfirm({ folderName, title: `${title} + exclusive refs`, action: () => handleDeleteAddonAndRefs(folderName) });
    },
    [addons, handleDeleteAddonAndRefs]
  );

  // Delete + refs + SavedVariables
  const handleDeleteAndRefsWithSV = useCallback(
    (folderName: string) => {
      const addon = addons.find(a => a.folderName === folderName);
      const title = addon?.title || folderName;
      setDeleteConfirm({ folderName, title: `${title} + refs + SavedVariables`, action: () => handleDeleteAddonAndRefs(folderName, true) });
    },
    [addons, handleDeleteAddonAndRefs]
  );

  // Resize log panel by dragging — persist on finish
  const handleLogResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const logEl = document.querySelector('.log-panel') as HTMLElement;
    const startHeight = logEl ? logEl.offsetHeight : 240;

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setLogHeight(Math.max(40, Math.min(window.innerHeight * 0.6, startHeight + delta)));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist current height
      const finalEl = document.querySelector('.log-panel') as HTMLElement;
      const finalH = finalEl ? finalEl.offsetHeight : 240;
      window.electronAPI.saveUiSettings({ logHeight: finalH });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Resize tree panel columns by dragging the separator
  const handlePanelResizeStart = useCallback((panelIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const mainEl = document.querySelector('.main-content') as HTMLElement;
    if (!mainEl) return;
    const panels = mainEl.querySelectorAll<HTMLElement>('.tree-panel, .online-browser');
    if (panels.length < 2) return;
    const leftPanel = panels[panelIndex];
    const rightPanel = panels[panelIndex + 1];
    const startLeftW = leftPanel.offsetWidth;
    const startRightW = rightPanel.offsetWidth;
    const totalW = startLeftW + startRightW;

    // Snapshot ALL panel widths so untouched panels keep their size
    const allWidths = Array.from(panels).map((p) => p.offsetWidth);

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newLeftW = Math.max(150, Math.min(totalW - 150, startLeftW + delta));
      const newRightW = totalW - newLeftW;
      setPanelWidths(() => {
        const next = [...allWidths];
        next[panelIndex] = newLeftW;
        next[panelIndex + 1] = newRightW;
        return next;
      });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist widths
      setPanelWidths((cur) => {
        window.electronAPI.saveUiSettings({ panelWidths: cur });
        return cur;
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Keyboard navigation for tree panels
  const makeTreeKeyHandler = useCallback(
    (items: AddonInfo[], scrollRef: React.RefObject<HTMLDivElement>) => {
      return (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (items.length === 0) return;
        const key = e.key;
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(key)) return;
        e.preventDefault();

        if (key === 'Escape') {
          setSelectedAddon(null);
          return;
        }

        const currentIdx = selectedAddon ? items.findIndex((a) => a.folderName === selectedAddon) : -1;

        if (key === 'ArrowDown') {
          const nextIdx = currentIdx < items.length - 1 ? currentIdx + 1 : 0;
          const next = items[nextIdx];
          setSelectedAddon(next.folderName);
          const el = scrollRef.current?.querySelector(`[data-addon-id="${next.folderName}"]`);
          el?.scrollIntoView({ block: 'nearest' });
        } else if (key === 'ArrowUp') {
          const prevIdx = currentIdx > 0 ? currentIdx - 1 : items.length - 1;
          const prev = items[prevIdx];
          setSelectedAddon(prev.folderName);
          const el = scrollRef.current?.querySelector(`[data-addon-id="${prev.folderName}"]`);
          el?.scrollIntoView({ block: 'nearest' });
        } else if (key === 'Enter') {
          if (currentIdx >= 0) {
            // Simulate a click on the tree row to toggle expand/collapse
            const el = scrollRef.current?.querySelector(`[data-addon-id="${items[currentIdx].folderName}"] .tree-item-row`) as HTMLElement | null;
            el?.click();
          } else if (items.length > 0) {
            setSelectedAddon(items[0].folderName);
          }
        }
      };
    },
    [selectedAddon]
  );

  const handleAddonsKeyDown = useMemo(
    () => makeTreeKeyHandler(filteredAddons, addonsScrollRef),
    [makeTreeKeyHandler, filteredAddons, addonsScrollRef]
  );

  const handleLibsKeyDown = useMemo(
    () => makeTreeKeyHandler(filteredLibraries, libsScrollRef),
    [makeTreeKeyHandler, filteredLibraries, libsScrollRef]
  );

  // Welcome dialog handlers
  const handleWelcomeAccept = useCallback(async () => {
    await window.electronAPI.acceptWelcome();
    setWelcomeAccepted(true);
    addLog('YAAM started', 'info');
    // Now load the addon path from config and scan
    const config = await window.electronAPI.getConfig();
    if (config.addonPath) {
      setAddonPath(config.addonPath);
      scanPath(config.addonPath);
    }
  }, [addLog, scanPath]);

  const handleWelcomeCancel = useCallback(() => {
    window.electronAPI.quitApp();
  }, []);

  // Build context menu items
  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? (() => {
        const addon = contextMenu.addon;
        const hasSV = !!(savedVarsInfo.addonFiles[addon.folderName]?.length);
        const catalogAddon = getCatalogAddon(addon);
        const items: ContextMenuItem[] = [];
        // Open in Explorer / Finder
        items.push({
          label: `Open in ${navigator.platform.startsWith('Mac') ? 'Finder' : 'Explorer'}`,
          onClick: () => {
            if (addonPath) {
              window.electronAPI.openInExplorer(addonPath + '/' + addon.folderName);
            }
          },
          disabled: !addonPath,
        });
        // Reinstall from catalog
        items.push({
          label: `Reinstall "${addon.title}" from catalog`,
          onClick: () => { if (catalogAddon) handleInstallAddon(catalogAddon); },
          disabled: !catalogAddon,
        });
        // Delete options
        items.push({
          label: `Delete "${addon.title}"`,
          danger: true,
          onClick: () => setDeleteConfirm({ folderName: addon.folderName, title: addon.title, action: () => handleDeleteAddon(addon.folderName) }),
        });
        if (hasSV) {
          items.push({
            label: `Delete "${addon.title}" + SavedVariables`,
            danger: true,
            onClick: () => setDeleteConfirm({ folderName: addon.folderName, title: `${addon.title} + SavedVariables`, action: () => handleDeleteAddon(addon.folderName, true) }),
          });
        }
        items.push({
          label: `Delete "${addon.title}" and exclusive refs`,
          danger: true,
          onClick: () => setDeleteConfirm({ folderName: addon.folderName, title: `${addon.title} + exclusive refs`, action: () => handleDeleteAddonAndRefs(addon.folderName) }),
        });
        if (hasSV) {
          items.push({
            label: `Delete "${addon.title}" + refs + SavedVariables`,
            danger: true,
            onClick: () => setDeleteConfirm({ folderName: addon.folderName, title: `${addon.title} + refs + SavedVariables`, action: () => handleDeleteAddonAndRefs(addon.folderName, true) }),
          });
        }
        return items;
      })()
    : [];

  // While loading config, show nothing
  if (welcomeAccepted === null) {
    return <div className="app-container" />;
  }

  return (
    <div className="app-container" onClick={() => setContextMenu(null)}>
      {!welcomeAccepted && (
        <WelcomeDialog onAccept={handleWelcomeAccept} onCancel={handleWelcomeCancel} />
      )}
      <PathBar
        path={addonPath}
        onPathChange={setAddonPath}
        onBrowse={handleBrowse}
        onSave={handleSetPath}
        onRefresh={handleRefresh}
        onOpenFolder={() => { if (addonPath) window.electronAPI.openInExplorer(addonPath); }}
        onCleanup={handleCleanup}
        onCleanupSettings={handleCleanupSettings}
        onCleanupDownloads={handleCleanupDownloads}
        onCleanupBackups={handleCleanupBackups}
        onUpdateAll={handleUpdateAll}
        onGoBack={handleGoBack}
        onImportExport={() => setShowImportExport(true)}
        onAbout={() => setShowAbout(true)}
        onSettings={() => setShowSettings(true)}
        loading={loading}
        hasAddons={addons.length > 0}
        unreferencedCount={unreferencedLibs.size}
        updateCount={updateCount}
        updatingAll={updatingAll}
        updateRemaining={updateRemaining}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="filter-row">
        <StatusBar
          totalAddons={regularAddons.length}
          totalLibraries={libraries.length}
          unreferencedCount={unreferencedLibs.size}
          loading={loading}
          installProgress={installProgress}
          updateTotal={updateTotal}
          updateRemaining={updateRemaining}
        />
      </div>
      <div className="main-content">
        <TreePanel title="AddOns" count={filteredAddons.length} scrollRef={addonsScrollRef} flex={panelWidths[0]} onKeyDown={handleAddonsKeyDown} searchQuery={addonSearchQuery} onSearchChange={setAddonSearchQuery} characters={characterNames} characterFilter={addonCharFilter} onCharacterFilterChange={setAddonCharFilter} hasPendingChanges={pendingCharSettings.size > 0} onSave={handleSaveCharSettings}>
          {filteredAddons.length === 0 && !loading ? (
            <div className="empty-state">
              <div className="icon">📦</div>
              <p>{addonSearchQuery ? 'No matching AddOns' : 'No AddOns found'}</p>
              {!addonSearchQuery && <p>Set the AddOns folder path above</p>}
            </div>
          ) : (() => {
            const updatable = filteredAddons.filter(a => updatableFolders.has(a.folderName));
            const rest = filteredAddons.filter(a => !updatableFolders.has(a.folderName));
            const renderItem = (addon: AddonInfo) => (
              <div key={addon.folderName} data-addon-id={addon.folderName}>
                <AddonTreeItem
                  addon={addon}
                  isSelected={selectedAddon === addon.folderName}
                  onSelect={setSelectedAddon}
                  isNotInCatalog={notInCatalog.has(addon.folderName)}
                  isCatalogMismatch={catalogMismatch.has(addon.folderName)}
                  characterSettings={getCharacterSettingsForAddon(addon.folderName)}
                  hasSavedVars={!!(savedVarsInfo.addonFiles[addon.folderName]?.length) || addon.subAddons.some(s => !!(savedVarsInfo.addonFiles[s.folderName]?.length))}
                  catalogAddon={getCatalogAddon(addon)}
                  isInstalling={installingAddon === getCatalogAddon(addon)?.id}
                  knownAddonNames={knownAddonNames}
                  catalogByDir={catalogByDir}
                  installingAddonId={installingAddon}
                  onNavigate={handleNavigate}
                  onContextMenu={handleContextMenu}
                  onToggleCharSetting={handleToggleCharSetting}
                  onDelete={handleSimpleDelete}
                  onDeleteWithSV={handleDeleteWithSV}
                  onDeleteAndRefs={handleDeleteAndRefsSimple}
                  onDeleteAndRefsWithSV={handleDeleteAndRefsWithSV}
                  onInstall={handleInstallAddon}
                  onNavigateCatalog={handleNavigateCatalog}
                  installProgress={installProgress}
                />
              </div>
            );
            return (
              <>
                {updatable.map(renderItem)}
                {updatable.length > 0 && rest.length > 0 && <div className="tree-update-spacer" />}
                {rest.map(renderItem)}
              </>
            );
          })()}
        </TreePanel>
        <div className="panel-resize-handle" onMouseDown={(e) => handlePanelResizeStart(0, e)} title="Drag to resize" />
        <TreePanel title="Libraries" count={filteredLibraries.length} scrollRef={libsScrollRef} flex={panelWidths[1]} onKeyDown={handleLibsKeyDown} searchQuery={libSearchQuery} onSearchChange={setLibSearchQuery} characters={characterNames} characterFilter={libCharFilter} onCharacterFilterChange={setLibCharFilter} hasPendingChanges={pendingCharSettings.size > 0} onSave={handleSaveCharSettings}>
          {filteredLibraries.length === 0 && !loading ? (
            <div className="empty-state">
              <div className="icon">📚</div>
              <p>{libSearchQuery ? 'No matching Libraries' : 'No Libraries found'}</p>
              {!libSearchQuery && <p>Set the AddOns folder path above</p>}
            </div>
          ) : (() => {
            const updatable = filteredLibraries.filter(a => updatableFolders.has(a.folderName));
            const rest = filteredLibraries.filter(a => !updatableFolders.has(a.folderName));
            const renderItem = (lib: AddonInfo) => (
              <div key={lib.folderName} data-addon-id={lib.folderName}>
                <AddonTreeItem
                  addon={lib}
                  isSelected={selectedAddon === lib.folderName}
                  onSelect={setSelectedAddon}
                  isUnreferenced={unreferencedLibs.has(lib.folderName)}
                  isNotInCatalog={notInCatalog.has(lib.folderName)}
                  isCatalogMismatch={catalogMismatch.has(lib.folderName)}
                  referencedBy={getReferencedBy(lib)}
                  characterSettings={getCharacterSettingsForAddon(lib.folderName)}
                  hasSavedVars={!!(savedVarsInfo.addonFiles[lib.folderName]?.length) || lib.subAddons.some(s => !!(savedVarsInfo.addonFiles[s.folderName]?.length))}
                  catalogAddon={getCatalogAddon(lib)}
                  isInstalling={installingAddon === getCatalogAddon(lib)?.id}
                  knownAddonNames={knownAddonNames}
                  catalogByDir={catalogByDir}
                  installingAddonId={installingAddon}
                  onNavigate={handleNavigate}
                  onContextMenu={handleContextMenu}
                  onToggleCharSetting={handleToggleCharSetting}
                  onDelete={handleSimpleDelete}
                  onDeleteWithSV={handleDeleteWithSV}
                  onDeleteAndRefs={handleDeleteAndRefsSimple}
                  onDeleteAndRefsWithSV={handleDeleteAndRefsWithSV}
                  onInstall={handleInstallAddon}
                  onNavigateCatalog={handleNavigateCatalog}
                  installProgress={installProgress}
                />
              </div>
            );
            return (
              <>
                {updatable.map(renderItem)}
                {updatable.length > 0 && rest.length > 0 && <div className="tree-update-spacer" />}
                {rest.map(renderItem)}
              </>
            );
          })()}
        </TreePanel>
        <div className="panel-resize-handle" onMouseDown={(e) => handlePanelResizeStart(1, e)} title="Drag to resize" />
        <OnlineBrowser
          flex={panelWidths[2]}
          installedDirNames={installedDirNames}
          localAddons={addons}
          addonPath={addonPath}
          knownAddonNames={knownAddonNames}
          onInstall={handleOnlineInstall}
          onLog={addLog}
          onNavigate={handleNavigate}
          onDelete={handleSimpleDelete}
          getCharacterSettings={getCharacterSettingsForAddon}
          onToggleCharSetting={handleToggleCharSetting}
          highlightAddonId={catalogHighlightId}
          catalogByDir={catalogByDir}
          installingAddonId={installingAddon}
          installProgress={installProgress}
          checkUpdateAvailable={isUpdateAvailable}
        />
      </div>
      <div className="log-resize-handle" onMouseDown={handleLogResizeStart} title="Drag to resize" />
      <LogPanel logs={logs} height={logHeight} knownNames={knownAddonNames} onNavigate={handleNavigate} onClear={handleClearLogs} />
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      {showUnsavedDialog && (
        <UnsavedDialog
          onSave={() => {
            setShowUnsavedDialog(false);
            window.electronAPI.respondUnsavedDialog('save');
          }}
          onDiscard={() => {
            setShowUnsavedDialog(false);
            window.electronAPI.respondUnsavedDialog('discard');
          }}
          onCancel={() => {
            setShowUnsavedDialog(false);
            window.electronAPI.respondUnsavedDialog('cancel');
          }}
        />
      )}
      {showRestoreDialog && (
        <RestoreDialog
          snapshots={restoreSnapshots}
          backups={restoreBackups}
          svBackups={restoreSvBackups}
          currentAddons={addons.map((a) => ({ folderName: a.folderName, version: a.version }))}
          onRestoreBackup={handleRestoreBackup}
          onRestoreSvFile={handleRestoreSvFile}
          onClose={() => setShowRestoreDialog(false)}
        />
      )}
      {showImportExport && (
        <ImportExportDialog
          addonPath={addonPath}
          addons={addons.map((a) => ({ folderName: a.folderName, version: a.version, isLibrary: a.isLibrary, dependsOn: a.dependsOn.map((d) => d.name) }))}
          catalogByDir={catalogByDir}
          onLog={addLog}
          onScanPath={scanPath}
          onClose={() => setShowImportExport(false)}
        />
      )}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {showSettings && (
        <SettingsDialog
          fontSize={fontSize}
          fontFamily={fontFamily}
          skipCleanupConfirm={skipCleanupConfirm}
          onApply={(s) => {
            setFontSize(s.fontSize);
            setFontFamily(s.fontFamily);
            setSkipCleanupConfirm(s.skipCleanupConfirm);
            window.electronAPI.saveUiSettings({ fontSize: s.fontSize, fontFamily: s.fontFamily, skipCleanupConfirm: s.skipCleanupConfirm });
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {cleanupDialog && (
        <CleanupDialog
          type={cleanupDialog.type}
          items={cleanupDialog.items}
          savedVarItems={cleanupDialog.savedVarItems}
          onConfirm={(items, svItems) => {
            if (cleanupDialog.type === 'libs') handleCleanupLibsConfirm(items);
            else if (cleanupDialog.type === 'settings') handleCleanupSettingsConfirm(items, svItems);
            else if (cleanupDialog.type === 'downloads') handleCleanupDownloadsConfirm(items);
          }}
          onCancel={() => setCleanupDialog(null)}
        />
      )}
      {backupCleanupBackups && (
        <BackupCleanupDialog
          backups={backupCleanupBackups}
          onConfirm={handleCleanupBackupsConfirm}
          onCancel={() => setBackupCleanupBackups(null)}
        />
      )}
      {updateAllList && (
        <UpdateAllDialog
          addons={updateAllList}
          onConfirm={handleUpdateAllConfirm}
          onCancel={() => setUpdateAllList(null)}
        />
      )}
      {deleteConfirm && (
        <div className="unsaved-overlay">
          <div className="restore-dialog" style={{ width: 'min(400px, 90vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="restore-header">
              <div className="restore-title">⚠️ Confirm Delete</div>
            </div>
            <div className="restore-content" style={{ padding: '16px 20px' }}>
              <p>Delete "<strong>{deleteConfirm.title}</strong>"?</p>
              <p style={{ fontSize: '12px', opacity: 0.7 }}>The addon will be moved to the Removed/ folder.</p>
            </div>
            <div className="settings-actions" style={{ padding: '12px 16px' }}>
              <button className="restore-btn" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="restore-btn ie-action-btn" style={{ background: 'var(--danger, #e53935)' }} onClick={() => { deleteConfirm.action(); setDeleteConfirm(null); }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
