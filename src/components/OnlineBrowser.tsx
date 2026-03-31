// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AddonInfo, CatalogAddon, CharacterSettings, ADDON_CATEGORIES, getCategoryIconUrl, compareVersionStrings } from '../../electron/shared/types';
import ImagePreview from './ImagePreview';
import RichText, { stripBBCode } from './RichText';
import { shortenCharName } from '../App';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface OnlineBrowserProps {
  installedDirNames: Set<string>;
  localAddons: AddonInfo[];
  addonPath: string;
  knownAddonNames: Set<string>;
  onInstall: (addon: CatalogAddon) => void;
  onLog: (message: string, level?: 'info' | 'warn' | 'error' | 'success') => void;
  onNavigate: (name: string) => void;
  onDelete?: (folderName: string) => void;
  getCharacterSettings?: (folderName: string) => CharacterSettings | undefined;
  onToggleCharSetting?: (addonName: string, character: string, enabled: boolean) => void;
  flex?: number;
  highlightAddonId?: string | null;
  catalogByDir?: Map<string, CatalogAddon>;
  installingAddonId?: string | null;
  installProgress?: Record<string, { phase: string; percent?: number; current?: number; total?: number }>;
  /** Central update-availability check shared with Update All */
  checkUpdateAvailable?: (addon: AddonInfo, catalogAddon: CatalogAddon) => boolean;
}

type SortField = 'name' | 'downloads' | 'monthly' | 'date' | 'favorites';

const OnlineBrowser: React.FC<OnlineBrowserProps> = ({
  installedDirNames,
  localAddons,
  addonPath,
  knownAddonNames,
  onInstall,
  onLog,
  onNavigate,
  onDelete,
  getCharacterSettings,
  onToggleCharSetting,
  flex,
  highlightAddonId,
  catalogByDir,
  installingAddonId,
  installProgress,
  checkUpdateAvailable,
}) => {
  const [allAddons, setAllAddons] = useState<CatalogAddon[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('downloads');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [depsExpandedIds, setDepsExpandedIds] = useState<Set<string>>(new Set());
  const [optDepsExpandedIds, setOptDepsExpandedIds] = useState<Set<string>>(new Set());
  const [charsExpandedIds, setCharsExpandedIds] = useState<Set<string>>(new Set());
  const [descExpandedIds, setDescExpandedIds] = useState<Set<string>>(new Set());
  const [showInstalledOnly, setShowInstalledOnly] = useState(false);
  const [addonDetails, setAddonDetails] = useState<Record<string, { description: string; changeLog: string; md5: string; downloadUrl: string; fileName: string }>>({});
  const [detailsLoading, setDetailsLoading] = useState<Set<string>>(new Set());
  const [dynamicCategories, setDynamicCategories] = useState<Record<string, string>>({});
  const [infoAddonId, setInfoAddonId] = useState<string | null>(null);
  const infoPopupRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // When highlightAddonId changes, clear filters, expand that addon, and scroll to it
  useEffect(() => {
    if (!highlightAddonId) return;
    setSearchQuery('');
    setCategoryFilter('');
    setExpandedIds(prev => new Set(prev).add(highlightAddonId));
    setFocusedId(highlightAddonId);
    // Scroll to the element after render
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-catalog-id="${highlightAddonId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, [highlightAddonId]);

  // Fetch addon details on-demand when expanded or info popup opened
  useEffect(() => {
    const targets = [...expandedIds];
    if (infoAddonId) targets.push(infoAddonId);
    for (const targetId of targets) {
      if (!targetId || addonDetails[targetId] || detailsLoading.has(targetId)) continue;
      setDetailsLoading(prev => new Set(prev).add(targetId));
      window.electronAPI.fetchAddonDetails(targetId)
        .then(details => setAddonDetails(prev => ({ ...prev, [targetId]: details })))
        .finally(() => setDetailsLoading(prev => { const next = new Set(prev); next.delete(targetId); return next; }));
    }
  }, [expandedIds, infoAddonId, addonDetails, detailsLoading]);

  // Close info popup on outside click or Escape
  useEffect(() => {
    if (!infoAddonId) return;
    const handleClick = (e: MouseEvent) => {
      if (infoPopupRef.current && !infoPopupRef.current.contains(e.target as Node)) {
        setInfoAddonId(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInfoAddonId(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [infoAddonId]);

  // Fetch the addon list and categories on mount
  useEffect(() => {
    loadList(false);
    window.electronAPI.fetchCategories().then(cats => {
      const map: Record<string, string> = { '': 'All Categories' };
      for (const c of cats) map[c.id] = c.name;
      setDynamicCategories(map);
    }).catch(() => {});
  }, []);

  const loadList = useCallback(async (forceRefresh: boolean) => {
    setLoading(true);
    try {
      const list = await window.electronAPI.fetchAddonCatalog(forceRefresh);
      setAllAddons(list);
      if (forceRefresh) {
        onLog(`Refreshed addon catalog: ${list.length} addons`, 'info');
      } else {
        onLog(`Loaded addon catalog: ${list.length} addons`, 'info');
      }
    } catch (err: unknown) {
      onLog(`Failed to load addon catalog: ${errMsg(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [onLog]);

  // Category name resolver: dynamic API → hardcoded fallback
  const getCategoryName = useCallback((catId: string) => {
    return dynamicCategories[catId] || ADDON_CATEGORIES[catId] || `Category ${catId}`;
  }, [dynamicCategories]);

  // Build sorted list of unique categories from the data
  const categoryOptions = useMemo(() => {
    const cats = new Map<string, string>();
    for (const addon of allAddons) {
      const catId = addon.categoryId;
      if (!cats.has(catId)) {
        cats.set(catId, getCategoryName(catId));
      }
    }
    return Array.from(cats.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allAddons, getCategoryName]);

  // Filter and sort
  const filteredAddons = useMemo(() => {
    let list = allAddons;

    // Category filter
    if (categoryFilter) {
      list = list.filter((a) => a.categoryId === categoryFilter);
    }

    // Installed-only filter (primary directory must be installed)
    if (showInstalledOnly) {
      list = list.filter((a) => a.directories.length > 0 && installedDirNames.has(a.directories[0]));
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.author.toLowerCase().includes(q)
      );
    }

    // Sort
    const sorted = [...list];
    switch (sortField) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'downloads':
        sorted.sort((a, b) => b.totalDownloads - a.totalDownloads);
        break;
      case 'monthly':
        sorted.sort((a, b) => b.monthlyDownloads - a.monthlyDownloads);
        break;
      case 'date':
        sorted.sort((a, b) => b.date - a.date);
        break;
      case 'favorites':
        sorted.sort((a, b) => b.favorites - a.favorites);
        break;
    }

    return sorted;
  }, [allAddons, categoryFilter, searchQuery, sortField, showInstalledOnly, installedDirNames]);

  const handleInstall = useCallback(async (addon: CatalogAddon) => {
    if (!addonPath) {
      onLog('Set an AddOns path before installing', 'warn');
      return;
    }
    setInstalling(addon.id);
    onLog(`Installing "${addon.name}" from catalog...`, 'info');
    try {
      const result = await window.electronAPI.installAddon(addon.id, addonPath);
      if (result.error) {
        onLog(`Failed to install "${addon.name}": ${result.error}`, 'error');
      } else {
        const primaryDirs = result.installed.filter((d) => !d.startsWith('Lib'));
        const depDirs = result.installed.filter((d) => d.startsWith('Lib'));
        if (depDirs.length > 0) {
          onLog(
            `Installed "${addon.name}" (${primaryDirs.join(', ')}) + ${depDirs.length} dependenc${depDirs.length === 1 ? 'y' : 'ies'} (${depDirs.join(', ')})`,
            'success'
          );
        } else {
          onLog(
            `Installed "${addon.name}" (${result.installed.join(', ')})`,
            'success'
          );
        }
        if (result.missingDeps.length > 0) {
          onLog(
            `Could not resolve ${result.missingDeps.length} dependenc${result.missingDeps.length === 1 ? 'y' : 'ies'}: ${result.missingDeps.join(', ')}`,
            'warn'
          );
        }
        onInstall(addon);
      }
    } catch (err: unknown) {
      onLog(`Error installing "${addon.name}": ${errMsg(err)}`, 'error');
    } finally {
      setInstalling(null);
    }
  }, [addonPath, onInstall, onLog]);

  const formatNumber = (n: number) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  };

  const formatDate = (ts: number) => {
    return new Date(ts * 1000).toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  /** Primary install: the addon's first/main directory is a top-level local folder */
  const isInstalled = (addon: CatalogAddon) => {
    if (addon.directories.length === 0) return false;
    return installedDirNames.has(addon.directories[0]);
  };

  /** Bundled: the addon's main dir is NOT installed, but some bundled dir (library) is */
  const isBundledOnly = (addon: CatalogAddon) => {
    if (addon.directories.length === 0) return false;
    if (installedDirNames.has(addon.directories[0])) return false;
    return addon.directories.some((dir) => installedDirNames.has(dir));
  };

  // Build a map from directory name -> local AddonInfo for dependency lookup
  const localAddonByDir = useMemo(() => {
    const map = new Map<string, AddonInfo>();
    for (const a of localAddons) {
      map.set(a.folderName, a);
    }
    return map;
  }, [localAddons]);

  /** Get the local installed version string for an online addon (first matching dir) */
  const getLocalVersion = useCallback(
    (addon: CatalogAddon): string | undefined => {
      for (const dir of addon.directories) {
        const local = localAddonByDir.get(dir);
        if (local && local.version) return local.version;
      }
      return undefined;
    },
    [localAddonByDir]
  );

  // Get combined dependencies for an online addon (from its locally installed dirs)
  const getDepsForOnlineAddon = useCallback(
    (addon: CatalogAddon) => {
      const deps: { name: string; minVersion?: number }[] = [];
      const seen = new Set<string>();
      for (const dir of addon.directories) {
        const local = localAddonByDir.get(dir);
        if (local) {
          for (const dep of local.dependsOn) {
            if (!seen.has(dep.name)) {
              seen.add(dep.name);
              deps.push(dep);
            }
          }
        }
      }
      return deps.sort((a, b) => a.name.localeCompare(b.name));
    },
    [localAddonByDir]
  );

  // Get combined optional dependencies for an online addon
  const getOptDepsForOnlineAddon = useCallback(
    (addon: CatalogAddon) => {
      const deps: { name: string; minVersion?: number }[] = [];
      const seen = new Set<string>();
      for (const dir of addon.directories) {
        const local = localAddonByDir.get(dir);
        if (local) {
          for (const dep of local.optionalDependsOn) {
            if (!seen.has(dep.name)) {
              seen.add(dep.name);
              deps.push(dep);
            }
          }
        }
      }
      return deps.sort((a, b) => a.name.localeCompare(b.name));
    },
    [localAddonByDir]
  );

  // Keyboard navigation for online browsing
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (filteredAddons.length === 0) return;
      const key = e.key;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(key)) return;
      e.preventDefault();

      if (key === 'Escape') {
        setExpandedIds(new Set());
        setFocusedId(null);
        return;
      }

      const currentIdx = focusedId ? filteredAddons.findIndex((a) => a.id === focusedId) : -1;

      if (key === 'ArrowDown') {
        const nextIdx = currentIdx < filteredAddons.length - 1 ? currentIdx + 1 : 0;
        const next = filteredAddons[nextIdx];
        setFocusedId(next.id);
        requestAnimationFrame(() => {
          const el = scrollRef.current?.querySelector(`[data-catalog-id="${next.id}"]`);
          el?.scrollIntoView({ block: 'nearest' });
        });
      } else if (key === 'ArrowUp') {
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : filteredAddons.length - 1;
        const prev = filteredAddons[prevIdx];
        setFocusedId(prev.id);
        requestAnimationFrame(() => {
          const el = scrollRef.current?.querySelector(`[data-catalog-id="${prev.id}"]`);
          el?.scrollIntoView({ block: 'nearest' });
        });
      } else if (key === 'Enter') {
        if (currentIdx >= 0) {
          const id = filteredAddons[currentIdx].id;
          setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          });
        } else if (filteredAddons.length > 0) {
          const id = filteredAddons[0].id;
          setExpandedIds(prev => new Set(prev).add(id));
          setFocusedId(id);
        }
      }
    },
    [filteredAddons, focusedId]
  );

  return (
    <div className="tree-panel online-browser" style={flex != null ? { flex } : undefined}>
      <div className="tree-panel-header">
        <span>Online Browse</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button className="collapse-all-btn" onClick={() => {
            setExpandedIds(new Set());
            setFocusedId(null);
            setDepsExpandedIds(new Set());
            setOptDepsExpandedIds(new Set());
            setCharsExpandedIds(new Set());
            setDescExpandedIds(new Set());
          }} title="Collapse all">⏶</button>
          <span className="count">{filteredAddons.length}</span>
        </div>
      </div>
      <div className="online-filters">
        <input
          type="text"
          className="online-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search catalog..."
          spellCheck={false}
        />
        <select
          className="online-select"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">All Categories</option>
          {categoryOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select
          className="online-select"
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
        >
          <option value="downloads">Total Downloads</option>
          <option value="monthly">Monthly Downloads</option>
          <option value="date">Last Updated</option>
          <option value="favorites">Favorites</option>
          <option value="name">Name</option>
        </select>
        <label className="online-installed-filter" title="Show only addons that are installed locally">
          <input
            type="checkbox"
            checked={showInstalledOnly}
            onChange={(e) => setShowInstalledOnly(e.target.checked)}
          />
          Installed
        </label>
        <button
          className="online-refresh-btn"
          onClick={() => loadList(true)}
          disabled={loading}
          title="Refresh catalog from ESOUI"
        >
          🔄
        </button>
      </div>
      <div className="tree-scroll" ref={scrollRef} tabIndex={0} onKeyDown={handleKeyDown}>
        {loading && allAddons.length === 0 ? (
          <div className="empty-state">
            <div className="icon">🌐</div>
            <p>Loading addon catalog...</p>
          </div>
        ) : filteredAddons.length === 0 ? (
          <div className="empty-state">
            <div className="icon">🔍</div>
            <p>No matching addons</p>
          </div>
        ) : (
          filteredAddons.map((addon) => {
            const installed = isInstalled(addon);
            const bundledOnly = !installed && isBundledOnly(addon);
            const localVer = installed ? getLocalVersion(addon) : undefined;
            // Update check: use central isUpdateAvailable when we have a local addon
            const localAddon = addon.directories.find(dir => localAddonByDir.has(dir));
            const localAddonInfo = localAddon ? localAddonByDir.get(localAddon) : undefined;
            const hasUpdate = installed && localAddonInfo && checkUpdateAvailable
              ? checkUpdateAvailable(localAddonInfo, addon)
              : false;
            const isLocalNewer = installed && localVer && addon.version
              ? compareVersionStrings(localVer, addon.version, addon.date) > 0
              : false;
            const isExpanded = expandedIds.has(addon.id);
            const isCurrentlyInstalling = installing === addon.id;
            const catName = getCategoryName(addon.categoryId);
            const deps = getDepsForOnlineAddon(addon);
            const optDeps = getOptDepsForOnlineAddon(addon);
            // Get character settings for first installed dir
            const installedDir = addon.directories.find((dir) => installedDirNames.has(dir));
            const charSettings = installedDir && getCharacterSettings ? getCharacterSettings(installedDir) : undefined;
            const hasChars = charSettings && Object.keys(charSettings).length > 0;

            return (
              <div key={addon.id} className="tree-item" data-catalog-id={addon.id}>
                <div
                  className={`tree-item-row ${isExpanded ? 'selected' : ''}`}
                  onClick={() => setExpandedIds(prev => {
                    const next = new Set(prev);
                    if (isExpanded) next.delete(addon.id); else next.add(addon.id);
                    return next;
                  })}
                >
                  <span className={`tree-chevron ${isExpanded ? 'expanded' : ''}`}>▶</span>
                  <span className="tree-icon" title={installed ? 'Installed locally' : bundledOnly ? 'Not installed (shared library present)' : 'Not installed'}>{installed ? '🟢' : bundledOnly ? '🟡' : '⚪'}</span>
                  {addon.categoryId && (
                    <img
                      className="tree-cat-icon"
                      src={getCategoryIconUrl(addon.categoryId)}
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <span className="tree-label">
                    {addon.name}
                    {addon.version && <span className="tree-version"> v{addon.version}</span>}
                    {localVer && <span className="tree-local-version"> [local: v{localVer}]</span>}
                    {hasUpdate && <span className="tree-update-badge" title="Update available — catalog has a newer version">⬆️</span>}
                    {isLocalNewer && <span className="tree-regression-badge" title="Local version is newer than catalog — possible version scheme change">⚠️</span>}
                  </span>
                  <span className="tree-row-actions">
                    <button
                      className="row-btn"
                      onClick={(e) => { e.stopPropagation(); setInfoAddonId(addon.id); }}
                      title="Show addon details"
                    >
                      ℹ️
                    </button>
                    <button
                      className={`row-btn row-btn-install`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInstall(addon);
                      }}
                      disabled={isCurrentlyInstalling}
                      title={isLocalNewer ? `Downgrade to catalog version (v${addon.version})` : installed ? 'Reinstall' : bundledOnly ? 'Install (bundled library already present)' : 'Install'}
                    >
                      {isCurrentlyInstalling ? '⏳' : isLocalNewer ? '⬇️' : installed ? '🔄' : '📥'}
                    </button>
                    {installed && onDelete && installedDir && (
                      <button
                        className="row-btn row-btn-delete"
                        onClick={(e) => { e.stopPropagation(); onDelete(installedDir); }}
                        title="Delete addon"
                      >
                        🗑️
                      </button>
                    )}
                  </span>
                </div>
                {(isCurrentlyInstalling || installingAddonId === addon.id) && (() => {
                  const progress = installProgress?.[addon.id];
                  if (!progress) return null;
                  const isIndeterminate = progress.phase === 'resolving';
                  const pct = isIndeterminate ? 100 : (progress.percent || 0);
                  const prefix = progress.total && progress.total > 1 ? `${progress.current}/${progress.total} ` : '';
                  const label = progress.phase === 'resolving' ? `${prefix}Resolving...`
                    : progress.phase === 'downloading' ? `${prefix}Downloading ${progress.percent || 0}%`
                    : `${prefix}Extracting…`;
                  return (
                    <div className="install-progress-container">
                      <div className="install-progress-track">
                        <div className={`install-progress-fill ${isIndeterminate ? 'indeterminate' : ''}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="install-progress-label">{label}</span>
                    </div>
                  );
                })()}
                {isExpanded && (
                  <div className="tree-children">
                    {/* Image preview */}
                    {addon.thumbnails.length > 0 && (
                      <ImagePreview thumbnails={addon.thumbnails} images={addon.images} />
                    )}

                    {/* Author */}
                    <div className="tree-detail">
                      <span className="detail-label">Author:</span> {addon.author}
                    </div>
                    {/* Description (loaded on demand) */}
                    {detailsLoading.has(addon.id) && (
                      <div className="tree-detail" style={{ opacity: 0.6 }}>Loading description…</div>
                    )}
                    {addonDetails[addon.id]?.description && (
                      <div
                        className={`tree-detail desc-expandable ${descExpandedIds.has(addon.id) ? 'desc-expanded' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setDescExpandedIds(prev => { const s = new Set(prev); if (s.has(addon.id)) s.delete(addon.id); else s.add(addon.id); return s; }); }}
                        title={descExpandedIds.has(addon.id) ? 'Click to collapse' : 'Click to expand'}
                      >
                        <span className="detail-label"><span className="desc-chevron">{descExpandedIds.has(addon.id) ? '▼' : '▶'}</span>Description:</span>{' '}
                        {descExpandedIds.has(addon.id) ? <RichText text={addonDetails[addon.id].description} /> : stripBBCode(addonDetails[addon.id].description)}
                      </div>
                    )}
                    {/* Category */}
                    <div className="tree-detail">
                      <span className="detail-label">Category:</span>
                      {addon.categoryId && (
                        <img
                          className="category-icon"
                          src={getCategoryIconUrl(addon.categoryId)}
                          alt=""
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                      {' '}{catName}
                    </div>
                    {/* Version */}
                    {addon.version && (
                      <div className="tree-detail">
                        <span className="detail-label">Version:</span> {addon.version}
                      </div>
                    )}
                    {/* Updated */}
                    <div className="tree-detail">
                      <span className="detail-label">Updated:</span> {formatDate(addon.date)}
                    </div>
                    {/* Downloads */}
                    <div className="tree-detail">
                      <span className="detail-label">Downloads:</span> {addon.totalDownloads.toLocaleString()} total / {addon.monthlyDownloads.toLocaleString()} monthly
                    </div>
                    {/* Favorites */}
                    <div className="tree-detail">
                      <span className="detail-label">Favorites:</span> {addon.favorites.toLocaleString()}
                    </div>
                    {/* Compatible */}
                    {addon.compatibility.length > 0 && (
                      <div className="tree-detail">
                        <span className="detail-label">Compatible:</span>{' '}
                        {addon.compatibility.slice(0, 3).map((c) => c.name).join(', ')}
                        {addon.compatibility.length > 3 && ` +${addon.compatibility.length - 3} more`}
                      </div>
                    )}
                    {/* Dirs */}
                    {addon.directories.length > 0 && (
                      <div className="tree-detail">
                        <span className="detail-label">Dirs:</span> {addon.directories.join(', ')}
                      </div>
                    )}

                    {/* Dependencies - expandable subtree */}
                    {deps.length > 0 && (
                      <div className="tree-item">
                        <div
                          className="tree-subtree-row"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDepsExpandedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(addon.id)) next.delete(addon.id);
                              else next.add(addon.id);
                              return next;
                            });
                          }}
                        >
                          <span className={`tree-chevron ${depsExpandedIds.has(addon.id) ? 'expanded' : ''}`}>▶</span>
                          <span className="detail-label">Dependencies</span>
                          <span className="tree-badge-small">{deps.length}</span>
                        </div>
                        {depsExpandedIds.has(addon.id) && (
                          <div className="tree-children">
                            {deps.map((dep, i) => {
                              const isDepInstalled = knownAddonNames.has(dep.name);
                              const depCatalog = catalogByDir?.get(dep.name);
                              const isDepInstalling = depCatalog && (installing === depCatalog.id || installingAddonId === depCatalog.id);
                              return (
                              <div key={i} className={`tree-subtree-leaf ${!isDepInstalled ? 'dep-missing' : ''}`}>
                                <span className="tree-leaf-icon">{!isDepInstalled ? '❌' : '📎'}</span>
                                <span
                                  className="dep-link"
                                  onClick={(e) => { e.stopPropagation(); onNavigate(dep.name); }}
                                >
                                  {dep.name}
                                </span>
                                {dep.minVersion !== undefined && (
                                  <span className="dep-version">≥{dep.minVersion}</span>
                                )}
                                {!isDepInstalled && (
                                  <span className="dep-not-installed">not installed</span>
                                )}
                                <span className="dep-actions">
                                  {depCatalog && (
                                    <button
                                      className="row-btn row-btn-install dep-btn"
                                      onClick={(e) => { e.stopPropagation(); handleInstall(depCatalog); }}
                                      disabled={!!isDepInstalling}
                                      title={isDepInstalled ? 'Reinstall' : 'Install'}
                                    >
                                      {isDepInstalling ? '⏳' : isDepInstalled ? '🔄' : '📥'}
                                    </button>
                                  )}
                                  {isDepInstalled && onDelete && (
                                    <button
                                      className="row-btn row-btn-delete dep-btn"
                                      onClick={(e) => { e.stopPropagation(); onDelete(dep.name); }}
                                      title="Delete dependency"
                                    >
                                      🗑️
                                    </button>
                                  )}
                                </span>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Optional Dependencies - expandable subtree */}
                    {optDeps.length > 0 && (
                      <div className="tree-item">
                        <div
                          className="tree-subtree-row"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOptDepsExpandedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(addon.id)) next.delete(addon.id);
                              else next.add(addon.id);
                              return next;
                            });
                          }}
                        >
                          <span className={`tree-chevron ${optDepsExpandedIds.has(addon.id) ? 'expanded' : ''}`}>▶</span>
                          <span className="detail-label">Optional</span>
                          <span className="tree-badge-small">{optDeps.length}</span>
                        </div>
                        {optDepsExpandedIds.has(addon.id) && (
                          <div className="tree-children">
                            {optDeps.map((dep, i) => {
                              const isDepInstalled = knownAddonNames.has(dep.name);
                              const depCatalog = catalogByDir?.get(dep.name);
                              const isDepInstalling = depCatalog && (installing === depCatalog.id || installingAddonId === depCatalog.id);
                              return (
                              <div key={i} className={`tree-subtree-leaf ${!isDepInstalled ? 'dep-missing' : ''}`}>
                                <span className="tree-leaf-icon">{!isDepInstalled ? '❌' : '📎'}</span>
                                <span
                                  className="dep-link"
                                  onClick={(e) => { e.stopPropagation(); onNavigate(dep.name); }}
                                >
                                  {dep.name}
                                </span>
                                {dep.minVersion !== undefined && (
                                  <span className="dep-version">≥{dep.minVersion}</span>
                                )}
                                {!isDepInstalled && (
                                  <span className="dep-not-installed">not installed</span>
                                )}
                                <span className="dep-actions">
                                  {depCatalog && (
                                    <button
                                      className="row-btn row-btn-install dep-btn"
                                      onClick={(e) => { e.stopPropagation(); handleInstall(depCatalog); }}
                                      disabled={!!isDepInstalling}
                                      title={isDepInstalled ? 'Reinstall' : 'Install'}
                                    >
                                      {isDepInstalling ? '⏳' : isDepInstalled ? '🔄' : '📥'}
                                    </button>
                                  )}
                                  {isDepInstalled && onDelete && (
                                    <button
                                      className="row-btn row-btn-delete dep-btn"
                                      onClick={(e) => { e.stopPropagation(); onDelete(dep.name); }}
                                      title="Delete optional dependency"
                                    >
                                      🗑️
                                    </button>
                                  )}
                                </span>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Character settings for installed addons */}
                    {hasChars && (
                      <div className="tree-item">
                        <div
                          className="tree-subtree-row"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCharsExpandedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(addon.id)) next.delete(addon.id);
                              else next.add(addon.id);
                              return next;
                            });
                          }}
                        >
                          <span className={`tree-chevron ${charsExpandedIds.has(addon.id) ? 'expanded' : ''}`}>▶</span>
                          <span className="detail-label">Characters</span>
                          <span className="tree-badge-small">{Object.keys(charSettings!).length}</span>
                        </div>
                        {charsExpandedIds.has(addon.id) && (
                          <div className="tree-children">
                            {Object.entries(charSettings!)
                              .sort(([a], [b]) => a.localeCompare(b))
                              .map(([charName, enabled]) => (
                                <div key={charName} className="tree-subtree-leaf char-setting-row">
                                  <label
                                    className="char-checkbox-label"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={enabled}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        if (installedDir) {
                                          onToggleCharSetting?.(installedDir, charName, e.target.checked);
                                        }
                                      }}
                                    />
                                    <span className="char-name">{shortenCharName(charName)}</span>
                                  </label>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Links row at bottom */}
                    <div className="tree-detail catalog-links">
                      {installed && installedDir && (
                        <span
                          className="dep-link"
                          onClick={(e) => { e.stopPropagation(); onNavigate(installedDir); }}
                          title={`Go to ${installedDir} in local tree`}
                        >
                          📍 Go to local tree
                        </span>
                      )}
                      <a
                        className="online-link"
                        href={addon.infoUrl}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          window.electronAPI.openExternalUrl(addon.infoUrl);
                        }}
                        title="Open addon page in browser"
                      >
                        🔗 Addon Page
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Info popup for ESOUI addon details */}
      {infoAddonId && (() => {
        const infoAddon = allAddons.find(a => a.id === infoAddonId);
        if (!infoAddon) return null;
        const details = addonDetails[infoAddonId];
        const isLoading = detailsLoading.has(infoAddonId);
        const installedDir = infoAddon.directories.find(dir => installedDirNames.has(dir));
        const localAddon = installedDir ? localAddons.find(a => a.folderName === installedDir) : undefined;
        return (
          <div className="unsaved-overlay" onClick={(e) => { e.stopPropagation(); setInfoAddonId(null); }}>
            <div ref={infoPopupRef} className="addon-info-popup" onClick={(e) => e.stopPropagation()}>
              <div className="catalog-json-header">
                <span>ℹ️ {infoAddon.name}</span>
                <button className="restore-close-btn" onClick={() => setInfoAddonId(null)} title="Close">✕</button>
              </div>
              {(() => {
                const installed = infoAddon.directories.some(dir => installedDirNames.has(dir));
                const localAddonForBtn = installedDir ? localAddons.find(a => a.folderName === installedDir) : undefined;
                const hasUpdate = installed && localAddonForBtn && checkUpdateAvailable
                  ? checkUpdateAvailable(localAddonForBtn, infoAddon) : false;
                const isLocalNewer = installed && localAddonForBtn && infoAddon.version
                  ? compareVersionStrings(localAddonForBtn.version, infoAddon.version, infoAddon.date) > 0 : false;
                const isCurrentlyInstalling = installing === infoAddon.id || installingAddonId === infoAddon.id;
                return (
                  <div className="addon-info-actions">
                    <button className="info-action-btn" onClick={() => { setInfoAddonId(null); handleInstall(infoAddon); }} disabled={isCurrentlyInstalling}
                      title={isCurrentlyInstalling ? 'Installing…' : hasUpdate ? 'Update to catalog version' : isLocalNewer ? `Downgrade to v${infoAddon.version}` : installed ? 'Reinstall' : 'Install'}>
                      {isCurrentlyInstalling ? '⏳' : hasUpdate ? '⬆️' : isLocalNewer ? '⬇️' : installed ? '🔄' : '📥'} {isCurrentlyInstalling ? 'Installing…' : hasUpdate ? 'Update' : isLocalNewer ? 'Downgrade' : installed ? 'Reinstall' : 'Install'}
                    </button>
                    {installed && onDelete && installedDir && (
                      <button className="info-action-btn danger" onClick={() => { setInfoAddonId(null); onDelete(installedDir); }} title="Delete installed addon">
                        🗑️ Delete
                      </button>
                    )}
                    {infoAddon.infoUrl && (
                      <button className="info-action-btn" onClick={() => window.electronAPI.openExternalUrl(infoAddon.infoUrl)} title="Open ESOUI page">
                        🌐 ESOUI
                      </button>
                    )}
                    {installed && (
                      <button className="info-action-btn" onClick={() => { setInfoAddonId(null); onNavigate(infoAddon.name); }} title="Find in addon/library tree">
                        🔍 Find
                      </button>
                    )}
                  </div>
                );
              })()}
              <div className="addon-info-content">
                <table className="addon-info-table">
                  <tbody>
                    <tr><td className="info-label">Name</td><td>{infoAddon.name}</td></tr>
                    <tr><td className="info-label">Author</td><td>{infoAddon.author}</td></tr>
                    <tr><td className="info-label">Version</td><td>{infoAddon.version}</td></tr>
                    <tr><td className="info-label">Category</td><td>{getCategoryName(infoAddon.categoryId)}</td></tr>
                    <tr><td className="info-label">Updated</td><td>{formatDate(infoAddon.date)}</td></tr>
                    <tr><td className="info-label">Downloads</td><td>{infoAddon.totalDownloads.toLocaleString()} total / {infoAddon.monthlyDownloads.toLocaleString()} monthly</td></tr>
                    <tr><td className="info-label">Favorites</td><td>{infoAddon.favorites.toLocaleString()}</td></tr>
                    {infoAddon.compatibility.length > 0 && (
                      <tr><td className="info-label">Compatible</td><td>{infoAddon.compatibility.map(c => `${c.name} (${c.version})`).join(', ')}</td></tr>
                    )}
                    <tr><td className="info-label">Directories</td><td>{infoAddon.directories.join(', ')}</td></tr>
                    {infoAddon.donationLink && (
                      <tr><td className="info-label">Donation</td><td>
                        <a className="online-link" href={infoAddon.donationLink} onClick={(e) => { e.preventDefault(); window.electronAPI.openExternalUrl(infoAddon.donationLink); }}>Link</a>
                      </td></tr>
                    )}
                    <tr><td className="info-label">Page</td><td>
                      <a className="online-link" href={infoAddon.infoUrl} onClick={(e) => { e.preventDefault(); window.electronAPI.openExternalUrl(infoAddon.infoUrl); }}>{infoAddon.infoUrl}</a>
                    </td></tr>
                    {localAddon && (
                      <>
                        <tr><td className="info-label" colSpan={2} style={{ paddingTop: '10px', fontWeight: 700, opacity: 0.7 }}>— Local Info —</td></tr>
                        {localAddon.description && <tr><td className="info-label">Description</td><td style={{ whiteSpace: 'pre-wrap' }}><RichText text={localAddon.description} /></td></tr>}
                        {localAddon.apiVersion && <tr><td className="info-label">API Version</td><td>{localAddon.apiVersion}</td></tr>}
                        {localAddon.dependsOn.length > 0 && <tr><td className="info-label">Dependencies</td><td>{localAddon.dependsOn.map(d => d.name).join(', ')}</td></tr>}
                        {localAddon.savedVariables.length > 0 && <tr><td className="info-label">SavedVars</td><td>{localAddon.savedVariables.join(', ')}</td></tr>}
                      </>
                    )}
                    {isLoading && (
                      <tr><td colSpan={2} style={{ opacity: 0.6 }}>Loading online details…</td></tr>
                    )}
                    {details?.description && (
                      <tr><td className="info-label">Online Description</td><td style={{ whiteSpace: 'pre-wrap' }}><RichText text={details.description} /></td></tr>
                    )}
                    {details?.changeLog && (
                      <tr><td className="info-label">ChangeLog</td><td style={{ whiteSpace: 'pre-wrap' }}><RichText text={details.changeLog} /></td></tr>
                    )}
                    {details?.md5 && (
                      <tr><td className="info-label">MD5</td><td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{details.md5}</td></tr>
                    )}
                    {details?.fileName && (
                      <tr><td className="info-label">File</td><td>{details.fileName}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default OnlineBrowser;
