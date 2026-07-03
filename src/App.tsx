// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AddonInfo, AddonSettingsData, CatalogAddon, SavedVarsInfo, compareVersionStrings, versionsDigitEqual, dateToVersion } from '../electron/shared/types';
import { classifyDirOwnership, findHijackedManifestOverlay } from '../electron/shared/overlays';
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
import HygieneDialog, { HygieneStray, HygieneDup } from './components/HygieneDialog';
import './styles/App.css';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Slack for the stateless mtime update hint.  The manifest's mtime approximates
 * the install time, but Finder extraction preserves ZIP-internal times which
 * predate the catalog publish by up to the author's pack-to-upload delay —
 * only a catalog date clearly AFTER the manifest mtime counts as a hint.
 */
const MTIME_UPDATE_SLACK_SECONDS = 48 * 3600;

/** Entry sent to the main process by the baseline commit (mirrors BaselineEntry). */
type BaselineEntryUI = {
  folderName: string;
  esouid: string;
  url: string;
  name: string;
  author: string;
  catalogVersion: string;
  catalogDate?: number;
  localVersion: string;
  overlays?: { esouid: string; catalogName: string; catalogVersion: string; catalogDate?: number }[];
};

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
  /** Catalog IDs that changed since last session (Tier 0 update detection) */
  const [catalogChangedIds, setCatalogChangedIds] = useState<Set<string>>(new Set());
  const [logHeight, setLogHeight] = useState(240);
  const [installingAddon, setInstallingAddon] = useState<string | null>(null);
  const [panelWidths, setPanelWidths] = useState<number[]>([1, 1, 1]);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [updateRemaining, setUpdateRemaining] = useState(0);
  const [catalogHighlightId, setCatalogHighlightId] = useState<string | null>(null);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const [installProgress, setInstallProgress] = useState<Record<string, { phase: string; percent?: number; current?: number; total?: number }>>({});
  const [welcomeAccepted, setWelcomeAccepted] = useState<boolean | null>(null); // null = loading
  // Pending character setting changes: { "character\0addonName": enabled }
  const [pendingCharSettings, setPendingCharSettings] = useState<Map<string, boolean>>(new Map());
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [restoreSnapshots, setRestoreSnapshots] = useState<{ timestamp: string; addons: { folderName: string; version: string }[] }[]>([]);
  const [restoreBackups, setRestoreBackups] = useState<{ folderName: string; version: string; backupPath: string; mtimeMs: number }[]>([]);
  const [restoreSvBackups, setRestoreSvBackups] = useState<{ fileName: string; backupDirName: string; backupFilePath: string; type: 'backup' | 'cleanup'; timestamp: string }[]>([]);
  const [restoreRemoved, setRestoreRemoved] = useState<{ name: string; relPath: string; fromHygiene: boolean; isDirectory: boolean; sizeBytes: number; mtimeMs: number }[]>([]);
  const [updateTotal, setUpdateTotal] = useState(0);
  const updateCancelRef = useRef(false);
  const [showImportExport, setShowImportExport] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fontScale, setFontScale] = useState(120);
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
  const [baselineConfirm, setBaselineConfirm] = useState<{
    entries: BaselineEntryUI[];
    alreadyTracked: number;
    skippedUpdate: number;
    skippedAmbiguous: number;
  } | null>(null);
  const [hygienePreview, setHygienePreview] = useState<{
    strayManifests: HygieneStray[];
    duplicates: HygieneDup[];
    unclaimedRootFiles: string[];
  } | null>(null);

  // Theme state: persisted in localStorage
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('yaam-theme') as 'dark' | 'light') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('yaam-theme', theme);
  }, [theme]);

  // Apply font settings to root
  useEffect(() => {
    document.documentElement.style.fontSize = `${14 * fontScale / 100}px`;
    document.body.style.fontFamily = fontFamily;
  }, [fontScale, fontFamily]);

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
      if (config.fontScale) setFontScale(config.fontScale);
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

      // Update catalog snapshot and compute diff (detects catalog-side changes)
      if (onlineList.length > 0 && pathToScan) {
        window.electronAPI.updateCatalogSnapshot(pathToScan).then(diff => {
          if (diff) {
            // Store changed IDs for Tier 0 update detection
            const changedIds = new Set(diff.changed.map(([id]) => id));
            setCatalogChangedIds(prev => {
              // Merge with existing diff (accumulate across rescans within a session)
              const merged = new Set(prev);
              for (const id of changedIds) merged.add(id);
              return merged;
            });
            if (diff.changed.length > 0) {
              addLog(`Catalog changes since last session: ${diff.changed.length} updated, ${diff.added.length} new`, 'info');
            }
          }
        }).catch(() => {});
      }

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

        const matches: { folderName: string; esouid: string; name: string; author: string; version: string; url: string; catalogDate: number; localVersion: string; confident: boolean }[] = [];
        for (const addon of results) {
          // Priority: DB entry > catalogId > URL > directory
          let byMeta = addon.yaamMeta?.esouid ? catById.get(addon.yaamMeta.esouid) : undefined;
          const byId = addon.catalogId ? catById.get(addon.catalogId) : undefined;
          const byUrl = addon.downloadUrl ? catByUrl.get(addon.downloadUrl.toLowerCase()) : undefined;
          const byDir = catByDir.get(addon.folderName);
          // Same poisoned-entry validation as getCatalogMatch: a DB entry that
          // does not own this folder loses against the folder's primary owner,
          // so reconciliation rewrites the DB with the correct esouid (self-heal).
          if (byMeta && !byMeta.directories.includes(addon.folderName)
            && byDir && byDir.id !== byMeta.id && byDir.directories[0] === addon.folderName) {
            byMeta = undefined;
          }

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
            catalogDate: best.date,
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
                // Only re-inject if localVersion or the healed identity changed.
                if (a.yaamMeta.localVersion === m.localVersion && a.yaamMeta.esouid === m.esouid) return a;
                const healed = a.yaamMeta.esouid !== m.esouid;
                return {
                  ...a,
                  yaamMeta: {
                    ...a.yaamMeta,
                    localVersion: m.localVersion,
                    esouid: m.esouid,
                    // Healed identity: the old anchors described the wrong
                    // catalog entry — mirror the DB reset done by reconcile.
                    ...(healed ? {
                      url: m.url,
                      catalogName: m.name,
                      catalogAuthor: m.author,
                      catalogVersion: '',
                      catalogDate: undefined,
                    } : {}),
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

  // Per-directory ownership: which catalog entry is the folder's ORIGINAL and
  // which entries are overlays (language patches / fix packs) writing into it.
  const dirOwnership = useMemo(() => classifyDirOwnership(catalogAddons), [catalogAddons]);

  // Overlay catalog entries → name of the original they patch (ESOUI tree badge)
  const overlayTargetNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const [dir, o] of dirOwnership) {
      for (const ov of o.overlays) {
        if (!m.has(ov.id)) m.set(ov.id, o.original?.name ?? dir);
      }
    }
    return m;
  }, [dirOwnership]);

  /** Look up the catalog entry for an installed addon.
   *  Priority:  0. YAAM database entry  1. UID  2. URL  3. Title  4. Directory name
   *  Returns { catalogAddon, ambiguous, installedOverlays, layered }:
   *  catalogAddon is always the folder's MAIN identity (the original — never a
   *  language patch), installedOverlays lists patches detected in the folder,
   *  and layered=true means the manifest was hijacked by an untracked patch so
   *  the original's on-disk version is unknown. */
  const getCatalogMatch = useCallback(
    (addon: AddonInfo): {
      catalogAddon: CatalogAddon;
      ambiguous: boolean;
      installedOverlays: { catalogAddon: CatalogAddon; trackedVersion?: string; trackedDate?: number; needsReapply?: boolean; evidence: 'db' | 'manifest' }[];
      layered: boolean;
    } | undefined => {
      // 0. YAAM database entry (written by YAAM on install — most reliable).
      //    BUT: validate it.  Old DB entries can be poisoned (e.g. WritWorthy
      //    recorded as LibAddonMenu because its manifest lists dependency URLs).
      //    Distrust the entry when the recorded catalog addon does NOT own this
      //    folder while a different catalog entry claims the folder as its
      //    PRIMARY directory — then fall through to the other match methods,
      //    which lets the next reconciliation heal the database.
      let byMeta = addon.yaamMeta?.esouid ? catalogById.get(addon.yaamMeta.esouid) : undefined;
      if (byMeta && !byMeta.directories.includes(addon.folderName)) {
        const dirOwner = catalogByDir.get(addon.folderName);
        if (dirOwner && dirOwner.id !== byMeta.id && dirOwner.directories[0] === addon.folderName) {
          console.warn(`[YAAM] Distrusting DB match for ${addon.folderName}: DB says #${byMeta.id} "${byMeta.name}" (dirs: ${byMeta.directories.join(', ')}), but #${dirOwner.id} "${dirOwner.name}" owns the folder`);
          byMeta = undefined;
        }
      }
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
      let ambiguous = !allAgree
        || (!matchedByMeta && !matchedById && !matchedByUrl && byName && catalogNameConflicts.has(best.name))
        || (!matchedByMeta && !matchedById && !matchedByUrl && !byName && byDir && catalogDirConflicts.has(addon.folderName));

      // ── Overlay resolution (the LangPatch problem) ──
      // Language patches write INTO another addon's folder and usually replace
      // its manifest, hijacking title/version.  The folder's main identity must
      // stay the ORIGINAL; detected patches are reported as installed overlays.
      let main = best;
      let layered = false;
      const installedOverlays: { catalogAddon: CatalogAddon; trackedVersion?: string; trackedDate?: number; needsReapply?: boolean; evidence: 'db' | 'manifest' }[] = [];
      const ownership = dirOwnership.get(addon.folderName);
      if (ownership) {
        // Overlays tracked in the YAAM database are installed by definition
        for (const ov of addon.yaamMeta?.overlays ?? []) {
          const ca = catalogById.get(ov.esouid);
          if (ca) {
            installedOverlays.push({ catalogAddon: ca, trackedVersion: ov.catalogVersion, trackedDate: ov.catalogDate, needsReapply: ov.needsReapply, evidence: 'db' });
          }
        }
        const overlayIds = new Set(ownership.overlays.map((o) => o.id));
        if (overlayIds.has(main.id) && ownership.original) {
          // The best match IS a patch (hijacked manifest, dependency URL or a
          // legacy DB entry pointing at the patch) → redirect to the original.
          if (!installedOverlays.some((o) => o.catalogAddon.id === main.id)) {
            installedOverlays.push({ catalogAddon: main, evidence: 'manifest' });
            layered = true; // manifest identity belongs to the patch, original untracked
          }
          main = ownership.original;
          // The dir conflict is explained by the overlay split — not ambiguous.
          if (allAgree) ambiguous = false;
        } else if (ownership.original && main.id === ownership.original.id) {
          // Main match is already the original — the manifest title may still
          // reveal a hijacking patch that was installed outside YAAM.
          const hijacked = findHijackedManifestOverlay(addon.title, ownership.overlays);
          if (hijacked && !installedOverlays.some((o) => o.catalogAddon.id === hijacked.id)) {
            installedOverlays.push({ catalogAddon: hijacked, evidence: 'manifest' });
            layered = true;
          }
        }
      }

      return { catalogAddon: main, ambiguous: !!ambiguous, installedOverlays, layered };
    },
    [catalogById, catalogByUrl, catalogByName, catalogByDir, catalogNameConflicts, catalogDirConflicts, dirOwnership]
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
        // Overlays (language patches / fix packs) are NOT replacements: they
        // layer INTO the folder with an independent version history — a patch
        // version being "higher" than the original's says nothing.  They are
        // handled by the overlay flow (install/update as overlay) instead.
        if (overlayTargetNames.has(ca.id)) continue;
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
  }, [addons, catalogAddons, getCatalogAddon, overlayTargetNames]);

  // Set of all known addon names (folder names + titles) for dependency checking
  const knownAddonNames = useMemo(() => new Set(addonMap.keys()), [addonMap]);

  // Installed AddOnVersion by folder name — lets the dependency check enforce
  // "Name>=NN" minimums (an installed-but-too-old library counts as unmet, just
  // like the game treats it).
  const installedVersions = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of addons) {
      map.set(a.folderName, a.addonVersion);
      for (const sub of a.subAddons) map.set(sub.folderName, sub.addonVersion);
    }
    return map;
  }, [addons]);

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
   *
   * 4-tier hierarchy:
   *   0. Catalog diff: catalog entry changed since last session → update
   *   1. Session guard: recently installed in this session → skip
   *   2. YAAM-tracked (catalogVersion non-empty): simple string !== → update
   *   3. Unknown addon (no/empty catalogVersion): compareVersionStrings best-effort
   */
  const isUpdateAvailable = useCallback(
    (addon: AddonInfo, catalogAddon: CatalogAddon): boolean => {
      // ── Tier 1: Session guard ──
      // Skip addons installed/updated in this session (not rescanned yet)
      if (recentlyUpdated.has(catalogAddon.id)) return false;

      // ── Layered guard (LangPatch hijacked the manifest) ──
      // The local manifest version belongs to the PATCH, not the original —
      // any comparison against the original's catalog version is meaningless.
      // Without a deterministic Tier-2 anchor these folders are reported in
      // the dedicated "layered" section of the Update-All dialog instead.
      if (!addon.yaamMeta?.catalogVersion && getCatalogMatch(addon)?.layered) {
        return false;
      }

      // ── Tier 0: Catalog diff (most reliable) ──
      // If the catalog entry changed since last session AND the local addon
      // doesn't already match the new catalog version → definitely an update.
      if (catalogChangedIds.has(catalogAddon.id)) {
        const trackedVersion = addon.yaamMeta?.catalogVersion;
        // If YAAM-tracked and catalogVersion already matches new catalog → no update
        if (trackedVersion && trackedVersion === catalogAddon.version) {
          const trackedDate = addon.yaamMeta?.catalogDate;
          if (!trackedDate || !catalogAddon.date || trackedDate === catalogAddon.date) {
            return false; // version + date match → already on latest
          }
        }
        // Cross-check: local manifest version matches catalog → updated externally
        const localVer = getEffectiveVersion(addon, catalogAddon);
        if (localVer.trim() === catalogAddon.version.trim() || versionsDigitEqual(localVer, catalogAddon.version)) {
          // Only skip if the addon has some tracking (avoid false negatives for untracked)
          if (trackedVersion || addon.yaamMeta?.esouid) {
            console.log(`[YAAM] Tier 0 skip (local matches new catalog): ${addon.folderName} localVer="${localVer}" catalogVersion="${catalogAddon.version}"`);
            return false;
          }
        }
        console.log(`[YAAM] Tier 0 update (catalog changed): ${addon.folderName} catalogVersion="${catalogAddon.version}" tracked="${trackedVersion || ''}" local="${localVer}"`);
        return true;
      }

      // ── Tier 2: YAAM-tracked addon (deterministic string comparison) ──
      // catalogVersion is set when YAAM installs/updates an addon.
      // BUT the marker is only trustworthy while the files on disk are still
      // the ones YAAM extracted.  localVersion is the anchor for that: it holds
      // the manifest version scanned right after extraction.
      //   manifest == localVersion → files unchanged since install → the marker
      //     decides (authors often never bump the manifest header, e.g. a
      //     "## Version: 1.0" inside the 1.0.8 release — that is NOT an update).
      //   manifest != localVersion → folder was modified outside YAAM (Minion,
      //     manual copy, partial restore) → distrust the marker, fall through
      //     to Tier 3 with the real manifest version.
      const trackedVersion = addon.yaamMeta?.catalogVersion;
      const anchor = addon.yaamMeta?.localVersion;
      const filesUnchanged = !anchor || addon.version === anchor;
      if (trackedVersion && filesUnchanged) {
        if (trackedVersion !== catalogAddon.version && !versionsDigitEqual(trackedVersion, catalogAddon.version)) {
          console.log(`[YAAM] Tier 2 update (version): ${addon.folderName} trackedVersion="${trackedVersion}" catalogVersion="${catalogAddon.version}"`);
          return true;
        }
        // Same version string — check if the catalog date changed (re-publish)
        const trackedDate = addon.yaamMeta?.catalogDate;
        if (trackedDate && catalogAddon.date && trackedDate !== catalogAddon.date) {
          console.log(`[YAAM] Tier 2 update (re-publish): ${addon.folderName} trackedDate=${trackedDate} catalogDate=${catalogAddon.date}`);
          return true;
        }
        return false;
      }
      if (trackedVersion && !filesUnchanged) {
        console.log(`[YAAM] Tier 2 → 3 (externally modified): ${addon.folderName} manifest="${addon.version}" anchor="${anchor}"`);
      }

      // ── Tier 3: Unknown addon (never installed/updated via YAAM),
      //    or tracked addon whose files were modified outside YAAM ──
      // Best-effort comparison using local manifest version vs catalog version.
      const localVer = getEffectiveVersion(addon, catalogAddon);
      // Identical version (also across formatting schemes) → no update
      if (localVer.trim() === catalogAddon.version.trim()) return false;
      if (versionsDigitEqual(localVer, catalogAddon.version)) return false;
      const cmp = compareVersionStrings(localVer, catalogAddon.version, catalogAddon.date);
      if (cmp < 0) {
        // Local appears older — double-check with AddOnVersion integer.
        if (addon.addonVersion > 0 && versionsDigitEqual(String(addon.addonVersion), catalogAddon.version)) return false;
        console.log(`[YAAM] Tier 3 update: ${addon.folderName} localVer="${localVer}" catalogVersion="${catalogAddon.version}" cmp=${cmp}`);
        return true;
      }
      if (cmp > 0) return false; // local is newer
      // cmp === 0: inconclusive (scheme mismatch) — fall back to catalog date
      if (catalogAddon.date && addon.yaamMeta?.updatedAt) {
        const localEpoch = Math.floor(new Date(addon.yaamMeta.updatedAt).getTime() / 1000);
        if (catalogAddon.date > localEpoch) {
          console.log(`[YAAM] Tier 3 update (date fallback): ${addon.folderName} localVer="${localVer}" catalogVersion="${catalogAddon.version}" cmp=${cmp} catalogDate=${catalogAddon.date} localEpoch=${localEpoch}`);
          return true;
        }
      }
      return false;
    },
    [recentlyUpdated, catalogChangedIds, getEffectiveVersion, getCatalogMatch]
  );

  // Count of addons that have a newer version in the catalog (for Update All button)
  const updateCount = useMemo(() => {
    const seen = new Set<string>();
    let count = 0;
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (catalogAddon && !seen.has(catalogAddon.id)) {
        if (isUpdateAvailable(addon, catalogAddon)) {
          seen.add(catalogAddon.id);
          count++;
        }
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
      const match = getCatalogMatch(addon);
      if (!match || seen.has(match.catalogAddon.id)) continue;
      const catalogAddon = match.catalogAddon;
      if (isUpdateAvailable(addon, catalogAddon)) {
        seen.add(catalogAddon.id); // already counted in updateCount
        continue;
      }
      if (recentlyUpdated.has(catalogAddon.id)) continue;
      // Layered folders have their own dialog section — not "might update"
      if (match.layered) continue;
      // Only untracked addons (no/empty catalogVersion) can be "might update"
      if (addon.yaamMeta?.catalogVersion) continue;
      const localVer = getEffectiveVersion(addon, catalogAddon);
      if (localVer.trim() === catalogAddon.version.trim()) continue;
      if (versionsDigitEqual(localVer, catalogAddon.version)) continue;
      const cmp = compareVersionStrings(localVer, catalogAddon.version, catalogAddon.date);
      // cmp === 0 means inconclusive (scheme mismatch) — count as "might update"
      if (cmp === 0) {
        seen.add(catalogAddon.id);
        count++;
      } else if (cmp > 0 && addon.manifestMtime
        && catalogAddon.date > addon.manifestMtime + MTIME_UPDATE_SLACK_SECONDS) {
        // Stateless mtime hint: version strings say "local is newer", but the
        // catalog published well AFTER the manifest landed on disk — the
        // "newer" verdict is likely a scheme artifact (e.g. "2.3.22 build
        // 1442" vs "2.3.22").  Surface it for review.
        seen.add(catalogAddon.id);
        count++;
      }
    }
    console.log('[YAAM] updateCount', updateCount, 'mightUpdateCount', count,
      'addons', addons.length, 'catalog', addons.filter(a => getCatalogAddon(a)).length);
    return count;
  }, [addons, getCatalogAddon, getCatalogMatch, isUpdateAvailable, getEffectiveVersion, updateCount, recentlyUpdated]);

  // ── Baseline commit ──
  // Candidates: addons with an unambiguous catalog match, no pending update,
  // and no deterministic Tier-2 anchor yet.  Committing writes the CURRENT
  // catalog version/date as install-time anchor (DB + marker), so every future
  // catalog change becomes a reliably detected update — the honest way out of
  // heuristic version comparison for chaotic version schemes.
  const baselineCandidates = useMemo(() => {
    const entries: BaselineEntryUI[] = [];
    let alreadyTracked = 0;
    let skippedUpdate = 0;
    let skippedAmbiguous = 0;
    for (const addon of addons) {
      const match = getCatalogMatch(addon);
      if (!match) continue;
      const ca = match.catalogAddon;
      if (match.ambiguous) { skippedAmbiguous++; continue; }
      if (isUpdateAvailable(addon, ca)) { skippedUpdate++; continue; }
      // Detected-but-untracked overlays get anchored alongside the original —
      // afterwards patch updates are detected deterministically too.
      const untrackedOverlays = match.installedOverlays
        .filter((o) => o.evidence === 'manifest')
        .map((o) => ({
          esouid: o.catalogAddon.id,
          catalogName: o.catalogAddon.name,
          catalogVersion: o.catalogAddon.version,
          catalogDate: o.catalogAddon.date || undefined,
        }));
      // Already deterministically tracked at the current catalog version+date
      const meta = addon.yaamMeta;
      if (meta?.catalogVersion === ca.version && (!ca.date || meta?.catalogDate === ca.date)
        && meta?.localVersion === addon.version && untrackedOverlays.length === 0) {
        alreadyTracked++;
        continue;
      }
      entries.push({
        folderName: addon.folderName,
        esouid: ca.id,
        url: ca.infoUrl,
        name: ca.name,
        author: ca.author,
        catalogVersion: ca.version,
        catalogDate: ca.date || undefined,
        localVersion: addon.version,
        overlays: untrackedOverlays.length > 0 ? untrackedOverlays : undefined,
      });
    }
    return { entries, alreadyTracked, skippedUpdate, skippedAmbiguous };
  }, [addons, getCatalogMatch, isUpdateAvailable]);

  // ── Overlay updates (language patches / fix packs) ──
  // Each installed overlay has its own catalog identity and version history,
  // independent of the folder's main addon.  needsReapply overlays (overwritten
  // by a main-addon update) always count as actionable.
  const overlayUpdates = useMemo(() => {
    const items: { folderName: string; addonTitle: string; overlay: CatalogAddon; installedVersion: string; needsReapply: boolean; evidence: 'db' | 'manifest' }[] = [];
    const seen = new Set<string>();
    for (const addon of addons) {
      const match = getCatalogMatch(addon);
      if (!match || match.installedOverlays.length === 0) continue;
      for (const ov of match.installedOverlays) {
        if (seen.has(ov.catalogAddon.id) || recentlyUpdated.has(ov.catalogAddon.id)) continue;
        const installedVersion = ov.trackedVersion ?? addon.version;
        let hasUpdate = false;
        if (ov.needsReapply) {
          hasUpdate = true;
        } else if (ov.evidence === 'db') {
          hasUpdate = (!!ov.trackedVersion
            && ov.trackedVersion !== ov.catalogAddon.version
            && !versionsDigitEqual(ov.trackedVersion, ov.catalogAddon.version))
            || (!!ov.trackedDate && !!ov.catalogAddon.date && ov.trackedDate !== ov.catalogAddon.date);
        } else {
          // Manifest evidence: the local manifest version IS the patch version
          const lv = addon.version;
          if (lv && lv.trim() !== ov.catalogAddon.version.trim() && !versionsDigitEqual(lv, ov.catalogAddon.version)) {
            hasUpdate = compareVersionStrings(lv, ov.catalogAddon.version, ov.catalogAddon.date) <= 0;
          }
        }
        if (hasUpdate) {
          seen.add(ov.catalogAddon.id);
          items.push({ folderName: addon.folderName, addonTitle: addon.title, overlay: ov.catalogAddon, installedVersion, needsReapply: !!ov.needsReapply, evidence: ov.evidence });
        }
      }
    }
    return items;
  }, [addons, getCatalogMatch, recentlyUpdated]);

  // Folders whose manifest is hijacked by an untracked patch: the original's
  // on-disk state is unknown.  Offered as explicit reinstall in the dialog.
  const layeredItems = useMemo(() => {
    const items: { folderName: string; title: string; original: CatalogAddon; patchName: string }[] = [];
    for (const addon of addons) {
      const match = getCatalogMatch(addon);
      if (!match?.layered) continue;
      const patch = match.installedOverlays.find((o) => o.evidence === 'manifest');
      items.push({
        folderName: addon.folderName,
        title: addon.title,
        original: match.catalogAddon,
        patchName: patch?.catalogAddon.name ?? 'unknown patch',
      });
    }
    return items;
  }, [addons, getCatalogMatch]);

  const handleCommitBaselineClick = useCallback(() => {
    if (!addonPath || baselineCandidates.entries.length === 0) return;
    setBaselineConfirm(baselineCandidates);
  }, [addonPath, baselineCandidates]);

  const handleCommitBaselineConfirm = useCallback(async () => {
    if (!addonPath || !baselineConfirm) return;
    const { entries } = baselineConfirm;
    setBaselineConfirm(null);
    setLoading(true);
    try {
      const res = await window.electronAPI.commitBaseline(addonPath, entries);
      for (const d of res.details) addLog(`  ${d}`, 'info');
      const undoAction = res.trackingBackupDir ? {
        label: '↩ Undo',
        onClick: async () => {
          try {
            const undo = await window.electronAPI.restoreTrackingState(addonPath, res.trackingBackupDir);
            if (undo.restored) {
              addLog(`Baseline undone: tracking state restored (${undo.markers} marker(s))`, 'success');
              scanPath(addonPath);
            } else {
              addLog(`Baseline undo failed: ${undo.error ?? 'unknown error'}`, 'error');
            }
          } catch (e: unknown) { addLog(`Baseline undo failed: ${errMsg(e)}`, 'error'); }
        },
      } : undefined;
      setLogs((prev) => [...prev, { timestamp: new Date(), message: `Baseline committed: ${res.anchored} addon(s) anchored as up-to-date (deterministic tracking active)`, level: 'success' as const, action: undoAction }]);
      await scanPath(addonPath);
    } catch (err: unknown) {
      addLog(`Baseline commit failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, baselineConfirm, addLog, scanPath]);

  // ── Folder hygiene ──
  const handleFolderHygiene = useCallback(async () => {
    if (!addonPath) return;
    setLoading(true);
    try {
      const preview = await window.electronAPI.previewFolderHygiene(addonPath);
      const total = preview.strayManifests.length + preview.duplicates.length + preview.unclaimedRootFiles.length;
      if (total === 0) {
        addLog('Folder hygiene: no problems found — the AddOns folder is clean', 'success');
        return;
      }
      setHygienePreview(preview);
    } catch (err: unknown) {
      addLog(`Folder hygiene scan failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addLog]);

  const handleHygieneConfirm = useCallback(async (actions: { repairs: string[]; removals: string[] }) => {
    setHygienePreview(null);
    if (!addonPath) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.applyFolderHygiene(addonPath, actions);
      for (const e of res.errors) addLog(`Hygiene: ${e}`, 'warn');
      const totalChanged = res.repaired.length + res.removed.length;
      if (totalChanged > 0) {
        const parts: string[] = [];
        if (res.repaired.length > 0) parts.push(`repaired ${res.repaired.length} broken install(s): ${res.repaired.join(', ')}`);
        if (res.removed.length > 0) parts.push(`moved ${res.removed.length} item(s) to Removed/_hygiene/`);
        const undoInfo = res.undo;
        setLogs((prev) => [...prev, {
          timestamp: new Date(),
          message: `Folder hygiene: ${parts.join('; ')} (nothing deleted)`,
          level: 'success' as const,
          action: {
            label: '↩ Undo',
            onClick: async () => {
              try {
                const undo = await window.electronAPI.undoFolderHygiene(addonPath, undoInfo);
                for (const e of undo.errors) addLog(`Hygiene undo: ${e}`, 'warn');
                addLog(`Hygiene undone: ${undo.restored} item(s) moved back`, undo.restored > 0 ? 'success' : 'warn');
                if (undo.restored > 0) scanPath(addonPath);
              } catch (e: unknown) { addLog(`Hygiene undo failed: ${errMsg(e)}`, 'error'); }
            },
          },
        }]);
      }
      await scanPath(addonPath);
    } catch (err: unknown) {
      addLog(`Folder hygiene failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addLog, scanPath]);

  // Set of folder names that have an update available (used for sorting to top)
  // Authoritative set of catalog addon IDs that have an update available.
  // Shared with OnlineBrowser so every surface uses the same matching logic.
  const updatableCatalogIds = useMemo(() => {
    const ids = new Set<string>();
    const details: string[] = [];
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (catalogAddon && !ids.has(catalogAddon.id)) {
        if (isUpdateAvailable(addon, catalogAddon)) {
          ids.add(catalogAddon.id);
          details.push(`${addon.folderName} → #${catalogAddon.id} "${catalogAddon.name}" v${catalogAddon.version} (local="${addon.version}" tracked="${addon.yaamMeta?.catalogVersion ?? ''}" trackedDate=${addon.yaamMeta?.catalogDate ?? 'none'})`);
        }
      }
    }
    if (details.length > 0) {
      console.log(`[YAAM] updatableCatalogIds (${ids.size}):`, details);
    }
    return ids;
  }, [addons, getCatalogAddon, isUpdateAvailable]);

  const updatableFolders = useMemo(() => {
    const set = new Set<string>();
    for (const addon of addons) {
      const catalogAddon = getCatalogAddon(addon);
      if (catalogAddon && updatableCatalogIds.has(catalogAddon.id)) {
        // Mark all directories belonging to this catalog addon as updatable
        for (const dir of catalogAddon.directories) set.add(dir);
        // Also mark the addon's own folder (title-matched addons may not be in directories)
        set.add(addon.folderName);
      }
    }
    // Replacement candidates are NOT marked as updatable in the tree —
    // they only appear in the Update All dialog for explicit opt-in.
    return set;
  }, [addons, getCatalogAddon, updatableCatalogIds, replacementCandidates]);

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
        // Backup addon before deletion so it appears in Go Back.
        // Versionless manifests get backed up too (as "-unknown").
        const addon = addons.find(a => a.folderName === folderName);
        let backupPath = '';
        if (addon) {
          backupPath = await window.electronAPI.backupAddonFolder(addonPath, folderName, addon.version);
        }
        // Collect SavedVars backups so Undo can restore them alongside the folder
        const svBackups: { dir: string; files: string[] }[] = [];
        if (alsoDeleteSavedVars) {
          // Delete SavedVars for parent + all sub-addon names
          const names = [folderName, ...(addon?.subAddons.map(s => s.folderName) || [])];
          const allDeleted: string[] = [];
          for (const name of names) {
            const svResult = await window.electronAPI.deleteSavedVars(addonPath, name);
            allDeleted.push(...svResult.deleted);
            if (svResult.deleted.length > 0 && svResult.backupDir) {
              svBackups.push({ dir: svResult.backupDir, files: svResult.deleted });
            }
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
              // Restore SavedVars deleted in the same operation
              let svRestored = 0;
              for (const { dir, files } of svBackups) {
                for (const file of files) {
                  const res = await window.electronAPI.restoreSvFile(addonPath, `${dir}/${file}`);
                  if (res.restored) svRestored++;
                }
              }
              if (ok) {
                addLog(`Restored "${folderName}" from backup${svRestored > 0 ? ` + ${svRestored} SavedVariables file(s)` : ''}`, 'success');
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
        // Backup addon (and its exclusive libs) before deletion so they appear
        // in Go Back — versionless manifests included (backed up as "-unknown").
        const addon = addons.find(a => a.folderName === folderName);
        const backupPaths: { folder: string; path: string }[] = [];
        if (addon) {
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
            if (depAddon) {
              const bp = await window.electronAPI.backupAddonFolder(addonPath, depAddon.folderName, depAddon.version);
              if (bp) backupPaths.push({ folder: depAddon.folderName, path: bp });
            }
          }
        }
        // Collect SavedVars backups so Undo can restore them alongside the folders
        const svBackups: { dir: string; files: string[] }[] = [];
        if (alsoDeleteSavedVars) {
          // Delete SavedVars for parent + all sub-addon names
          const names = [folderName, ...(addon?.subAddons.map(s => s.folderName) || [])];
          const allDeleted: string[] = [];
          for (const name of names) {
            const svResult = await window.electronAPI.deleteSavedVars(addonPath, name);
            allDeleted.push(...svResult.deleted);
            if (svResult.deleted.length > 0 && svResult.backupDir) {
              svBackups.push({ dir: svResult.backupDir, files: svResult.deleted });
            }
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
              // Restore SavedVars deleted in the same operation
              let svRestored = 0;
              for (const { dir, files } of svBackups) {
                for (const file of files) {
                  const res = await window.electronAPI.restoreSvFile(addonPath, `${dir}/${file}`);
                  if (res.restored) svRestored++;
                }
              }
              if (restored > 0) {
                addLog(`Restored ${restored} addon(s) from backup${svRestored > 0 ? ` + ${svRestored} SavedVariables file(s)` : ''}`, 'success');
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
          if (unreferencedLibs.has(lib.folderName)) {
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
        if (lib) {
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

    // Add "might update" addons: untracked addons where version comparison
    // is inconclusive (format mismatch).  Layered folders are excluded — their
    // manifest version belongs to a patch and gets a dedicated section below.
    for (const addon of addons) {
      const match = getCatalogMatch(addon);
      if (!match || seen.has(match.catalogAddon.id)) continue;
      if (match.layered) continue;
      const ca = match.catalogAddon;
      if (recentlyUpdated.has(ca.id)) continue;
      // Only untracked addons (no/empty catalogVersion) can be "might update"
      if (addon.yaamMeta?.catalogVersion) continue;
      const localVer = getEffectiveVersion(addon, ca);
      if (localVer.trim() === ca.version.trim() || versionsDigitEqual(localVer, ca.version)) continue;
      const cmp = compareVersionStrings(localVer, ca.version, ca.date);
      if (cmp === 0) {
        seen.add(ca.id);
        updatable.push({
          folderName: addon.folderName,
          title: addon.title,
          localVersion: getEffectiveVersion(addon, ca),
          catalogVersion: ca.version,
          catalogId: ca.id,
          ambiguous: match.ambiguous,
          mightUpdate: true,
          mightUpdateReason: 'not-tracked',
        });
      } else if (cmp > 0 && addon.manifestMtime
        && ca.date > addon.manifestMtime + MTIME_UPDATE_SLACK_SECONDS) {
        // Stateless mtime hint (see mightUpdateCount): "local newer" verdict
        // contradicted by a catalog publish well after the files hit disk.
        seen.add(ca.id);
        updatable.push({
          folderName: addon.folderName,
          title: addon.title,
          localVersion: getEffectiveVersion(addon, ca),
          catalogVersion: ca.version,
          catalogId: ca.id,
          ambiguous: match.ambiguous,
          mightUpdate: true,
          mightUpdateReason: 'date-newer',
        });
      }
    }

    // Overlay updates: language patches / fix packs with their own identity.
    // Installed as overlays (overlayFor) so they never hijack the folder's
    // main identity in the database.
    for (const item of overlayUpdates) {
      if (seen.has(item.overlay.id)) continue;
      seen.add(item.overlay.id);
      updatable.push({
        folderName: item.folderName,
        title: item.overlay.name,
        localVersion: item.installedVersion || '?',
        catalogVersion: item.overlay.version,
        catalogId: item.overlay.id,
        overlay: true,
        overlayOf: item.addonTitle || item.folderName,
        needsReapply: item.needsReapply,
      });
    }

    // Layered folders: an untracked patch hijacked the manifest — the
    // original's on-disk version is unknown.  Reinstalling the original
    // overwrites the patch (which is offered above / in the browser).
    for (const li of layeredItems) {
      if (seen.has(li.original.id)) continue;
      seen.add(li.original.id);
      updatable.push({
        folderName: li.folderName,
        title: li.original.name,
        localVersion: `unknown (patched: ${li.patchName})`,
        catalogVersion: li.original.version,
        catalogId: li.original.id,
        layered: true,
        overlayOf: li.patchName,
      });
    }

    if (updatable.length === 0) {
      addLog('Update All: nothing to update — all addons are up-to-date', 'info');
      return;
    }

    // Show selection dialog
    setUpdateAllList(updatable);
  }, [addons, addonPath, getCatalogMatch, addLog, updatingAll, isUpdateAvailable, getEffectiveVersion, replacementCandidates, recentlyUpdated, overlayUpdates, layeredItems]);

  const handleUpdateAllConfirm = useCallback(async (selectedCatalogIds: string[]) => {
    setUpdateAllList(null);
    if (!addonPath || selectedCatalogIds.length === 0) return;

    type UpdateTask = { addon: AddonInfo; catalogAddon: CatalogAddon; isReplacement?: boolean; overlayFor?: string; isReapply?: boolean };
    const selectedSet = new Set(selectedCatalogIds);
    const updatable: UpdateTask[] = [];
    const seen = new Set<string>();

    // Build folderName → addon map for fast lookup
    const addonByFolder = new Map<string, AddonInfo>();
    for (const a of addons) addonByFolder.set(a.folderName, a);

    // Collect replacement catalog IDs so we can flag them
    const replacementIds = new Set<string>();
    for (const [, replacement] of replacementCandidates) replacementIds.add(replacement.id);

    // Overlay UID → target folder (installs must preserve the main identity)
    const overlayIdToFolder = new Map(overlayUpdates.map(i => [i.overlay.id, i.folderName]));

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
        updatable.push({ addon, catalogAddon, isReplacement: replacementIds.has(id), overlayFor: overlayIdToFolder.get(id) });
      }
    }

    if (updatable.length === 0) {
      addLog(`Update All: selected ${selectedCatalogIds.length} addon(s) but none matched local addons`, 'warn');
      return;
    }

    // ── Phase split ──
    // Main addons install first, overlays afterwards, so a patch always ends
    // up layered ON TOP of the freshly updated original.
    const mainPhase = updatable.filter(t => !t.overlayFor);
    const overlayPhase = updatable.filter(t => t.overlayFor);

    // Auto re-apply: an updated original overwrites its tracked overlays —
    // queue every tracked overlay that isn't already selected for update.
    for (const task of mainPhase) {
      if (task.isReplacement) continue; // replacement = different addon, overlays don't apply
      for (const ov of task.addon.yaamMeta?.overlays ?? []) {
        if (selectedSet.has(ov.esouid) || seen.has(ov.esouid)) continue;
        const ca = catalogById.get(ov.esouid);
        if (!ca) continue;
        seen.add(ov.esouid);
        overlayPhase.push({ addon: task.addon, catalogAddon: ca, overlayFor: task.addon.folderName, isReapply: true });
        addLog(`Queued re-apply of "${ov.catalogName}" on top of ${task.addon.folderName} after its update`);
      }
    }

    const totalTasks = mainPhase.length + overlayPhase.length;
    setUpdatingAll(true);
    setUpdateRemaining(totalTasks);
    setUpdateTotal(totalTasks);
    updateCancelRef.current = false;
    setLoading(true);
    addLog(`Updating ${totalTasks} item(s) from catalog (${mainPhase.length} addon(s), ${overlayPhase.length} overlay(s))...`);

    let success = 0;
    let failed = 0;
    let cancelled = 0;
    let done = 0;
    const newVersions: Record<string, string> = {};
    // Folders whose main addon updated successfully — re-applies run only for those
    const updatedFolders = new Set<string>();
    // All backups taken during this run — powers the "Undo all" log action
    const runBackups: { folder: string; path: string }[] = [];

    // Process one phase in parallel batches of 4
    const BATCH_SIZE = 4;
    const runPhase = async (tasks: UpdateTask[]): Promise<void> => {
      for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
        if (updateCancelRef.current) {
          cancelled += tasks.length - i;
          return;
        }
        const batch = tasks.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async ({ addon, catalogAddon, isReplacement, overlayFor, isReapply }) => {
            if (updateCancelRef.current) throw new Error('cancelled');
            // Backup current version before updating (skip for re-applies — the
            // folder was already backed up before its main update this run)
            if (!isReapply) {
              const bp = await window.electronAPI.backupAddonFolder(addonPath, addon.folderName, addon.version);
              if (bp && !runBackups.some(b => b.folder === addon.folderName)) {
                runBackups.push({ folder: addon.folderName, path: bp });
              }
            }
            // For replacements: delete old folder so stale files don't linger
            if (isReplacement) {
              addLog(`Replacing "${addon.folderName}" with "${catalogAddon.name}"...`);
              await window.electronAPI.deleteAddon(addonPath, addon.folderName);
            } else if (overlayFor) {
              addLog(`${isReapply ? 'Re-applying' : 'Updating'} overlay "${catalogAddon.name}" → v${catalogAddon.version} in ${overlayFor}...`);
            } else {
              addLog(`Updating "${addon.folderName}" ${addon.version} → ${catalogAddon.version}...`);
            }
            try {
              const result = await window.electronAPI.installAddon(catalogAddon.id, addonPath, overlayFor ? { overlayFor } : undefined);
              if (result.error) {
                addLog(`Failed to update "${overlayFor ? catalogAddon.name : addon.folderName}": ${result.error}`, 'error');
                return false;
              } else {
                addLog(`${overlayFor ? `Applied overlay "${catalogAddon.name}"` : `Updated "${addon.folderName}"`} (${result.installed.join(', ')})`, 'success');
                setRecentlyUpdated((prev) => new Set(prev).add(catalogAddon.id));
                // Remove from catalog diff — this addon is now up to date
                setCatalogChangedIds(prev => {
                  if (!prev.has(catalogAddon.id)) return prev;
                  const next = new Set(prev);
                  next.delete(catalogAddon.id);
                  return next;
                });
                newVersions[catalogAddon.id] = catalogAddon.version;
                if (!overlayFor) updatedFolders.add(addon.folderName);
                return true;
              }
            } catch (err: unknown) {
              addLog(`Error updating "${overlayFor ? catalogAddon.name : addon.folderName}": ${errMsg(err)}`, 'error');
              return false;
            }
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) success++;
          else failed++;
        }
        done += batch.length;
        setUpdateRemaining(Math.max(0, totalTasks - done));
      }
    };

    try {
      await runPhase(mainPhase);
      // Re-applies only make sense when their original actually updated;
      // directly selected overlay updates always run.
      const overlayTasks = overlayPhase.filter(t => !t.isReapply || updatedFolders.has(t.addon.folderName));
      const skippedReapplies = overlayPhase.length - overlayTasks.length;
      if (skippedReapplies > 0) {
        addLog(`Skipped ${skippedReapplies} overlay re-appl${skippedReapplies === 1 ? 'y' : 'ies'} (original update did not succeed)`, 'warn');
      }
      await runPhase(overlayTasks);
    } catch (err: unknown) {
      addLog(`Update All encountered an error: ${errMsg(err)}`, 'error');
    } finally {

      setInstallingAddon(null);
      setUpdatingAll(false);
      setUpdateRemaining(0);
      setUpdateTotal(0);
      updateCancelRef.current = false;
      const summaryParts = [`${success} updated`, `${failed} failed`];
      if (cancelled > 0) summaryParts.push(`${cancelled} cancelled`);
      const undoAllAction = success > 0 && runBackups.length > 0 ? {
        label: '↩ Undo all',
        onClick: async () => {
          try {
            let restored = 0;
            for (const { folder, path: bp } of runBackups) {
              const ok = await window.electronAPI.restoreAddonBackup(addonPath, folder, bp);
              if (ok) restored++;
            }
            addLog(`Undo Update All: restored ${restored} of ${runBackups.length} addon(s) to their pre-update versions`, restored > 0 ? 'success' : 'error');
            if (restored > 0) scanPath(addonPath);
          } catch (e: unknown) { addLog(`Undo failed: ${errMsg(e)}`, 'error'); }
        },
      } : undefined;
      setLogs((prev) => [...prev, { timestamp: new Date(), message: `Update All complete: ${summaryParts.join(', ')}`, level: success > 0 ? 'success' as const : 'warn' as const, action: undoAllAction }]);
      await scanPath(addonPath);
      // Commit the catalog snapshot so next session sees a fresh baseline
      if (success > 0) {
        window.electronAPI.commitCatalogSnapshot(addonPath).catch(() => {});
      }
    }
  }, [addons, addonPath, catalogById, getCatalogAddon, addLog, scanPath, replacementCandidates, overlayUpdates]);

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

  const handleClearLogs = useCallback(() => setLogs([]), []);

  // Open the restore dialog with snapshot, backup, SavedVars and Removed/ data
  const handleGoBack = useCallback(async () => {
    if (!addonPath) return;
    try {
      const [snaps, bks, svBks, removed] = await Promise.all([
        window.electronAPI.listSnapshots(addonPath),
        window.electronAPI.listAddonBackups(addonPath),
        window.electronAPI.listSvBackups(addonPath),
        window.electronAPI.listRemoved(addonPath),
      ]);
      setRestoreSnapshots(snaps);
      setRestoreBackups(bks);
      setRestoreSvBackups(svBks);
      setRestoreRemoved(removed);
      setShowRestoreDialog(true);
      addLog('Opened restore dialog');
    } catch (err: unknown) {
      addLog(`Failed to load restore data: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addLog]);

  // Restore an entry from Removed/ (deletes, cleanups and hygiene runs all
  // move folders there — this is their global recovery path)
  const handleRestoreRemoved = useCallback(async (relPath: string) => {
    if (!addonPath) return;
    try {
      const res = await window.electronAPI.restoreRemoved(addonPath, relPath);
      if (res.restored) {
        addLog(`Restored "${res.target}" from Removed/`, 'success');
        const removed = await window.electronAPI.listRemoved(addonPath);
        setRestoreRemoved(removed);
        scanPath(addonPath);
      } else {
        addLog(`Restore failed: ${res.error ?? 'unknown error'}`, 'error');
      }
    } catch (err: unknown) {
      addLog(`Restore failed: ${errMsg(err)}`, 'error');
    }
  }, [addonPath, addLog, scanPath]);

  // Restore an addon from a backup
  const handleRestoreBackup = useCallback(
    async (folderName: string, version: string, backupPath: string) => {
      if (!addonPath) return;
      addLog(`Restoring "${folderName}" to version ${version}...`);
      try {
        const ok = await window.electronAPI.restoreAddonBackup(addonPath, folderName, backupPath);
        if (ok) {
          addLog(`Restored "${folderName}" to version ${version}`, 'success');
          // Clear session guard for this addon's catalog ID so update detection works
          const restoredAddon = addonMap.get(folderName);
          if (restoredAddon) {
            const ca = getCatalogAddon(restoredAddon);
            if (ca) {
              setRecentlyUpdated(prev => {
                const next = new Set(prev);
                next.delete(ca.id);
                return next;
              });
            }
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

  // Log a "moved archives" entry with an Undo action that moves them back
  const addDownloadsMoveLog = useCallback((moved: string[]) => {
    setLogs((prev) => [...prev, {
      timestamp: new Date(),
      message: `Moved ${moved.length} archive(s) to Downloads/: ${moved.join(', ')}`,
      level: 'success' as const,
      action: {
        label: '↩ Undo',
        onClick: async () => {
          try {
            const res = await window.electronAPI.moveDownloadsBack(addonPath, moved);
            for (const e of res.errors) addLog(`Undo: ${e}`, 'warn');
            addLog(`Moved ${res.restored.length} archive(s) back to AddOns/`, res.restored.length > 0 ? 'success' : 'warn');
          } catch (e: unknown) { addLog(`Undo failed: ${errMsg(e)}`, 'error'); }
        },
      },
    }]);
  }, [addonPath, addLog]);

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
          addDownloadsMoveLog(result.moved);
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
  }, [addonPath, addLog, skipCleanupConfirm, addDownloadsMoveLog]);

  const handleCleanupDownloadsConfirm = useCallback(async (selectedItems: string[]) => {
    setCleanupDialog(null);
    if (!addonPath || selectedItems.length === 0) return;
    setLoading(true);
    addLog(`Moving ${selectedItems.length} archive(s) to Downloads folder...`);
    try {
      const result = await window.electronAPI.cleanupDownloadsSelected(addonPath, selectedItems);
      if (result.moved.length > 0) {
        addDownloadsMoveLog(result.moved);
      }
    } catch (err: unknown) {
      addLog(`Cleanup archives failed: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addonPath, addLog, addDownloadsMoveLog]);

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
      if (!addonPath) {
        addLog('Set an AddOns path before installing', 'warn');
        return;
      }
      setInstallingAddon(catalogAddon.id);
      addLog(`Installing "${catalogAddon.name}" from catalog...`);
      try {
        // Backup existing addon if it's an update (match by directory or title)
        const existingAddon = addons.find((a) =>
          catalogAddon.directories.includes(a.folderName) || a.title === catalogAddon.name
        );
        let backupPath = '';
        const backupFolder = existingAddon?.folderName || '';
        if (existingAddon) {
          backupPath = await window.electronAPI.backupAddonFolder(addonPath, existingAddon.folderName, existingAddon.version);
        }
        // If this catalog entry is a language patch / fix pack targeting an
        // installed folder, install it as an OVERLAY so it never hijacks the
        // folder's main identity in the tracking database.
        let overlayFor: string | undefined;
        for (const dir of catalogAddon.directories) {
          const ownership = dirOwnership.get(dir);
          if (ownership?.overlays.some((o) => o.id === catalogAddon.id) && installedDirNames.has(dir)) {
            overlayFor = dir;
            break;
          }
        }
        if (overlayFor) {
          addLog(`"${catalogAddon.name}" is a patch for ${overlayFor} — installing as overlay (main identity preserved)`);
        }
        const result = await window.electronAPI.installAddon(catalogAddon.id, addonPath, overlayFor ? { overlayFor } : undefined);
        if (result.error) {
          addLog(`Failed to install "${catalogAddon.name}": ${result.error}`, 'error');
        } else {
          if (result.missingDeps.length > 0) {
            addLog(`Missing dependencies: ${result.missingDeps.join(', ')}`, 'warn');
          }
          // Remove from catalog diff — this addon is now up to date
          setCatalogChangedIds(prev => {
            if (!prev.has(catalogAddon.id)) return prev;
            const next = new Set(prev);
            next.delete(catalogAddon.id);
            return next;
          });
          scanPath(addonPath);
          // Commit snapshot so this addon is no longer flagged next session
          window.electronAPI.commitCatalogSnapshot(addonPath).catch(() => {});
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
    [addonPath, addons, addLog, scanPath, dirOwnership, installedDirNames]
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
        onFolderHygiene={handleFolderHygiene}
        onUpdateAll={handleUpdateAll}
        onCommitBaseline={handleCommitBaselineClick}
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
        overlayUpdateCount={overlayUpdates.length}
        layeredCount={layeredItems.length}
        baselineCount={baselineCandidates.entries.length}
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
                  installedVersions={installedVersions}
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
                  {...(() => {
                    const match = getCatalogMatch(addon);
                    const ca = match?.catalogAddon;
                    const hasUpd = !!ca && isUpdateAvailable(addon, ca);
                    return {
                      hasUpdate: hasUpd,
                      updateTargetVersion: hasUpd ? ca!.version : undefined,
                      overlayInfo: match && (match.installedOverlays.length > 0 || match.layered) ? {
                        count: match.installedOverlays.length,
                        needsReapply: match.installedOverlays.some(o => o.needsReapply),
                        layered: match.layered,
                      } : undefined,
                    };
                  })()}
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
                  installedVersions={installedVersions}
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
                  {...(() => {
                    const match = getCatalogMatch(lib);
                    const ca = match?.catalogAddon;
                    const hasUpd = !!ca && isUpdateAvailable(lib, ca);
                    return {
                      hasUpdate: hasUpd,
                      updateTargetVersion: hasUpd ? ca!.version : undefined,
                      overlayInfo: match && (match.installedOverlays.length > 0 || match.layered) ? {
                        count: match.installedOverlays.length,
                        needsReapply: match.installedOverlays.some(o => o.needsReapply),
                        layered: match.layered,
                      } : undefined,
                    };
                  })()}
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
          knownAddonNames={knownAddonNames}
          onInstall={handleInstallAddon}
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
          updatableCatalogIds={updatableCatalogIds}
          overlayTargets={overlayTargetNames}
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
          removedEntries={restoreRemoved}
          currentAddons={addons.map((a) => ({ folderName: a.folderName, version: a.version }))}
          onRestoreBackup={handleRestoreBackup}
          onRestoreSvFile={handleRestoreSvFile}
          onRestoreRemoved={handleRestoreRemoved}
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
          fontScale={fontScale}
          fontFamily={fontFamily}
          skipCleanupConfirm={skipCleanupConfirm}
          onApply={(s) => {
            setFontScale(s.fontScale);
            setFontFamily(s.fontFamily);
            setSkipCleanupConfirm(s.skipCleanupConfirm);
            window.electronAPI.saveUiSettings({ fontScale: s.fontScale, fontFamily: s.fontFamily, skipCleanupConfirm: s.skipCleanupConfirm });
          }}
          onCleanupMarkers={addonPath ? async () => {
            const res = await window.electronAPI.cleanupYaamMarkers(addonPath);
            const undoAction = res.backupDir ? {
              label: '↩ Undo',
              onClick: async () => {
                try {
                  const undo = await window.electronAPI.restoreTrackingState(addonPath, res.backupDir);
                  if (undo.restored) {
                    addLog(`Marker cleanup undone: tracking state restored (${undo.markers} marker(s))`, 'success');
                    scanPath(addonPath);
                  } else {
                    addLog(`Undo failed: ${undo.error ?? 'unknown error'}`, 'error');
                  }
                } catch (e: unknown) { addLog(`Undo failed: ${errMsg(e)}`, 'error'); }
              },
            } : undefined;
            setLogs((prev) => [...prev, { timestamp: new Date(), message: `Removed ${res.count} .yaam.json marker file${res.count !== 1 ? 's' : ''} and reset version tracking`, level: res.count > 0 ? 'success' as const : 'warn' as const, action: undoAction }]);
            setShowSettings(false);
            await scanPath(addonPath);
          } : undefined}
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
      {hygienePreview && (
        <HygieneDialog
          strayManifests={hygienePreview.strayManifests}
          duplicates={hygienePreview.duplicates}
          unclaimedRootFiles={hygienePreview.unclaimedRootFiles}
          onConfirm={handleHygieneConfirm}
          onCancel={() => setHygienePreview(null)}
        />
      )}
      {baselineConfirm && (
        <div className="unsaved-overlay">
          <div className="restore-dialog" style={{ width: 'min(520px, 90vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="restore-header">
              <div className="restore-title">⚓ Commit Baseline</div>
            </div>
            <div className="restore-content" style={{ padding: '16px 20px' }}>
              <p>
                Anchor <strong>{baselineConfirm.entries.length}</strong> addon(s) at their current
                catalog version as <strong>up-to-date</strong>.
              </p>
              <p style={{ fontSize: '0.857rem', opacity: 0.8 }}>
                This switches them from best-effort version guessing to deterministic tracking:
                any future catalog change is then reliably detected as an update — even when the
                author changes the version format. No files are modified.
              </p>
              <p style={{ fontSize: '0.857rem', opacity: 0.7 }}>
                Skipped: {baselineConfirm.skippedUpdate} with pending updates (install those first),{' '}
                {baselineConfirm.skippedAmbiguous} with ambiguous catalog match,{' '}
                {baselineConfirm.alreadyTracked} already tracked.
              </p>
              <div style={{ maxHeight: '200px', overflowY: 'auto', fontSize: '0.8rem', opacity: 0.75, marginTop: '8px' }}>
                {baselineConfirm.entries.map(e => (
                  <div key={e.folderName}>
                    {e.folderName} → "{e.catalogVersion}"
                    {e.overlays?.map(o => (
                      <span key={o.esouid} style={{ opacity: 0.8 }}> + 🧩 {o.catalogName} "{o.catalogVersion}"</span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="settings-actions" style={{ padding: '12px 16px' }}>
              <button className="restore-btn" onClick={() => setBaselineConfirm(null)}>Cancel</button>
              <button className="restore-btn ie-action-btn" onClick={handleCommitBaselineConfirm}>
                ⚓ Anchor {baselineConfirm.entries.length} addon(s)
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteConfirm && (
        <div className="unsaved-overlay">
          <div className="restore-dialog" style={{ width: 'min(400px, 90vw)' }} onClick={(e) => e.stopPropagation()}>
            <div className="restore-header">
              <div className="restore-title">⚠️ Confirm Delete</div>
            </div>
            <div className="restore-content" style={{ padding: '16px 20px' }}>
              <p>Delete "<strong>{deleteConfirm.title}</strong>"?</p>
              <p style={{ fontSize: '0.857rem', opacity: 0.7 }}>The addon will be moved to the Removed/ folder.</p>
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
