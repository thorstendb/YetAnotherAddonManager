// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

export type CleanupType = 'libs' | 'settings' | 'downloads' | 'unused';

/** A further checkbox list below the main ones, items keyed by id */
export interface CleanupSection {
  key: string;
  label: string;
  note?: string;
  items: { id: string; label: string; detail?: string; selected: boolean }[];
}

interface CleanupDialogProps {
  type: CleanupType;
  /** For libs/downloads/unused: simple list of names. For settings: { orphanedSettings, orphanedSavedVars } */
  items: string[];
  /** Secondary items: orphaned SavedVariables (settings) or optional-only libs (libs) */
  savedVarItems?: string[];
  /** Optional muted text shown after an item's name (e.g. the addon title) */
  itemDetails?: Record<string, string>;
  /** Further sections (settings: ballast inside SavedVariables) */
  extraSections?: CleanupSection[];
  /** Shown above everything, e.g. "ESO is running" */
  warning?: string;
  onConfirm: (selectedItems: string[], selectedSvItems?: string[], selectedExtra?: Record<string, string[]>) => void;
  onCancel: () => void;
}

const TITLES: Record<CleanupType, string> = {
  libs: '🧹 Cleanup Unreferenced Libraries',
  settings: '🧹 Cleanup Settings & SavedVariables',
  downloads: '🧹 Move Archives to Downloads',
  unused: '💤 Remove Unused AddOns',
};

const NOTES: Partial<Record<CleanupType, string>> = {
  unused: 'Switched off for every character in AddOnSettings.txt — the game never loads them. '
    + 'Folders are moved to Removed/ (restorable via Go Back); settings and SavedVariables are kept. '
    + 'Anything an enabled addon requires is never listed.',
};

const CleanupDialog: React.FC<CleanupDialogProps> = ({
  type,
  items,
  savedVarItems = [],
  itemDetails = {},
  extraSections = [],
  warning,
  onConfirm,
  onCancel,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items));
  // Optional-only libs start unselected (they're less critical); savedVars start selected
  const [selectedSv, setSelectedSv] = useState<Set<string>>(() => type === 'libs' ? new Set() : new Set(savedVarItems));
  const [selectedExtra, setSelectedExtra] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(extraSections.map((s) => [s.key, new Set(s.items.filter((i) => i.selected).map((i) => i.id))])));

  const toggleExtra = (sectionKey: string, id: string) => {
    setSelectedExtra((prev) => {
      const next = new Set(prev[sectionKey]);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...prev, [sectionKey]: next };
    });
  };

  const toggleAllExtra = (section: CleanupSection) => {
    setSelectedExtra((prev) => ({
      ...prev,
      [section.key]: prev[section.key].size === section.items.length ? new Set() : new Set(section.items.map((i) => i.id)),
    }));
  };

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const toggleItem = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const toggleSvItem = (name: string) => {
    setSelectedSv((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items));
    }
  };

  const toggleAllSv = () => {
    if (selectedSv.size === savedVarItems.length) {
      setSelectedSv(new Set());
    } else {
      setSelectedSv(new Set(savedVarItems));
    }
  };

  const hasSvSection = type === 'settings' || (type === 'libs' && savedVarItems.length > 0);
  const extraSelected = Object.values(selectedExtra).reduce((sum, s) => sum + s.size, 0);
  const extraItems = extraSections.reduce((sum, s) => sum + s.items.length, 0);
  const totalSelected = selected.size + (hasSvSection ? selectedSv.size : 0) + extraSelected;
  const totalItems = items.length + (hasSvSection ? savedVarItems.length : 0) + extraItems;

  const handleConfirm = () => {
    if (totalSelected === 0) return;
    onConfirm(
      Array.from(selected),
      hasSvSection ? Array.from(selectedSv) : undefined,
      Object.fromEntries(Object.entries(selectedExtra).map(([key, set]) => [key, Array.from(set)]))
    );
  };

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog cleanup-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="restore-header">
          <div className="restore-title">{TITLES[type]}</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onCancel} title="Close">✕</button>
        </div>
        <div className="restore-content" style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
          {warning && (
            <div style={{ color: 'var(--red)', fontSize: '0.857rem', margin: '0 0 10px' }}>⚠️ {warning}</div>
          )}
          {totalItems === 0 ? (
            <div style={{ opacity: 0.6, padding: '16px 0', textAlign: 'center' }}>
              Nothing to clean up.
            </div>
          ) : (
            <>
              {NOTES[type] && (
                <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '0 0 8px' }}>{NOTES[type]}</div>
              )}
              {/* Main items list */}
              {items.length > 0 && (
                <>
                  {(type === 'settings' || (type === 'libs' && savedVarItems.length > 0)) && (
                    <div className="cleanup-section-label">
                      {type === 'settings' ? `Orphaned Settings (${items.length})` : `Unreferenced Libraries (${items.length})`}
                    </div>
                  )}
                  <label className="cleanup-select-all" onClick={toggleAll}>
                    <input
                      type="checkbox"
                      checked={selected.size === items.length}
                      readOnly
                    />
                    <span>{type === 'settings' ? 'Select all settings' : 'Select all'} ({items.length})</span>
                  </label>
                  <div className="cleanup-items">
                    {items.map((name) => (
                      <label key={name} className="cleanup-item" onClick={() => toggleItem(name)}>
                        <input
                          type="checkbox"
                          checked={selected.has(name)}
                          readOnly
                        />
                        <span>{name}</span>
                        {itemDetails[name] && <span style={{ opacity: 0.6 }}>— {itemDetails[name]}</span>}
                      </label>
                    ))}
                  </div>
                </>
              )}

              {/* Secondary items: SavedVariables (settings) or Optional-only libs (libs) */}
              {hasSvSection && savedVarItems.length > 0 && (
                <>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    {type === 'libs' ? `Optional Dependencies Only (${savedVarItems.length})` : `Orphaned SavedVariables (${savedVarItems.length})`}
                  </div>
                  <label className="cleanup-select-all" onClick={toggleAllSv}>
                    <input
                      type="checkbox"
                      checked={selectedSv.size === savedVarItems.length}
                      readOnly
                    />
                    <span>Select all SavedVariables ({savedVarItems.length})</span>
                  </label>
                  <div className="cleanup-items">
                    {savedVarItems.map((name) => (
                      <label key={name} className="cleanup-item" onClick={() => toggleSvItem(name)}>
                        <input
                          type="checkbox"
                          checked={selectedSv.has(name)}
                          readOnly
                        />
                        <span>{name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {extraSections.filter((s) => s.items.length > 0).map((section) => (
                <React.Fragment key={section.key}>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    {section.label} ({section.items.length})
                  </div>
                  {section.note && (
                    <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>{section.note}</div>
                  )}
                  <label className="cleanup-select-all" onClick={() => toggleAllExtra(section)}>
                    <input type="checkbox" checked={selectedExtra[section.key].size === section.items.length} readOnly />
                    <span>Select all ({section.items.length})</span>
                  </label>
                  <div className="cleanup-items">
                    {section.items.map((item) => (
                      <label key={item.id} className="cleanup-item" onClick={() => toggleExtra(section.key, item.id)}
                        style={{ alignItems: 'flex-start' }}>
                        <input type="checkbox" checked={selectedExtra[section.key].has(item.id)} readOnly />
                        <span>
                          {item.label}
                          {item.detail && <div style={{ opacity: 0.6, fontSize: '0.8rem' }}>{item.detail}</div>}
                        </span>
                      </label>
                    ))}
                  </div>
                </React.Fragment>
              ))}
            </>
          )}
        </div>
        <div className="settings-actions" style={{ padding: '12px 16px' }}>
          <button className="restore-btn" onClick={onCancel}>Cancel</button>
          <button
            className="restore-btn ie-action-btn"
            onClick={handleConfirm}
            disabled={totalSelected === 0}
          >
            ✓ Remove {totalSelected > 0 ? `(${totalSelected})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CleanupDialog;
