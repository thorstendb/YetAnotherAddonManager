// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { AddonInfo, CatalogAddon, CharacterSettings, ADDON_CATEGORIES, getCategoryIconUrl } from '../../electron/shared/types';
import ColoredText from './ColoredText';
import RichText, { stripBBCode } from './RichText';
import ImagePreview from './ImagePreview';
import { shortenCharName } from '../App';

interface AddonTreeItemProps {
  addon: AddonInfo;
  isSelected: boolean;
  onSelect: (folderName: string) => void;
  isUnreferenced?: boolean;
  isNotInCatalog?: boolean;
  isCatalogMismatch?: boolean;
  referencedBy?: string[];
  characterSettings?: CharacterSettings;
  hasSavedVars?: boolean;
  catalogAddon?: CatalogAddon;
  isInstalling?: boolean;
  knownAddonNames?: Set<string>;
  catalogByDir?: Map<string, CatalogAddon>;
  installingAddonId?: string | null;
  onNavigate: (folderName: string) => void;
  onContextMenu: (e: React.MouseEvent, addon: AddonInfo) => void;
  onToggleCharSetting?: (addonName: string, character: string, enabled: boolean) => void;
  onDelete?: (folderName: string) => void;
  onDeleteWithSV?: (folderName: string) => void;
  onDeleteAndRefs?: (folderName: string) => void;
  onDeleteAndRefsWithSV?: (folderName: string) => void;
  onInstall?: (catalogAddon: CatalogAddon) => void;
  onNavigateCatalog?: (addonId: string) => void;
  installProgress?: Record<string, { phase: string; percent?: number; current?: number; total?: number }>;
  collapseAllCounter?: number;
  hasUpdate?: boolean;
}

const AddonTreeItem: React.FC<AddonTreeItemProps> = ({
  addon,
  isSelected,
  onSelect,
  isUnreferenced = false,
  isNotInCatalog = false,
  isCatalogMismatch = false,
  referencedBy = [],
  characterSettings,
  hasSavedVars = false,
  catalogAddon,
  isInstalling = false,
  knownAddonNames,
  catalogByDir,
  installingAddonId,
  onNavigate,
  onContextMenu,
  onToggleCharSetting,
  onDelete,
  onDeleteWithSV,
  onDeleteAndRefs,
  onDeleteAndRefsWithSV,
  onInstall,
  onNavigateCatalog,
  installProgress,
  collapseAllCounter = 0,
  hasUpdate = false,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [subAddonsExpanded, setSubAddonsExpanded] = useState(false);
  const [deletePopupOpen, setDeletePopupOpen] = useState(false);
  const deletePopupRef = useRef<HTMLDivElement>(null);
  const [expandedSubAddons, setExpandedSubAddons] = useState<Set<string>>(new Set());
  const [expandedSubDeps, setExpandedSubDeps] = useState<Set<string>>(new Set());
  const [expandedSubOptDeps, setExpandedSubOptDeps] = useState<Set<string>>(new Set());
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [optDepsExpanded, setOptDepsExpanded] = useState(false);
  const [refsExpanded, setRefsExpanded] = useState(false);
  const [charsExpanded, setCharsExpanded] = useState(false);
  const [catalogExpanded, setCatalogExpanded] = useState(false);
  const [catalogPopup, setCatalogPopup] = useState(false);
  const catalogPopupRef = useRef<HTMLDivElement>(null);
  const [catalogDetails, setCatalogDetails] = useState<{ description: string; changeLog: string; md5: string; downloadUrl: string; fileName: string } | null>(null);
  const [catalogDetailsLoading, setCatalogDetailsLoading] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [catalogDescExpanded, setCatalogDescExpanded] = useState(false);
  const [subDescExpanded, setSubDescExpanded] = useState<Set<string>>(new Set());
  const [infoPopup, setInfoPopup] = useState(false);
  const infoPopupRef = useRef<HTMLDivElement>(null);

  // Collapse all when counter changes (triggered by parent's collapse-all button)
  useEffect(() => {
    if (collapseAllCounter === 0) return;
    setExpanded(false);
    setSubAddonsExpanded(false);
    setExpandedSubAddons(new Set());
    setExpandedSubDeps(new Set());
    setExpandedSubOptDeps(new Set());
    setDepsExpanded(false);
    setOptDepsExpanded(false);
    setRefsExpanded(false);
    setCharsExpanded(false);
    setCatalogExpanded(false);
    setDescExpanded(false);
    setCatalogDescExpanded(false);
    setSubDescExpanded(new Set());
  }, [collapseAllCounter]);

  const toggleSubAddon = (name: string) =>
    setExpandedSubAddons((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  const toggleSubDeps = (name: string) =>
    setExpandedSubDeps((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  const toggleSubOptDeps = (name: string) =>
    setExpandedSubOptDeps((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const hasSubAddons = addon.subAddons && addon.subAddons.length > 0;
  const hasDeps = addon.dependsOn.length > 0 || addon.optionalDependsOn.length > 0;
  const hasRefBy = referencedBy.length > 0;
  const hasChars = characterSettings && Object.keys(characterSettings).length > 0;
  const hasDetails = hasSubAddons || hasDeps || hasRefBy || hasChars
    || addon.author || addon.version || addon.description
    || addon.apiVersion || addon.contributors
    || addon.savedVariables.length > 0 || addon.files.length > 0
    || !!catalogAddon;

  const handleClick = () => {
    onSelect(addon.folderName);
    if (hasDetails) {
      setExpanded((prev) => !prev);
    }
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    onSelect(addon.folderName);
    onContextMenu(e, addon);
  };

  const icon = addon.isLibrary ? '📚' : '🧩';
  const hasCatIcon = !!catalogAddon?.categoryId;

  // Tristate checkbox logic
  const charEntries = characterSettings ? Object.entries(characterSettings) : [];
  const enabledCount = charEntries.filter(([, v]) => v).length;
  const totalChars = charEntries.length;
  const allEnabled = totalChars > 0 && enabledCount === totalChars;
  const noneEnabled = enabledCount === 0;
  const isIndeterminate = totalChars > 0 && !allEnabled && !noneEnabled;

  // Remember the mixed (per-character) state so we can restore it
  const savedMixedState = useRef<Record<string, boolean> | null>(null);

  // Close delete popup on outside click or Escape
  useEffect(() => {
    if (!deletePopupOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (deletePopupRef.current && !deletePopupRef.current.contains(e.target as Node)) {
        setDeletePopupOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDeletePopupOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [deletePopupOpen]);

  // When settings are naturally mixed, keep a snapshot
  useEffect(() => {
    if (isIndeterminate && characterSettings) {
      savedMixedState.current = { ...characterSettings };
    }
  }, [isIndeterminate, characterSettings]);

  // Close catalog popup on outside click or Escape
  useEffect(() => {
    if (!catalogPopup) return;
    const handleClick = (e: MouseEvent) => {
      if (catalogPopupRef.current && !catalogPopupRef.current.contains(e.target as Node)) {
        setCatalogPopup(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCatalogPopup(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [catalogPopup]);

  // Close info popup on outside click or Escape
  useEffect(() => {
    if (!infoPopup) return;
    const handleClick = (e: MouseEvent) => {
      if (infoPopupRef.current && !infoPopupRef.current.contains(e.target as Node)) {
        setInfoPopup(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInfoPopup(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [infoPopup]);

  // Fetch catalog details on demand when catalog expanded or info popup opened
  useEffect(() => {
    if ((!catalogExpanded && !infoPopup) || !catalogAddon || catalogDetails || catalogDetailsLoading) return;
    setCatalogDetailsLoading(true);
    window.electronAPI.fetchAddonDetails(catalogAddon.id)
      .then(setCatalogDetails)
      .finally(() => setCatalogDetailsLoading(false));
  }, [catalogExpanded, infoPopup, catalogAddon, catalogDetails, catalogDetailsLoading]);

  const handleTriCheckClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onToggleCharSetting || totalChars === 0) return;

    if (noneEnabled) {
      // unchecked → checked (enable all)
      for (const [charName] of charEntries) {
        onToggleCharSetting(addon.folderName, charName, true);
      }
    } else if (allEnabled) {
      // checked → mixed (restore saved) or unchecked if no saved mixed state
      if (savedMixedState.current) {
        for (const [charName, wasEnabled] of Object.entries(savedMixedState.current)) {
          onToggleCharSetting(addon.folderName, charName, wasEnabled);
        }
      } else {
        // No previous mixed state → go to unchecked
        for (const [charName] of charEntries) {
          onToggleCharSetting(addon.folderName, charName, false);
        }
      }
    } else {
      // mixed → unchecked (disable all)
      for (const [charName] of charEntries) {
        onToggleCharSetting(addon.folderName, charName, false);
      }
    }
  }, [onToggleCharSetting, allEnabled, noneEnabled, charEntries, addon.folderName, totalChars]);

  return (
    <div className="tree-item">
      <div
        className={`tree-item-row ${isSelected ? 'selected' : ''}`}
        onClick={handleClick}
        onContextMenu={handleRightClick}
      >
        <span className={`tree-chevron ${expanded ? 'expanded' : ''} ${!hasDetails ? 'hidden' : ''}`}>
          ▶
        </span>
        {totalChars > 0 && (
          <span
            className={`tree-tri-check ${allEnabled ? 'checked' : isIndeterminate ? 'indeterminate' : ''}`}
            onClick={handleTriCheckClick}
            role="checkbox"
            aria-checked={allEnabled ? 'true' : isIndeterminate ? 'mixed' : 'false'}
            aria-label="Toggle addon for all characters"
            title={allEnabled ? 'Enabled for all characters' : noneEnabled ? 'Disabled for all characters' : `Enabled for ${enabledCount}/${totalChars} characters`}
          />
        )}
        {hasCatIcon ? (
          <img
            className="tree-cat-icon"
            src={getCategoryIconUrl(catalogAddon!.categoryId)}
            alt=""
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span className="tree-icon">{icon}</span>
        )}
        <span className={`tree-label ${isUnreferenced ? 'unreferenced' : ''} ${isNotInCatalog ? 'not-in-catalog' : ''}`}>
          <ColoredText segments={addon.titleSegments} />
          {addon.version && <span className="tree-version"> v{addon.version}</span>}
          {isUnreferenced && <span className="unreferenced-marker">{' \u26A0\uFE0E (unused)'}</span>}
          {isNotInCatalog && <span className="catalog-missing" title="Not found in catalog and no download URL">{' \u26A0\uFE0E'}</span>}
          {isCatalogMismatch && <span className="catalog-mismatch" title={`Folder "${addon.folderName}" does not match catalog directory — matched by title`}>{' \u26A0\uFE0E'}</span>}
        </span>
        <span className="tree-row-actions">
          <button
            className="row-btn"
            onClick={(e) => { e.stopPropagation(); setInfoPopup(true); }}
            title="Show addon details"
          >
            ℹ️
          </button>
          {catalogAddon && onInstall && (
            <button
              className="row-btn row-btn-install"
              onClick={(e) => { e.stopPropagation(); onInstall(catalogAddon); }}
              disabled={isInstalling}
              title={hasUpdate ? 'Update to catalog version' : 'Reinstall'}
            >
              {isInstalling ? '⏳' : hasUpdate ? '⬆️' : '🔄'}
            </button>
          )}
          {onDelete && (
            <div className="row-btn-delete-wrapper" ref={deletePopupRef}>
              <button
                className="row-btn row-btn-delete"
                onClick={(e) => { e.stopPropagation(); setDeletePopupOpen((prev) => !prev); }}
                title="Delete addon"
              >
                🗑️
              </button>
              {deletePopupOpen && (
                <div className="delete-popup" onClick={(e) => e.stopPropagation()}>
                  <div
                    className="delete-popup-item danger"
                    onClick={() => { setDeletePopupOpen(false); onDelete(addon.folderName); }}
                  >
                    Delete
                  </div>
                  {hasSavedVars && onDeleteWithSV && (
                    <div
                      className="delete-popup-item danger"
                      onClick={() => { setDeletePopupOpen(false); onDeleteWithSV(addon.folderName); }}
                    >
                      Delete + SavedVariables
                    </div>
                  )}
                  {onDeleteAndRefs && (
                    <div
                      className="delete-popup-item danger"
                      onClick={() => { setDeletePopupOpen(false); onDeleteAndRefs(addon.folderName); }}
                    >
                      Delete + exclusive refs
                    </div>
                  )}
                  {hasSavedVars && onDeleteAndRefsWithSV && (
                    <div
                      className="delete-popup-item danger"
                      onClick={() => { setDeletePopupOpen(false); onDeleteAndRefsWithSV(addon.folderName); }}
                    >
                      Delete + refs + SavedVariables
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </span>
      </div>
      {isInstalling && (() => {
        const progress = installProgress?.[catalogAddon?.id || ''];
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
      {expanded && hasDetails && (
        <div className="tree-children">
          {/* JSON record button – always visible */}
          <div className="tree-detail" style={{ position: 'relative' }}>
            <button
              style={{ fontSize: '11px', padding: '1px 6px', background: 'none', border: 'none', cursor: 'pointer', borderRadius: '3px', opacity: 0.6, color: '#ccc' }}
              onClick={(e) => { e.stopPropagation(); setCatalogPopup(p => !p); }}
              title="Show raw JSON data"
            >
              📋 JSON
            </button>
            {catalogPopup && (
              <div ref={catalogPopupRef} className="catalog-json-popup" onClick={(e) => e.stopPropagation()}>
                <div className="catalog-json-header">
                  <span>JSON — {addon.title || addon.folderName}</span>
                  <button className="restore-close-btn" onClick={() => setCatalogPopup(false)} title="Close">✕</button>
                </div>
                <pre className="catalog-json-content">{JSON.stringify({ local: addon, ...(catalogAddon ? { catalog: catalogAddon } : {}) }, null, 2)}</pre>
              </div>
            )}
          </div>

          {/* Sub-addons – shown as first children */}
          {hasSubAddons && (
            <div className="tree-item">
              <div
                className="tree-subtree-row"
                onClick={(e) => { e.stopPropagation(); setSubAddonsExpanded((p) => !p); }}
              >
                <span className={`tree-chevron ${subAddonsExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="detail-label">Sub-Addons</span>
                <span className="tree-badge-small">{addon.subAddons.length}</span>
              </div>
              {subAddonsExpanded && (
                <div className="tree-children">
                  {addon.subAddons
                    .slice()
                    .sort((a, b) => a.title.localeCompare(b.title))
                    .map((sub) => {
                      const subExpanded = expandedSubAddons.has(sub.folderName);
                      const subHasDeps = sub.dependsOn.length > 0;
                      const subHasOptDeps = sub.optionalDependsOn.length > 0;
                      const subHasDetails = !!(sub.version || sub.author || sub.description || subHasDeps || subHasOptDeps || sub.savedVariables.length > 0);
                      return (
                    <div key={sub.folderName} className="tree-item sub-addon-item">
                      <div
                        className="tree-subtree-row sub-addon-row"
                        onClick={(e) => { e.stopPropagation(); toggleSubAddon(sub.folderName); }}
                      >
                        <span className={`tree-chevron ${subExpanded ? 'expanded' : ''} ${!subHasDetails ? 'hidden' : ''}`}>▶</span>
                        <span className="tree-icon">{sub.isLibrary ? '📚' : '🧩'}</span>
                        <span className="sub-addon-name">
                          <ColoredText segments={sub.titleSegments} />
                          {sub.version && <span className="tree-version"> v{sub.version}</span>}
                        </span>
                        {sub.dependsOn.length > 0 && (
                          <span className="sub-addon-badge" title={`Deps: ${sub.dependsOn.map(d => d.name).join(', ')}`}>
                            {sub.dependsOn.length} dep{sub.dependsOn.length !== 1 ? 's' : ''}
                          </span>
                        )}
                        {sub.savedVariables.length > 0 && (
                          <span className="sub-addon-sv" title={`SavedVars: ${sub.savedVariables.join(', ')}`}> 💾</span>
                        )}
                      </div>
                      {subExpanded && subHasDetails && (
                        <div className="tree-children">
                          {/* Sub-addon author */}
                          {sub.author && (
                            <div className="tree-detail">
                              <span className="detail-label">Author:</span>{' '}
                              <ColoredText segments={sub.authorSegments} />
                            </div>
                          )}
                          {/* Sub-addon description */}
                          {sub.description && (
                            <div
                              className={`tree-detail desc-expandable ${subDescExpanded.has(sub.folderName) ? 'desc-expanded' : ''}`}
                              onClick={(e) => { e.stopPropagation(); setSubDescExpanded(prev => { const s = new Set(prev); if (s.has(sub.folderName)) s.delete(sub.folderName); else s.add(sub.folderName); return s; }); }}
                              title={subDescExpanded.has(sub.folderName) ? 'Click to collapse' : 'Click to expand'}
                            >
                              <span className="detail-label"><span className="desc-chevron">{subDescExpanded.has(sub.folderName) ? '▼' : '▶'}</span>Description:</span>{' '}
                              {subDescExpanded.has(sub.folderName) ? <RichText text={sub.description} /> : stripBBCode(sub.description)}
                            </div>
                          )}
                          {/* Sub-addon version detail */}
                          {sub.version ? (
                            <div className="tree-detail">
                              <span className="detail-label">Version:</span> {sub.version}
                              {sub.addonVersion ? ` (${sub.addonVersion})` : ''}
                            </div>
                          ) : null}
                          {/* Sub-addon API */}
                          {sub.apiVersion && (
                            <div className="tree-detail">
                              <span className="detail-label">API:</span> {sub.apiVersion}
                            </div>
                          )}
                          {/* Sub-addon dependencies */}
                          {subHasDeps && (
                            <div className="tree-item">
                              <div
                                className="tree-subtree-row"
                                onClick={(e) => { e.stopPropagation(); toggleSubDeps(sub.folderName); }}
                              >
                                <span className={`tree-chevron ${expandedSubDeps.has(sub.folderName) ? 'expanded' : ''}`}>▶</span>
                                <span className="detail-label">Dependencies</span>
                                <span className="tree-badge-small">{sub.dependsOn.length}</span>
                              </div>
                              {expandedSubDeps.has(sub.folderName) && (
                                <div className="tree-children">
                                  {sub.dependsOn.map((dep, i) => {
                                    const isDepInstalled = knownAddonNames && knownAddonNames.has(dep.name);
                                    const depCatalog = catalogByDir?.get(dep.name);
                                    return (
                                      <div key={i} className={`tree-subtree-leaf ${!isDepInstalled ? 'dep-missing' : ''}`}>
                                        <span className="tree-leaf-icon">{!isDepInstalled ? '❌' : '📎'}</span>
                                        <span className="dep-link" onClick={(e) => { e.stopPropagation(); onNavigate(dep.name); }}>
                                          {dep.name}
                                        </span>
                                        {dep.minVersion !== undefined && <span className="dep-version">≥{dep.minVersion}</span>}
                                        {!isDepInstalled && <span className="dep-not-installed">not installed</span>}
                                        <span className="dep-actions">
                                          {depCatalog && onInstall && (
                                            <button
                                              className="row-btn row-btn-install dep-btn"
                                              onClick={(e) => { e.stopPropagation(); onInstall(depCatalog); }}
                                              disabled={installingAddonId === depCatalog.id}
                                              title={isDepInstalled ? 'Reinstall' : 'Install'}
                                            >
                                              {installingAddonId === depCatalog.id ? '⏳' : isDepInstalled ? '🔄' : '➕'}
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
                          {/* Sub-addon optional dependencies */}
                          {subHasOptDeps && (
                            <div className="tree-item">
                              <div
                                className="tree-subtree-row"
                                onClick={(e) => { e.stopPropagation(); toggleSubOptDeps(sub.folderName); }}
                              >
                                <span className={`tree-chevron ${expandedSubOptDeps.has(sub.folderName) ? 'expanded' : ''}`}>▶</span>
                                <span className="detail-label">Optional</span>
                                <span className="tree-badge-small">{sub.optionalDependsOn.length}</span>
                              </div>
                              {expandedSubOptDeps.has(sub.folderName) && (
                                <div className="tree-children">
                                  {sub.optionalDependsOn.map((dep, i) => {
                                    const isDepInstalled = knownAddonNames && knownAddonNames.has(dep.name);
                                    const depCatalog = catalogByDir?.get(dep.name);
                                    return (
                                      <div key={i} className={`tree-subtree-leaf ${!isDepInstalled ? 'dep-missing' : ''}`}>
                                        <span className="tree-leaf-icon">{!isDepInstalled ? '❌' : '📎'}</span>
                                        <span className="dep-link" onClick={(e) => { e.stopPropagation(); onNavigate(dep.name); }}>
                                          {dep.name}
                                        </span>
                                        {dep.minVersion !== undefined && <span className="dep-version">≥{dep.minVersion}</span>}
                                        {!isDepInstalled && <span className="dep-not-installed">not installed</span>}
                                        <span className="dep-actions">
                                          {depCatalog && onInstall && (
                                            <button
                                              className="row-btn row-btn-install dep-btn"
                                              onClick={(e) => { e.stopPropagation(); onInstall(depCatalog); }}
                                              disabled={installingAddonId === depCatalog.id}
                                              title={isDepInstalled ? 'Reinstall' : 'Install'}
                                            >
                                              {installingAddonId === depCatalog.id ? '⏳' : isDepInstalled ? '🔄' : '➕'}
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
                          {/* Sub-addon saved vars */}
                          {sub.savedVariables.length > 0 && (
                            <div className="tree-detail">
                              <span className="detail-label">SavedVars:</span>{' '}
                              {sub.savedVariables.join(', ')}
                            </div>
                          )}
                          {/* Sub-addon files */}
                          {sub.files.length > 0 && (
                            <div className="tree-detail">
                              <span className="detail-label">Files:</span> {sub.files.length} file(s)
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* Image preview */}
          {catalogAddon && catalogAddon.thumbnails.length > 0 && (
            <ImagePreview thumbnails={catalogAddon.thumbnails} images={catalogAddon.images} />
          )}

          {/* Author */}
          {addon.author && (
            <div className="tree-detail">
              <span className="detail-label">Author:</span>{' '}
              <ColoredText segments={addon.authorSegments} />
            </div>
          )}
          {/* Description — expandable */}
          {addon.description && (
            <div
              className={`tree-detail desc-expandable ${descExpanded ? 'desc-expanded' : ''}`}
              onClick={(e) => { e.stopPropagation(); setDescExpanded(p => !p); }}
              title={descExpanded ? 'Click to collapse' : 'Click to expand'}
            >
              <span className="detail-label"><span className="desc-chevron">{descExpanded ? '▼' : '▶'}</span>Description:</span>{' '}
              {descExpanded ? <RichText text={addon.description} /> : stripBBCode(addon.description)}
            </div>
          )}
          {/* Contributors */}
          {addon.contributors && (
            <div className="tree-detail">
              <span className="detail-label">Contributors:</span>{' '}
              <ColoredText segments={addon.contributorsSegments} />
            </div>
          )}

          {/* Category (catalog) */}
          {catalogAddon && (
            <div className="tree-detail">
              <span className="detail-label">Category:</span> {ADDON_CATEGORIES[catalogAddon.categoryId] || `Cat ${catalogAddon.categoryId}`}
            </div>
          )}

          {/* Version */}
          {addon.version ? (
            <div className="tree-detail">
              <span className="detail-label">Version:</span> {addon.version}
              {addon.addonVersion ? ` (${addon.addonVersion})` : ''}
            </div>
          ) : null}
          {/* API */}
          {addon.apiVersion && (
            <div className="tree-detail">
              <span className="detail-label">API:</span> {addon.apiVersion}
            </div>
          )}

          {/* Updated (catalog) */}
          {catalogAddon && (
            <div className="tree-detail">
              <span className="detail-label">Updated:</span> {new Date(catalogAddon.date * 1000).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })}
            </div>
          )}
          {/* Downloads (catalog) */}
          {catalogAddon && (
            <div className="tree-detail">
              <span className="detail-label">Downloads:</span> {catalogAddon.totalDownloads.toLocaleString()} total / {catalogAddon.monthlyDownloads.toLocaleString()} monthly
            </div>
          )}
          {/* Favorites (catalog) */}
          {catalogAddon && (
            <div className="tree-detail">
              <span className="detail-label">Favorites:</span> {catalogAddon.favorites.toLocaleString()}
            </div>
          )}
          {/* Compatible (catalog) */}
          {catalogAddon && catalogAddon.compatibility.length > 0 && (
            <div className="tree-detail">
              <span className="detail-label">Compatible:</span>{' '}
              {catalogAddon.compatibility.slice(0, 3).map((c) => c.name).join(', ')}
              {catalogAddon.compatibility.length > 3 && ` +${catalogAddon.compatibility.length - 3} more`}
            </div>
          )}
          {/* Dirs (catalog) */}
          {catalogAddon && catalogAddon.directories.length > 0 && (
            <div className="tree-detail">
              <span className="detail-label">Dirs:</span> {catalogAddon.directories.join(', ')}
            </div>
          )}

          {/* Depends on - expandable subtree */}
          {addon.dependsOn.length > 0 && (
            <div className="tree-item">
              <div
                className="tree-subtree-row"
                onClick={(e) => { e.stopPropagation(); setDepsExpanded((p) => !p); }}
              >
                <span className={`tree-chevron ${depsExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="detail-label">Dependencies</span>
                <span className="tree-badge-small">{addon.dependsOn.length}</span>
              </div>
              {depsExpanded && (
                <div className="tree-children">
                  {addon.dependsOn.map((dep, i) => {
                    const isDepInstalled = knownAddonNames && knownAddonNames.has(dep.name);
                    const depCatalog = catalogByDir?.get(dep.name);
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
                        {depCatalog && onInstall && (
                          <button
                            className="row-btn row-btn-install dep-btn"
                            onClick={(e) => { e.stopPropagation(); onInstall(depCatalog); }}
                            disabled={installingAddonId === depCatalog.id}
                            title={isDepInstalled ? 'Reinstall' : 'Install'}
                          >
                            {installingAddonId === depCatalog.id ? '⏳' : isDepInstalled ? '🔄' : '➕'}
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

          {/* Optional deps - expandable subtree */}
          {addon.optionalDependsOn.length > 0 && (
            <div className="tree-item">
              <div
                className="tree-subtree-row"
                onClick={(e) => { e.stopPropagation(); setOptDepsExpanded((p) => !p); }}
              >
                <span className={`tree-chevron ${optDepsExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="detail-label">Optional</span>
                <span className="tree-badge-small">{addon.optionalDependsOn.length}</span>
              </div>
              {optDepsExpanded && (
                <div className="tree-children">
                  {addon.optionalDependsOn.map((dep, i) => {
                    const isDepInstalled = knownAddonNames && knownAddonNames.has(dep.name);
                    const depCatalog = catalogByDir?.get(dep.name);
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
                        {depCatalog && onInstall && (
                          <button
                            className="row-btn row-btn-install dep-btn"
                            onClick={(e) => { e.stopPropagation(); onInstall(depCatalog); }}
                            disabled={installingAddonId === depCatalog.id}
                            title={isDepInstalled ? 'Reinstall' : 'Install'}
                          >
                            {installingAddonId === depCatalog.id ? '⏳' : isDepInstalled ? '🔄' : '➕'}
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

          {/* Referenced by - expandable subtree */}
          {hasRefBy && (
            <div className="tree-item">
              <div
                className="tree-subtree-row"
                onClick={(e) => { e.stopPropagation(); setRefsExpanded((p) => !p); }}
              >
                <span className={`tree-chevron ${refsExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="detail-label">Referenced by</span>
                <span className="tree-badge-small">{referencedBy.length}</span>
              </div>
              {refsExpanded && (
                <div className="tree-children">
                  {referencedBy.map((refName, i) => {
                    const refCatalog = catalogByDir?.get(refName);
                    return (
                    <div key={i} className="tree-subtree-leaf">
                      <span className="tree-leaf-icon">🔗</span>
                      <span
                        className="dep-link"
                        onClick={(e) => { e.stopPropagation(); onNavigate(refName); }}
                      >
                        {refName}
                      </span>
                      <span className="dep-actions">
                        {refCatalog && onInstall && (
                          <button
                            className="row-btn row-btn-install dep-btn"
                            onClick={(e) => { e.stopPropagation(); onInstall(refCatalog); }}
                            disabled={installingAddonId === refCatalog.id}
                            title="Reinstall"
                          >
                            {installingAddonId === refCatalog.id ? '⏳' : '🔄'}
                          </button>
                        )}
                        {onDelete && (
                          <button
                            className="row-btn row-btn-delete dep-btn"
                            onClick={(e) => { e.stopPropagation(); onDelete(refName); }}
                            title="Delete addon"
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

          {/* Character settings - expandable subtree */}
          {hasChars && (
            <div className="tree-item">
              <div
                className="tree-subtree-row"
                onClick={(e) => { e.stopPropagation(); setCharsExpanded((p) => !p); }}
              >
                <span className={`tree-chevron ${charsExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="detail-label">Characters</span>
                <span className="tree-badge-small">{Object.keys(characterSettings).length}</span>
              </div>
              {charsExpanded && (
                <div className="tree-children">
                  {Object.entries(characterSettings)
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
                              onToggleCharSetting?.(addon.folderName, charName, e.target.checked);
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

          {/* ESOUI Catalog Entry - expandable */}
          {catalogAddon && (
            <div className="tree-item">
              <div
                className="tree-subtree-row"
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={(e) => { e.stopPropagation(); setCatalogExpanded((p) => !p); }}
              >
                <span className={`tree-chevron ${catalogExpanded ? 'expanded' : ''}`}>▶</span>
                <span className="detail-label">ESOUI Catalog Entry</span>
              </div>
              {catalogExpanded && (
                <div className="tree-children">
                  <div className="tree-detail"><span className="detail-label">ID:</span> {catalogAddon.id}</div>
                  <div className="tree-detail"><span className="detail-label">Name:</span> {catalogAddon.name}</div>
                  <div className="tree-detail"><span className="detail-label">Version:</span> {catalogAddon.version}</div>
                  <div className="tree-detail"><span className="detail-label">Author:</span> {catalogAddon.author}</div>
                  <div className="tree-detail"><span className="detail-label">Category:</span> {ADDON_CATEGORIES[catalogAddon.categoryId] || `Cat ${catalogAddon.categoryId}`}</div>
                  <div className="tree-detail"><span className="detail-label">Updated:</span> {new Date(catalogAddon.date * 1000).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
                  <div className="tree-detail"><span className="detail-label">Downloads:</span> {catalogAddon.totalDownloads.toLocaleString()} total / {catalogAddon.monthlyDownloads.toLocaleString()} monthly</div>
                  <div className="tree-detail"><span className="detail-label">Favorites:</span> {catalogAddon.favorites.toLocaleString()}</div>
                  <div className="tree-detail"><span className="detail-label">Dirs:</span> {catalogAddon.directories.join(', ')}</div>
                  {catalogAddon.compatibility.length > 0 && (
                    <div className="tree-detail"><span className="detail-label">Compatible:</span> {catalogAddon.compatibility.map(c => `${c.name} (${c.version})`).join(', ')}</div>
                  )}
                  {catalogAddon.donationLink && (
                    <div className="tree-detail"><span className="detail-label">Donation:</span>{' '}
                      <a className="online-link" href={catalogAddon.donationLink} onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.electronAPI.openExternalUrl(catalogAddon.donationLink); }}>Link</a>
                    </div>
                  )}
                  {catalogDetailsLoading && (
                    <div className="tree-detail" style={{ opacity: 0.6 }}>Loading details…</div>
                  )}
                  {catalogDetails?.description && (
                    <div
                      className={`tree-detail desc-expandable ${catalogDescExpanded ? 'desc-expanded' : ''}`}
                      onClick={(e) => { e.stopPropagation(); setCatalogDescExpanded(p => !p); }}
                      title={catalogDescExpanded ? 'Click to collapse' : 'Click to expand'}
                    >
                      <span className="detail-label"><span className="desc-chevron">{catalogDescExpanded ? '▼' : '▶'}</span>Description:</span>{' '}
                      {catalogDescExpanded ? <RichText text={catalogDetails.description} /> : stripBBCode(catalogDetails.description)}
                    </div>
                  )}
                  {catalogDetails?.changeLog && (
                    <div className="tree-detail"><span className="detail-label">ChangeLog:</span>{' '}
                      <span style={{ whiteSpace: 'pre-wrap', opacity: 0.8 }}><RichText text={catalogDetails.changeLog} /></span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* SavedVars */}
          {addon.savedVariables.length > 0 && (
            <div className="tree-detail">
              <span className="detail-label">SavedVars:</span>{' '}
              {addon.savedVariables.join(', ')}
              {hasSavedVars && <span className="saved-vars-indicator" title="Has SavedVariables files on disk"> 💾</span>}
            </div>
          )}
          {/* Files */}
          {addon.files.length > 0 && (
            <div className="tree-detail">
              <span className="detail-label">Files:</span> {addon.files.length} file(s)
            </div>
          )}
          {/* URL (only when no catalog match) */}
          {addon.downloadUrl && !catalogAddon && (
            <div className="tree-detail">
              <span className="detail-label">URL:</span>{' '}
              <a
                className="online-link"
                href={addon.downloadUrl}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(addon.downloadUrl, '_blank'); }}
                title={addon.downloadUrl}
              >
                {addon.downloadUrl}
              </a>
            </div>
          )}

          {/* Links row at bottom */}
          {catalogAddon && (
            <div className="tree-detail catalog-links">
              {onNavigateCatalog && (
                <span
                  className="dep-link"
                  onClick={(e) => { e.stopPropagation(); onNavigateCatalog(catalogAddon.id); }}
                  title="Go to this addon in the Online Browse tree"
                >
                  🌐 Go to catalog
                </span>
              )}
              <a
                className="online-link"
                href={catalogAddon.infoUrl}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  window.electronAPI.openExternalUrl(catalogAddon.infoUrl);
                }}
                title="Open addon page in browser"
              >
                🔗 Addon Page
              </a>
            </div>
          )}
        </div>
      )}

      {/* Info popup — shows all collected information */}
      {infoPopup && (
        <div className="unsaved-overlay" onClick={(e) => { e.stopPropagation(); setInfoPopup(false); }}>
          <div ref={infoPopupRef} className="addon-info-popup" onClick={(e) => e.stopPropagation()}>
            <div className="catalog-json-header">
              <span>ℹ️ {addon.title || addon.folderName}</span>
              <button className="restore-close-btn" onClick={() => setInfoPopup(false)} title="Close">✕</button>
            </div>
            <div className="addon-info-actions">
              {catalogAddon && onInstall && (
                  <button className="info-action-btn" onClick={() => { setInfoPopup(false); onInstall(catalogAddon); }} disabled={isInstalling} title={hasUpdate ? 'Update to catalog version' : 'Reinstall from catalog'}>
                    {isInstalling ? '⏳' : hasUpdate ? '⬆️' : '🔄'} {hasUpdate ? 'Update' : 'Reinstall'}
                  </button>
              )}
              {onDelete && (
                <button className="info-action-btn danger" onClick={() => { setInfoPopup(false); onDelete(addon.folderName); }} title="Delete addon">
                  🗑️ Delete
                </button>
              )}
              {hasSavedVars && onDeleteWithSV && (
                <button className="info-action-btn danger" onClick={() => { setInfoPopup(false); onDeleteWithSV(addon.folderName); }} title="Delete addon and its SavedVariables">
                  🗑️ + SavedVars
                </button>
              )}
              {onDeleteAndRefs && (
                <button className="info-action-btn danger" onClick={() => { setInfoPopup(false); onDeleteAndRefs(addon.folderName); }} title="Delete addon and exclusive library references">
                  🗑️ + Refs
                </button>
              )}
              {catalogAddon?.infoUrl && (
                <button className="info-action-btn" onClick={() => window.electronAPI.openExternalUrl(catalogAddon.infoUrl)} title="Open ESOUI page">
                  🌐 ESOUI
                </button>
              )}
            </div>
            <div className="addon-info-content">
              <table className="addon-info-table">
                <tbody>
                  <tr><td className="info-label">Folder</td><td>{addon.folderName}</td></tr>
                  {addon.title && <tr><td className="info-label">Title</td><td>{addon.title}</td></tr>}
                  {addon.author && <tr><td className="info-label">Author</td><td><ColoredText segments={addon.authorSegments} /></td></tr>}
                  {addon.version && <tr><td className="info-label">Version</td><td>{addon.version}{addon.addonVersion ? ` (${addon.addonVersion})` : ''}</td></tr>}
                  {addon.apiVersion && <tr><td className="info-label">API Version</td><td>{addon.apiVersion}</td></tr>}
                  {addon.description && <tr><td className="info-label">Description</td><td style={{ whiteSpace: 'pre-wrap' }}><RichText text={addon.description} /></td></tr>}
                  {addon.contributors && <tr><td className="info-label">Contributors</td><td><ColoredText segments={addon.contributorsSegments} /></td></tr>}
                  {catalogAddon && (
                    <>
                      <tr><td className="info-label" colSpan={2} style={{ paddingTop: '10px', fontWeight: 700, opacity: 0.7 }}>— ESOUI Catalog —</td></tr>
                      <tr><td className="info-label">Catalog ID</td><td>{catalogAddon.id}</td></tr>
                      <tr><td className="info-label">Catalog Name</td><td>{catalogAddon.name}</td></tr>
                      <tr><td className="info-label">Catalog Version</td><td>{catalogAddon.version}</td></tr>
                      <tr><td className="info-label">Category</td><td>{ADDON_CATEGORIES[catalogAddon.categoryId] || `Cat ${catalogAddon.categoryId}`}</td></tr>
                      <tr><td className="info-label">Updated</td><td>{new Date(catalogAddon.date * 1000).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })}</td></tr>
                      <tr><td className="info-label">Downloads</td><td>{catalogAddon.totalDownloads.toLocaleString()} total / {catalogAddon.monthlyDownloads.toLocaleString()} monthly</td></tr>
                      <tr><td className="info-label">Favorites</td><td>{catalogAddon.favorites.toLocaleString()}</td></tr>
                      {catalogAddon.compatibility.length > 0 && (
                        <tr><td className="info-label">Compatible</td><td>{catalogAddon.compatibility.map(c => `${c.name} (${c.version})`).join(', ')}</td></tr>
                      )}
                      <tr><td className="info-label">Directories</td><td>{catalogAddon.directories.join(', ')}</td></tr>
                      {catalogAddon.donationLink && (
                        <tr><td className="info-label">Donation</td><td>
                          <a className="online-link" href={catalogAddon.donationLink} onClick={(e) => { e.preventDefault(); window.electronAPI.openExternalUrl(catalogAddon.donationLink); }}>Link</a>
                        </td></tr>
                      )}
                      <tr><td className="info-label">Page</td><td>
                        <a className="online-link" href={catalogAddon.infoUrl} onClick={(e) => { e.preventDefault(); window.electronAPI.openExternalUrl(catalogAddon.infoUrl); }}>{catalogAddon.infoUrl}</a>
                      </td></tr>
                    </>
                  )}
                  {catalogDetailsLoading && (
                    <tr><td colSpan={2} style={{ opacity: 0.6 }}>Loading online details…</td></tr>
                  )}
                  {catalogDetails?.description && (
                    <tr><td className="info-label">Online Description</td><td style={{ whiteSpace: 'pre-wrap' }}><RichText text={catalogDetails.description} /></td></tr>
                  )}
                  {catalogDetails?.changeLog && (
                    <tr><td className="info-label">ChangeLog</td><td style={{ whiteSpace: 'pre-wrap' }}><RichText text={catalogDetails.changeLog} /></td></tr>
                  )}
                  {catalogDetails?.md5 && (
                    <tr><td className="info-label">MD5</td><td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{catalogDetails.md5}</td></tr>
                  )}
                  {catalogDetails?.fileName && (
                    <tr><td className="info-label">File</td><td>{catalogDetails.fileName}</td></tr>
                  )}
                  {addon.dependsOn.length > 0 && (
                    <tr><td className="info-label">Dependencies</td><td>{addon.dependsOn.map(d => d.name + (d.minVersion !== undefined ? ` ≥${d.minVersion}` : '')).join(', ')}</td></tr>
                  )}
                  {addon.optionalDependsOn.length > 0 && (
                    <tr><td className="info-label">Optional Deps</td><td>{addon.optionalDependsOn.map(d => d.name + (d.minVersion !== undefined ? ` ≥${d.minVersion}` : '')).join(', ')}</td></tr>
                  )}
                  {addon.savedVariables.length > 0 && (
                    <tr><td className="info-label">SavedVars</td><td>{addon.savedVariables.join(', ')}</td></tr>
                  )}
                  {addon.files.length > 0 && (
                    <tr><td className="info-label">Files</td><td>{addon.files.length} file(s)</td></tr>
                  )}
                  {addon.downloadUrl && (
                    <tr><td className="info-label">Download URL</td><td style={{ wordBreak: 'break-all' }}>{addon.downloadUrl}</td></tr>
                  )}
                  {addon.catalogId && (
                    <tr><td className="info-label">Catalog ID (manifest)</td><td>{addon.catalogId}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AddonTreeItem;
