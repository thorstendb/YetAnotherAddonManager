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
import './styles/App.css';

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
  const [installProgress, setInstallProgress] = useState<Record<string, { phase: string; percent?: number }>>({});
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
        setInstallProgress(prev => ({ ...prev, [data.addonId]: { phase: data.phase, percent: data.percent } }));
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
    } catch (err: any) {
      addLog(`Scan failed: ${err.message || err}`, 'error');
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
    if (addonPath) scanPath(addonPath);
  }, [addonPath, scanPath]);

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
    const missing = new Set<string>();
    for (const addon of addons) {
      if (!catalogDirNames.has(addon.folderName) && !addon.downloadUrl) {
        missing.add(addon.folderName);
      }
    }
    return missing;
  }, [addons, catalogDirNames]);

  // Map from folder name -> CatalogAddon for local addon matching
  const catalogByDir = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    for (const addon of catalogAddons) {
      for (const dir of addon.directories) {
        map.set(dir, addon);
      }
      // Also map by addon name (for dependency lookups by title)
      map.set(addon.name, addon);
    }
    return map;
  }, [catalogAddons]);

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
    } catch (err: any) {
      addLog(`Save failed: ${err.message || err}`, 'error');
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
      const catalogAddon = catalogByDir.get(addon.folderName);
      if (catalogAddon && !seen.has(catalogAddon.id)) {
        seen.add(catalogAddon.id);
        if (isUpdateAvailable(addon, catalogAddon)) count++;
      }
    }
    return count;
  }, [addons, catalogByDir, isUpdateAvailable]);

  // Set of folder names that have an update available (used for sorting to top)
  const updatableFolders = useMemo(() => {
    const set = new Set<string>();
    const seen = new Set<string>();
    for (const addon of addons) {
      const catalogAddon = catalogByDir.get(addon.folderName);
      if (catalogAddon && !seen.has(catalogAddon.id)) {
        seen.add(catalogAddon.id);
        if (isUpdateAvailable(addon, catalogAddon)) {
          // Mark all directories belonging to this catalog addon as updatable
          for (const dir of catalogAddon.directories) set.add(dir);
        }
      }
    }
    return set;
  }, [addons, catalogByDir, isUpdateAvailable]);

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
      // Backup addon before deletion so it appears in Go Back
      const addon = addons.find(a => a.folderName === folderName);
      if (addon && addon.version) {
        await window.electronAPI.backupAddonFolder(addonPath, folderName, addon.version);
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
      addLog(`Deleted "${folderName}" (moved to Removed/)`, 'success');
    },
    [addonPath, addons, addLog]
  );

  const handleDeleteAddonAndRefs = useCallback(
    async (folderName: string, alsoDeleteSavedVars: boolean = false) => {
      if (!addonPath) return;
      addLog(`Deleting "${folderName}" with exclusive refs...`, 'warn');
      // Backup addon (and its exclusive libs) before deletion so they appear in Go Back
      const addon = addons.find(a => a.folderName === folderName);
      if (addon && addon.version) {
        await window.electronAPI.backupAddonFolder(addonPath, folderName, addon.version);
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
            await window.electronAPI.backupAddonFolder(addonPath, depAddon.folderName, depAddon.version);
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
      if (result.removedLibs.length > 0) {
        addLog(
          `Deleted "${folderName}" + exclusive libs: ${result.removedLibs.join(', ')}`,
          'success'
        );
      } else {
        addLog(`Deleted "${folderName}" (no exclusive libs)`, 'success');
      }
    },
    [addonPath, addons, addLog]
  );

  const handleCleanup = useCallback(async () => {
    if (!addonPath) return;
    setLoading(true);
    addLog(`Running cleanup...`);
    try {
      // Backup unreferenced libraries before removing so they appear in Go Back
      for (const lib of libraries) {
        if (unreferencedLibs.has(lib.folderName) && lib.version) {
          await window.electronAPI.backupAddonFolder(addonPath, lib.folderName, lib.version);
        }
      }
      const result = await window.electronAPI.cleanupUnused(addonPath);
      setAddons(result.addons);
      if (result.moved.length > 0) {
        addLog(`Cleanup: moved ${result.moved.length} unreferenced libs to Removed/: ${result.moved.join(', ')}`, 'success');
      } else {
        addLog('Cleanup: no unreferenced libraries to remove', 'info');
      }
    } catch (err: any) {
      addLog(`Cleanup failed: ${err.message || err}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addLog, libraries, unreferencedLibs]);

  const handleUpdateAll = useCallback(async () => {
    if (!addonPath) return;

    // If already updating, cancel it
    if (updatingAll) {
      updateCancelRef.current = true;
      addLog('Cancelling Update All...', 'warn');
      return;
    }

    // Find installed addons that have a matching catalog entry with a newer version
    const updatable: { addon: AddonInfo; catalogAddon: CatalogAddon }[] = [];
    const seen = new Set<string>();
    let skippedCount = 0;
    for (const addon of addons) {
      const catalogAddon = catalogByDir.get(addon.folderName);
      if (catalogAddon && !seen.has(catalogAddon.id)) {
        seen.add(catalogAddon.id);
        if (isUpdateAvailable(addon, catalogAddon)) {
          updatable.push({ addon, catalogAddon });
        } else {
          skippedCount++;
        }
      }
    }

    if (updatable.length === 0) {
      addLog(`Update All: nothing to update (${skippedCount} up-to-date)`, 'info');
      return;
    }

    setUpdatingAll(true);
    setUpdateRemaining(updatable.length);
    setUpdateTotal(updatable.length);
    updateCancelRef.current = false;
    setLoading(true);
    addLog(`Updating ${updatable.length} addon(s) from catalog in parallel (${skippedCount} skipped)...`);

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
            } catch (err: any) {
              addLog(`Error updating "${addon.folderName}": ${err.message || err}`, 'error');
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
    } catch (err: any) {
      addLog(`Update All encountered an error: ${err.message || err}`, 'error');
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
  }, [addons, addonPath, catalogByDir, addLog, scanPath, updatingAll, isUpdateAvailable]);

  const handleCleanupSettings = useCallback(async () => {
    if (!addonPath || addons.length === 0) return;
    setLoading(true);
    addLog('Cleaning up settings and SavedVariables...');
    try {
      // Include sub-addon names so their settings aren't destroyed
      const existingNames = addons.flatMap((a) => [a.folderName, ...a.subAddons.map(s => s.folderName)]);
      const result = await window.electronAPI.cleanupSettings(addonPath, existingNames);
      if (result.error) {
        addLog(`Cleanup settings error: ${result.error}`, 'error');
      } else {
        const totalRemoved = result.removedFromSettings.length + result.removedSavedVars.length;
        if (totalRemoved === 0) {
          addLog('Settings cleanup: nothing to clean', 'info');
        } else {
          // Log individual removed items
          if (result.removedFromSettings.length > 0) {
            addLog(`Removed ${result.removedFromSettings.length} orphaned entries from AddOnSettings.txt: ${result.removedFromSettings.join(', ')}`, 'success');
          }
          if (result.removedSavedVars.length > 0) {
            addLog(`Removed ${result.removedSavedVars.length} orphaned SavedVariables (backed up): ${result.removedSavedVars.join(', ')}`, 'success');
          }
          // Add undo entry
          const backupPath = result.backupPath;
          const svBackupDir = result.svBackupDir;
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
                      // Refresh settings
                      const newSettings = await window.electronAPI.getAddonSettings(addonPath);
                      setAddonSettings(newSettings);
                    }
                  } catch (err: any) {
                    addLog(`Undo failed: ${err.message || err}`, 'error');
                  }
                },
              },
            },
          ]);
        }
        // Refresh settings
        const newSettings = await window.electronAPI.getAddonSettings(addonPath);
        setAddonSettings(newSettings);
      }
    } catch (err: any) {
      addLog(`Settings cleanup failed: ${err.message || err}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addons, addLog]);

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
    } catch (err: any) {
      addLog(`Failed to load restore data: ${err.message || err}`, 'error');
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
          const catalogAddon = catalogByDir.get(folderName);
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
      } catch (err: any) {
        addLog(`Restore failed: ${err.message || err}`, 'error');
      }
    },
    [addonPath, addLog, scanPath, catalogByDir]
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
      } catch (err: any) {
        addLog(`Restore failed: ${err.message || err}`, 'error');
      }
    },
    [addonPath, addLog]
  );

  const handleCleanupDownloads = useCallback(async () => {
    if (!addonPath) return;
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
    } catch (err: any) {
      addLog(`Cleanup archives failed: ${err.message || err}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addLog]);

  // Install/reinstall an addon from the catalog (used by tree items)
  const handleInstallAddon = useCallback(
    async (catalogAddon: CatalogAddon) => {
      if (!addonPath) return;
      setInstallingAddon(catalogAddon.id);
      addLog(`Installing "${catalogAddon.name}" from catalog...`);
      try {
        // Backup existing addon if it's an update
        const existingAddon = addons.find((a) => catalogAddon.directories.includes(a.folderName));
        if (existingAddon && existingAddon.version) {
          await window.electronAPI.backupAddonFolder(addonPath, existingAddon.folderName, existingAddon.version);
        }
        const result = await window.electronAPI.installAddon(catalogAddon.id, addonPath);
        if (result.error) {
          addLog(`Failed to install "${catalogAddon.name}": ${result.error}`, 'error');
        } else {
          addLog(`Installed "${catalogAddon.name}" (${result.installed.join(', ')})`, 'success');
          if (result.missingDeps.length > 0) {
            addLog(`Missing dependencies: ${result.missingDeps.join(', ')}`, 'warn');
          }
          // Track installed catalog version to prevent false update detection
          setInstalledCatalogVersions(prev => ({ ...prev, [catalogAddon.id]: catalogAddon.version }));
          window.electronAPI.saveInstalledVersions({ [catalogAddon.id]: catalogAddon.version });
          scanPath(addonPath);
        }
      } catch (err: any) {
        addLog(`Error installing "${catalogAddon.name}": ${err.message || err}`, 'error');
      } finally {
        setInstallingAddon(null);
      }
    },
    [addonPath, addLog, scanPath]
  );

  // Simple delete (no savedvars) for inline delete button
  const handleSimpleDelete = useCallback(
    (folderName: string) => {
      handleDeleteAddon(folderName);
    },
    [handleDeleteAddon]
  );

  // Delete + SavedVariables
  const handleDeleteWithSV = useCallback(
    (folderName: string) => {
      handleDeleteAddon(folderName, true);
    },
    [handleDeleteAddon]
  );

  // Delete + exclusive refs
  const handleDeleteAndRefsSimple = useCallback(
    (folderName: string) => {
      handleDeleteAddonAndRefs(folderName);
    },
    [handleDeleteAddonAndRefs]
  );

  // Delete + refs + SavedVariables
  const handleDeleteAndRefsWithSV = useCallback(
    (folderName: string) => {
      handleDeleteAddonAndRefs(folderName, true);
    },
    [handleDeleteAddonAndRefs]
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
        const catalogAddon = catalogByDir.get(addon.folderName);
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
          onClick: () => handleDeleteAddon(addon.folderName),
        });
        if (hasSV) {
          items.push({
            label: `Delete "${addon.title}" + SavedVariables`,
            danger: true,
            onClick: () => handleDeleteAddon(addon.folderName, true),
          });
        }
        items.push({
          label: `Delete "${addon.title}" and exclusive refs`,
          danger: true,
          onClick: () => handleDeleteAddonAndRefs(addon.folderName),
        });
        if (hasSV) {
          items.push({
            label: `Delete "${addon.title}" + refs + SavedVariables`,
            danger: true,
            onClick: () => handleDeleteAddonAndRefs(addon.folderName, true),
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
                  characterSettings={getCharacterSettingsForAddon(addon.folderName)}
                  hasSavedVars={!!(savedVarsInfo.addonFiles[addon.folderName]?.length) || addon.subAddons.some(s => !!(savedVarsInfo.addonFiles[s.folderName]?.length))}
                  catalogAddon={catalogByDir.get(addon.folderName)}
                  isInstalling={installingAddon === catalogByDir.get(addon.folderName)?.id}
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
        <div className="panel-resize-handle" onMouseDown={(e) => handlePanelResizeStart(0, e)} />
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
                  referencedBy={getReferencedBy(lib)}
                  characterSettings={getCharacterSettingsForAddon(lib.folderName)}
                  hasSavedVars={!!(savedVarsInfo.addonFiles[lib.folderName]?.length) || lib.subAddons.some(s => !!(savedVarsInfo.addonFiles[s.folderName]?.length))}
                  catalogAddon={catalogByDir.get(lib.folderName)}
                  isInstalling={installingAddon === catalogByDir.get(lib.folderName)?.id}
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
        <div className="panel-resize-handle" onMouseDown={(e) => handlePanelResizeStart(1, e)} />
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
      <div className="log-resize-handle" onMouseDown={handleLogResizeStart} />
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
          onApply={(s) => {
            setFontSize(s.fontSize);
            setFontFamily(s.fontFamily);
            window.electronAPI.saveUiSettings({ fontSize: s.fontSize, fontFamily: s.fontFamily });
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;
