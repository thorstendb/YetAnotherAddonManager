// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

export type CleanupType = 'libs' | 'settings' | 'downloads';

interface CleanupDialogProps {
  type: CleanupType;
  /** For libs/downloads: simple list of names. For settings: { orphanedSettings, orphanedSavedVars } */
  items: string[];
  /** Secondary items: orphaned SavedVariables (settings) or optional-only libs (libs) */
  savedVarItems?: string[];
  onConfirm: (selectedItems: string[], selectedSvItems?: string[]) => void;
  onCancel: () => void;
}

const TITLES: Record<CleanupType, string> = {
  libs: '🧹 Cleanup Unreferenced Libraries',
  settings: '🧹 Cleanup Orphaned Settings',
  downloads: '🧹 Move Archives to Downloads',
};

const CleanupDialog: React.FC<CleanupDialogProps> = ({
  type,
  items,
  savedVarItems = [],
  onConfirm,
  onCancel,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items));
  // Optional-only libs start unselected (they're less critical); savedVars start selected
  const [selectedSv, setSelectedSv] = useState<Set<string>>(() => type === 'libs' ? new Set() : new Set(savedVarItems));

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
  const totalSelected = selected.size + (hasSvSection ? selectedSv.size : 0);
  const totalItems = items.length + (hasSvSection ? savedVarItems.length : 0);

  const handleConfirm = () => {
    if (totalSelected === 0) return;
    onConfirm(Array.from(selected), hasSvSection ? Array.from(selectedSv) : undefined);
  };

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog cleanup-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="restore-header">
          <div className="restore-title">{TITLES[type]}</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onCancel} title="Close">✕</button>
        </div>
        <div className="restore-content" style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
          {totalItems === 0 ? (
            <div style={{ opacity: 0.6, padding: '16px 0', textAlign: 'center' }}>
              Nothing to clean up.
            </div>
          ) : (
            <>
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
