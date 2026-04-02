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
  const [addonCollapseAll, setAddonCollapseAll] = useState(0);
  const [libCollapseAll, setLibCollapseAll] = useState(0);
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
  const [restoreBackups, setRestoreBackups] = useState<{ folderName: string; version: string; backupPath: string; mtimeMs: number }[]>([]);
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
      // installedCatalogVersions is intentionally NOT loaded from config.
      // It is a session-only guard set after each install to suppress false
      // "update available" during the same session.  The persistent guard is
      // yaamMeta.catalogVersion (checked with cmp >= 0). Loading the persisted
      // map would mask real updates when the local addon was replaced manually.
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
      // Only replace catalog if fetch succeeded (non-empty response).
      // A failed refetch should not clear existing catalog data and break update detection.
      if (onlineList.length > 0) setCatalogAddons(onlineList);
      // Clear recently-updated tracking since we have fresh data
      setRecentlyUpdated(new Set());

      // Reconcile central YAAM addon database with catalog matches
      if (onlineList.length > 0) {
        // Build quick lookup maps from the fresh catalog
        const catById = new Map<string, CatalogAddon>();
        const catByUrl = new Map<string, CatalogAddon>();
        const catByDir = new Map<string, CatalogAddon>();
        const catByDirIsPrimary = new Map<string, boolean>();
        const dirCount = new Map<string, number>();
        for (const ca of onlineList) {
          catById.set(ca.id, ca);
          if (ca.infoUrl) catByUrl.set(ca.infoUrl.toLowerCase(), ca);
          for (let i = 0; i < ca.directories.length; i++) {
            const d = ca.directories[i];
            const primary = i === 0;
            const existingPrimary = catByDirIsPrimary.get(d) || false;
            // Primary dir always wins over secondary; among same tier prefer later (arbitrary)
            if (!catByDir.has(d) || (primary && !existingPrimary)) {
              catByDir.set(d, ca);
              catByDirIsPrimary.set(d, primary);
            }
            dirCount.set(d, (dirCount.get(d) || 0) + 1);
          }
        }

        const matches: { folderName: string; esouid: string; name: string; author: string; version: string; url: string; localVersion: string; confident: boolean }[] = [];
        for (const addon of results) {
          // Priority: DB entry > catalogId > URL > directory
          const byMeta = addon.yaamMeta?.esouid ? catById.get(addon.yaamMeta.esouid) : undefined;
          const byId = addon.catalogId ? catById.get(addon.catalogId) : undefined;
          const byUrl = addon.downloadUrl ? catByUrl.get(addon.downloadUrl.toLowerCase()) : undefined;
          const byDir = catByDir.get(addon.folderName);

          const best = byMeta ?? byId ?? byUrl ?? byDir;
          if (!best) continue;

          // Confident = matched by DB entry, catalogId, URL, or unambiguous directory
          const confident = !!(byMeta || byId || byUrl || (byDir && (dirCount.get(addon.folderName) || 0) <= 1));
          matches.push({
            folderName: addon.folderName,
            esouid: best.id,
            name: best.name,
            author: best.author,
            version: best.version,
            url: best.infoUrl,
            localVersion: addon.version,
            confident,
          });
        }

        if (matches.length > 0) {
          window.electronAPI.reconcileYaamMeta(pathToScan, matches).then(res => {
            if (res.created > 0 || res.updated > 0) {
              addLog(`Database reconciled: ${res.created} created, ${res.updated} updated`, 'info');
              for (const d of res.details) addLog(`  ${d}`, 'info');
              // Re-inject updated yaamMeta into addons state so update detection
              // uses fresh catalogVersion / localVersion values without needing a rescan.
              const matchMap = new Map(matches.map(m => [m.folderName, m]));
              setAddons(prev => prev.map(a => {
                const m = matchMap.get(a.folderName);
                if (!m) return a;
                // For newly created entries (no existing yaamMeta from scan),
                // inject a basic yaamMeta so update detection uses the DB guard
                // instead of falling through to the raw cmp < 0 path.
                if (!a.yaamMeta) {
                  return {
                    ...a,
                    yaamMeta: {
                      esouid: m.esouid,
                      url: m.url,
                      catalogName: m.name,
                      catalogAuthor: m.author,
                      catalogVersion: '',  // empty = never installed via YAAM
                      localVersion: m.localVersion,
                      installedAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    },
                  };
                }
                // Reconciliation only updates localVersion (not catalogVersion).
                // Only re-inject if localVersion changed.
                if (a.yaamMeta.localVersion === m.localVersion) return a;
                return {
                  ...a,
                  yaamMeta: {
                    ...a.yaamMeta,
                    localVersion: m.localVersion,
                  },
                };
              }));
            }
          }).catch(() => {});
        }
      }

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

  // Set of installed directory names for the online browser (includes sub-addon dirs)
  const installedDirNames = useMemo(() => {
    const set = new Set<string>();
    for (const a of addons) {
      set.add(a.folderName);
      for (const sub of a.subAddons) set.add(sub.folderName);
    }
    return set;
  }, [addons]);

  // Set of addons NOT found in the catalog and without their own download URL
  // (computed after catalog lookup maps below, but declared here for readability)

  // ─── Catalog lookup maps ───

  // 1. UID → CatalogAddon (exact, unique)
  const catalogById = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    for (const addon of catalogAddons) map.set(addon.id, addon);
    return map;
  }, [catalogAddons]);

  // 2. Normalized infoUrl → CatalogAddon (unique per catalog entry)
  const catalogByUrl = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    for (const addon of catalogAddons) {
      if (addon.infoUrl) map.set(addon.infoUrl.toLowerCase(), addon);
    }
    return map;
  }, [catalogAddons]);

  // 3. Addon name → CatalogAddon (may collide — keep most-downloaded)
  const catalogByName = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    for (const addon of catalogAddons) {
      const existing = map.get(addon.name);
      if (!existing || addon.totalDownloads > existing.totalDownloads) {
        map.set(addon.name, addon);
      }
    }
    return map;
  }, [catalogAddons]);

  // 4. Directory name → CatalogAddon
  // Prefer entries where the dir is the PRIMARY directory (directories[0]),
  // not just a bundled library.  Among same-priority entries, keep most-downloaded.
  const catalogByDir = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    const isPrimary = new Map<string, boolean>();
    for (const addon of catalogAddons) {
      for (let i = 0; i < addon.directories.length; i++) {
        const dir = addon.directories[i];
        const primary = i === 0;
        const existing = map.get(dir);
        const existingPrimary = isPrimary.get(dir) || false;
        // Primary always beats secondary; among same tier, prefer more downloads
        if (!existing
          || (primary && !existingPrimary)
          || (primary === existingPrimary && addon.totalDownloads > existing.totalDownloads)) {
          map.set(dir, addon);
          isPrimary.set(dir, primary);
        }
      }
    }
    return map;
  }, [catalogAddons]);

  // Combined lookup: dir + name → CatalogAddon (for dependency resolution in UI)
  const catalogLookup = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    // Dirs first (lower priority)
    for (const [dir, addon] of catalogByDir) map.set(dir, addon);
    // Names on top (higher priority — name wins when dir === name)
    for (const [name, addon] of catalogByName) map.set(name, addon);
    return map;
  }, [catalogByDir, catalogByName]);

  // Conflict sets: names/dirs claimed by more than one catalog entry
  const catalogNameConflicts = useMemo(() => {
    const count = new Map<string, number>();
    for (const a of catalogAddons) count.set(a.name, (count.get(a.name) || 0) + 1);
    const s = new Set<string>();
    for (const [n, c] of count) if (c > 1) s.add(n);
    return s;
  }, [catalogAddons]);

  const catalogDirConflicts = useMemo(() => {
    const count = new Map<string, number>();
    for (const a of catalogAddons) for (const d of a.directories) count.set(d, (count.get(d) || 0) + 1);
    const s = new Set<string>();
    for (const [d, c] of count) if (c > 1) s.add(d);
    return s;
  }, [catalogAddons]);

  /** Look up the catalog entry for an installed addon.
   *  Priority:  0. YAAM database entry  1. UID  2. URL  3. Title  4. Directory name
   *  Returns { catalogAddon, ambiguous } where ambiguous is true when the
   *  match method is uncertain or different methods point to different entries. */
  const getCatalogMatch = useCallback(
    (addon: AddonInfo): { catalogAddon: CatalogAddon; ambiguous: boolean } | undefined => {
      // 0. YAAM database entry (written by YAAM on install — most reliable)
      const byMeta = addon.yaamMeta?.esouid ? catalogById.get(addon.yaamMeta.esouid) : undefined;
      // 1. UID from manifest URL (always unique in the catalog)
      const byId = addon.catalogId ? catalogById.get(addon.catalogId) : undefined;
      // 2. Full URL match (normalized comparison)
      const byUrl = addon.downloadUrl
        ? catalogByUrl.get(addon.downloadUrl.toLowerCase())
        : undefined;
      // 3. Title → catalog name
      const byName = catalogByName.get(addon.title);
      // 4. Folder name → catalog directory
      const byDir = catalogByDir.get(addon.folderName);

      // Pick the best match (first non-undefined in priority order)
      const best = byMeta ?? byId ?? byUrl ?? byName ?? byDir;
      if (!best) return undefined;

      // Cross-check: do the other methods agree or contradict?
      const candidates = [byMeta, byId, byUrl, byName, byDir].filter(Boolean) as CatalogAddon[];
      const allAgree = candidates.every(c => c.id === best.id);

      // Ambiguous when:
      //  - different methods point to different catalog entries, OR
      //  - matched only by name that has conflicts (multiple entries share it), OR
      //  - matched only by dir that has conflicts
      const matchedByMeta = !!byMeta;
      const matchedById = !!byId;
      const matchedByUrl = !!byUrl;
      const ambiguous = !allAgree
        || (!matchedByMeta && !matchedById && !matchedByUrl && byName && catalogNameConflicts.has(best.name))
        || (!matchedByMeta && !matchedById && !matchedByUrl && !byName && byDir && catalogDirConflicts.has(addon.folderName));

      return { catalogAddon: best, ambiguous: !!ambiguous };
    },
    [catalogById, catalogByUrl, catalogByName, catalogByDir, catalogNameConflicts, catalogDirConflicts]
  );

  /** Convenience: just the CatalogAddon (for call sites that don't need ambiguity info) */
  const getCatalogAddon = useCallback(
    (addon: AddonInfo): CatalogAddon | undefined => getCatalogMatch(addon)?.catalogAddon,
    [getCatalogMatch]
  );

  // Set of addons NOT found in the catalog and without their own download URL
  const notInCatalog = useMemo(() => {
    if (catalogDirNames.size === 0) return new Set<string>();
    const missing = new Set<string>();
    for (const addon of addons) {
      if (getCatalogAddon(addon)) continue;
      if (!addon.downloadUrl) missing.add(addon.folderName);
    }
    return missing;
  }, [addons, catalogDirNames, getCatalogAddon]);

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

  /** Detect replacement candidates: a different catalog addon now targets the
   *  same folder (e.g. "BindAll" was installed from ID 123 but ID 456 also
   *  lists "BindAll" in its directories). Returns Map<folderName, CatalogAddon>. */
  const replacementCandidates = useMemo(() => {
    const map = new Map<string, CatalogAddon>();
    if (catalogAddons.length === 0) return map;
    // Build dir → all catalog entries mapping
    const dirToAll = new Map<string, CatalogAddon[]>();
    for (const ca of catalogAddons) {
      for (const d of ca.directories) {
        const list = dirToAll.get(d) || [];
        list.push(ca);
        dirToAll.set(d, list);
      }
    }
    for (const addon of addons) {
      const currentMatch = getCatalogAddon(addon);
      const currentId = currentMatch?.id || addon.yaamMeta?.esouid;
      if (!currentId) continue;
      const candidates = dirToAll.get(addon.folderName);
      if (!candidates || candidates.length <= 1) continue;
      // Find a different catalog entry targeting the same folder
      // Prefer the one with higher downloads (more likely the maintained fork)
      for (const ca of candidates) {
        if (ca.id === currentId) continue;
        // Skip entries where the shared dir is only a bundled secondary
        // (not directories[0]) — this addon just bundles a lib, not a real replacement
        if (ca.directories[0] !== addon.folderName) continue;
        // Skip if the current match's version is already >= the replacement
        // (no point suggesting a swap when the installed version is current)
        if (currentMatch && currentMatch.version) {
          const cmp = compareVersionStrings(currentMatch.version, ca.version, ca.date);
          if (cmp >= 0) continue;
        }
        const existing = map.get(addon.folderName);
        if (!existing || ca.totalDownloads > existing.totalDownloads) {
          map.set(addon.folderName, ca);
        }
      }
    }
    return map;
  }, [addons, catalogAddons, getCatalogAddon]);

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
      // Skip recently-updated addons (local version hasn't been rescanned yet)
      if (recentlyUpdated.has(catalogAddon.id)) return false;
      // Session guard: we just installed this exact catalog revision in this
      // session.  The local manifest version may use a different format than
      // the catalog (e.g. "1.05" vs "105"), so comparing them is unreliable.
      // Trust the session record unconditionally.
      if (installedCatalogVersions[catalogAddon.id] === catalogAddon.version) return false;
      const localVer = getEffectiveVersion(addon, catalogAddon);
      const cmp = compareVersionStrings(localVer, catalogAddon.version, catalogAddon.date);
      // YAAM database records the catalog version AND the local manifest
      // version at install/reconcile time.  If both still match, the addon
      // hasn't changed — a negative cmp is just a format mismatch
      // (e.g. manifest "1.05" vs catalog "105"), not a real downgrade.
      if (addon.yaamMeta?.catalogVersion === catalogAddon.version) {
        if (cmp > 0) return false;                 // local definitely newer
        if (cmp === 0) {
          // Inconclusive — fall through to the date-based check below
        } else {
          // cmp < 0: format mismatch (e.g. "1.05" vs "105") or stale DB.
          // The catalog version hasn't changed since our last install/reconcile,
          // so there is definitively NO new update.  Any negative cmp is just a
          // numbering-scheme difference.  Return false unconditionally.
          return false;
        }
      }
      // Catalog version string literally changed since last reconciliation
      // AND version comparison is inconclusive (scheme mismatch → cmp === 0).
      // This is a real update that numeric comparison can't verify.
      if (cmp === 0 && addon.yaamMeta?.catalogVersion && addon.yaamMeta.catalogVersion !== catalogAddon.version) {
        // Still check AddOnVersion as a safety net — it often matches the
        // catalog numbering even when ## Version doesn't.
        if (addon.addonVersion > 0) {
          const cmpAV = compareVersionStrings(String(addon.addonVersion), catalogAddon.version, catalogAddon.date);
          if (cmpAV >= 0) return false;
        }
        return true;
      }
      if (cmp < 0) {
        // Before flagging as update, check AddOnVersion (integer) as fallback.
        // Many addons use different formats for ## Version (e.g. "1.05") vs
        // the ESOUI UIVersion field (e.g. "105").  The ## AddOnVersion integer
        // often matches the catalog version numerically.
        if (addon.addonVersion > 0) {
          const cmpAV = compareVersionStrings(String(addon.addonVersion), catalogAddon.version, catalogAddon.date);
          if (cmpAV >= 0) return false;
        }
        return true;
      }
      // Version comparison inconclusive (scheme mismatch returns 0) —
      // fall back to catalog upload date vs local install/update date.
      // If the catalog was updated after our last install, flag as potential update.
      if (cmp === 0 && catalogAddon.date && addon.yaamMeta?.updatedAt) {
        const localEpoch = Math.floor(new Date(addon.yaamMeta.updatedAt).getTime() / 1000);
        if (catalogAddon.date > localEpoch) return true;
      }
      return false;
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
    // Replacement candidates are shown in the Update All dialog but
    // NOT counted as pending updates — the user must explicitly opt in.
    return count;
  }, [addons, getCatalogAddon, isUpdateAvailable, replacementCandidates]);

  // Count of addons where version comparison is inconclusive (scheme mismatch)
  // but the catalog version string differs from what we recorded at install/reconcile.
  // These are NOT counted in updateCount but still make the Update All button available
  // so the user can review and decide.
  const mightUpdateCount = useMemo(() => {
    const seen = new Set<string>();
    let count = 0;
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (!catalogAddon || seen.has(catalogAddon.id)) continue;
      seen.add(catalogAddon.id);
      if (isUpdateAvailable(addon, catalogAddon)) continue; // already counted
      // Skip addons we just installed in this session
      if (installedCatalogVersions[catalogAddon.id] === catalogAddon.version) continue;
      if (recentlyUpdated.has(catalogAddon.id)) continue;
      // No yaamMeta → never tracked by YAAM → might need an update
      // but only if version comparison is inconclusive
      if (!addon.yaamMeta || !addon.yaamMeta.catalogVersion) {
        const localVer = getEffectiveVersion(addon, catalogAddon);
        // String-equal → definitely same version, skip
        if (localVer.trim() === catalogAddon.version.trim()) continue;
        const cmp = compareVersionStrings(localVer, catalogAddon.version, catalogAddon.date);
        // cmp > 0 → local is newer, no update needed
        // cmp < 0 → isUpdateAvailable should have caught it (or addonVersion confirmed OK)
        // cmp === 0 → truly inconclusive (format mismatch), count as "might update"
        if (cmp === 0) count++;
        continue;
      }
      // Catalog version changed since last install/reconcile → possible update
      if (addon.yaamMeta.catalogVersion !== catalogAddon.version) {
        count++;
        continue;
      }
      // Date-based fallback: catalog uploaded after our last install
      if (catalogAddon.date && addon.yaamMeta.updatedAt) {
        const localEpoch = Math.floor(new Date(addon.yaamMeta.updatedAt).getTime() / 1000);
        if (catalogAddon.date > localEpoch) count++;
      }
    }
    console.log('[YAAM] updateCount', updateCount, 'mightUpdateCount', count,
      'addons', addons.length, 'catalog', addons.filter(a => getCatalogAddon(a)).length);
    return count;
  }, [addons, getCatalogAddon, isUpdateAvailable, getEffectiveVersion, updateCount, installedCatalogVersions, recentlyUpdated]);

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
    // Replacement candidates are NOT marked as updatable in the tree —
    // they only appear in the Update All dialog for explicit opt-in.
    return set;
  }, [addons, getCatalogAddon, isUpdateAvailable, replacementCandidates]);

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
      const preview = await window.electronAPI.previewCleanupLibs(addonPath);
      if (preview.unreferenced.length === 0 && preview.optionalOnly.length === 0) {
        addLog('Cleanup: no unreferenced libraries to remove', 'info');
        return;
      }
      setCleanupDialog({ type: 'libs', items: preview.unreferenced, savedVarItems: preview.optionalOnly });
    } catch (err: unknown) {
      addLog(`Cleanup preview failed: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addLog, libraries, unreferencedLibs, skipCleanupConfirm, scanPath]);

  const handleCleanupLibsConfirm = useCallback(async (selectedItems: string[], selectedOptional?: string[]) => {
    setCleanupDialog(null);
    const all = [...selectedItems, ...(selectedOptional || [])];
    if (!addonPath || all.length === 0) return;
    setLoading(true);
    addLog(`Removing ${all.length} unreferenced libraries...`);
    try {
      const backupPaths: { folder: string; path: string }[] = [];
      for (const folderName of all) {
        const lib = libraries.find(l => l.folderName === folderName);
        if (lib && lib.version) {
          const bp = await window.electronAPI.backupAddonFolder(addonPath, folderName, lib.version);
          if (bp) backupPaths.push({ folder: folderName, path: bp });
        }
      }
      const result = await window.electronAPI.cleanupLibsSelected(addonPath, all);
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
      const match = getCatalogMatch(addon);
      if (match && !seen.has(match.catalogAddon.id)) {
        if (isUpdateAvailable(addon, match.catalogAddon)) {
          seen.add(match.catalogAddon.id);
          updatable.push({
            folderName: addon.folderName,
            title: addon.title,
            localVersion: getEffectiveVersion(addon, match.catalogAddon),
            catalogVersion: match.catalogAddon.version,
            catalogId: match.catalogAddon.id,
            ambiguous: match.ambiguous,
          });
        }
      }
    }

    // Add replacement candidates (different catalog addon targets the same folder)
    for (const [folderName, replacement] of replacementCandidates) {
      if (seen.has(replacement.id)) continue;
      seen.add(replacement.id);
      const addon = addons.find(a => a.folderName === folderName);
      if (!addon) continue;
      updatable.push({
        folderName,
        title: addon.title,
        localVersion: addon.version || '?',
        catalogVersion: replacement.version,
        catalogId: replacement.id,
        replacement: true,
        replacementName: replacement.name,
      });
    }

    // Add "might update" addons: catalog version differs from what we recorded,
    // or addon was never tracked by YAAM, but version comparison is inconclusive.
    for (const addon of addons) {
      const match = getCatalogMatch(addon);
      if (!match || seen.has(match.catalogAddon.id)) continue;
      const ca = match.catalogAddon;
      // Skip session-installed addons
      if (installedCatalogVersions[ca.id] === ca.version) continue;
      if (recentlyUpdated.has(ca.id)) continue;
      let dominated = false;
      let mightUpdateReason: 'not-tracked' | 'version-changed' | 'date-newer' | undefined;
      if (!addon.yaamMeta || !addon.yaamMeta.catalogVersion) {
        // Never tracked or reconciliation-created → check version comparison
        const localVer = getEffectiveVersion(addon, ca);
        // String-equal → definitely same version, not inconclusive
        const cmp = localVer.trim() === ca.version.trim() ? 1 : compareVersionStrings(localVer, ca.version, ca.date);
        // Only include if comparison is truly inconclusive (format mismatch)
        if (cmp === 0) { dominated = true; mightUpdateReason = 'not-tracked'; }
      } else if (addon.yaamMeta.catalogVersion !== ca.version) {
        // Catalog version changed since last install/reconcile
        dominated = true; mightUpdateReason = 'version-changed';
      } else if (ca.date && addon.yaamMeta.updatedAt) {
        const localEpoch = Math.floor(new Date(addon.yaamMeta.updatedAt).getTime() / 1000);
        if (ca.date > localEpoch) { dominated = true; mightUpdateReason = 'date-newer'; }
      }
      if (dominated) {
        seen.add(ca.id);
        updatable.push({
          folderName: addon.folderName,
          title: addon.title,
          localVersion: getEffectiveVersion(addon, ca),
          catalogVersion: ca.version,
          catalogId: ca.id,
          ambiguous: match.ambiguous,
          mightUpdate: true,
          mightUpdateReason,
        });
      }
    }

    if (updatable.length === 0) {
      addLog('Update All: nothing to update — all addons are up-to-date', 'info');
      return;
    }

    // Show selection dialog
    setUpdateAllList(updatable);
  }, [addons, addonPath, getCatalogMatch, addLog, updatingAll, isUpdateAvailable, getEffectiveVersion, replacementCandidates, installedCatalogVersions, recentlyUpdated]);

  const handleUpdateAllConfirm = useCallback(async (selectedCatalogIds: string[]) => {
    setUpdateAllList(null);
    if (!addonPath || selectedCatalogIds.length === 0) return;

    const selectedSet = new Set(selectedCatalogIds);
    const updatable: { addon: AddonInfo; catalogAddon: CatalogAddon; isReplacement?: boolean }[] = [];
    const seen = new Set<string>();

    // Build folderName → addon map for fast lookup
    const addonByFolder = new Map<string, AddonInfo>();
    for (const a of addons) addonByFolder.set(a.folderName, a);

    // Collect replacement catalog IDs so we can flag them
    const replacementIds = new Set<string>();
    for (const [, replacement] of replacementCandidates) replacementIds.add(replacement.id);

    // Resolve each selected catalog ID directly (avoids fragile reverse-lookup)
    for (const id of selectedCatalogIds) {
      if (seen.has(id)) continue;
      const catalogAddon = catalogById.get(id);
      if (!catalogAddon) continue;
      // Find the local addon: check catalog directories, then fall back to getCatalogAddon
      let addon: AddonInfo | undefined;
      for (const dir of catalogAddon.directories) {
        addon = addonByFolder.get(dir);
        if (addon) break;
      }
      if (!addon) {
        addon = addons.find(a => getCatalogAddon(a)?.id === id);
      }
      if (addon) {
        seen.add(id);
        updatable.push({ addon, catalogAddon, isReplacement: replacementIds.has(id) });
      }
    }

    if (updatable.length === 0) {
      addLog(`Update All: selected ${selectedCatalogIds.length} addon(s) but none matched local addons`, 'warn');
      return;
    }

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
          batch.map(async ({ addon, catalogAddon, isReplacement }) => {
            if (updateCancelRef.current) throw new Error('cancelled');
            // Backup current version before updating
            if (addon.version) {
              await window.electronAPI.backupAddonFolder(addonPath, addon.folderName, addon.version);
            }
            // For replacements: delete old folder so stale files don't linger
            if (isReplacement) {
              addLog(`Replacing "${addon.folderName}" with "${catalogAddon.name}"...`);
              await window.electronAPI.deleteAddon(addonPath, addon.folderName);
            } else {
              addLog(`Updating "${addon.folderName}" ${addon.version} → ${catalogAddon.version}...`);
            }
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
  }, [addons, addonPath, catalogById, getCatalogAddon, addLog, scanPath, replacementCandidates]);

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
        mightUpdateCount={mightUpdateCount}
        replacementCount={replacementCandidates.size}
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
        <TreePanel title="AddOns" count={filteredAddons.length} scrollRef={addonsScrollRef} flex={panelWidths[0]} onKeyDown={handleAddonsKeyDown} searchQuery={addonSearchQuery} onSearchChange={setAddonSearchQuery} characters={characterNames} characterFilter={addonCharFilter} onCharacterFilterChange={setAddonCharFilter} hasPendingChanges={pendingCharSettings.size > 0} onSave={handleSaveCharSettings} onCollapseAll={() => setAddonCollapseAll(c => c + 1)}>
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
                  catalogByDir={catalogLookup}
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
                  collapseAllCounter={addonCollapseAll}
                  hasUpdate={(() => { const ca = getCatalogAddon(addon); return !!ca && isUpdateAvailable(addon, ca); })()}
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
        <TreePanel title="Libraries" count={filteredLibraries.length} scrollRef={libsScrollRef} flex={panelWidths[1]} onKeyDown={handleLibsKeyDown} searchQuery={libSearchQuery} onSearchChange={setLibSearchQuery} characters={characterNames} characterFilter={libCharFilter} onCharacterFilterChange={setLibCharFilter} hasPendingChanges={pendingCharSettings.size > 0} onSave={handleSaveCharSettings} onCollapseAll={() => setLibCollapseAll(c => c + 1)}>
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
                  catalogByDir={catalogLookup}
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
                  collapseAllCounter={libCollapseAll}
                  hasUpdate={(() => { const ca = getCatalogAddon(lib); return !!ca && isUpdateAvailable(lib, ca); })()}
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
          catalogByDir={catalogLookup}
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
          addons={addons.map((a) => ({ folderName: a.folderName, version: a.version, isLibrary: a.isLibrary, dependsOn: a.dependsOn.map((d) => d.name), runtimeFiles: a.runtimeFiles }))}
          catalogByDir={catalogLookup}
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
            if (cleanupDialog.type === 'libs') handleCleanupLibsConfirm(items, svItems);
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
