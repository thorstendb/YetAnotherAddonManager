// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

export interface UpdatableAddon {
  folderName: string;
  title: string;
  localVersion: string;
  catalogVersion: string;
  catalogId: string;
  /** True when match is not via catalogId — user should verify */
  ambiguous?: boolean;
}

interface UpdateAllDialogProps {
  addons: UpdatableAddon[];
  onConfirm: (catalogIds: string[]) => void;
  onCancel: () => void;
}

const UpdateAllDialog: React.FC<UpdateAllDialogProps> = ({ addons, onConfirm, onCancel }) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  const sure = addons.filter(a => !a.ambiguous);
  const ambiguous = addons.filter(a => a.ambiguous);

  // Default: all sure addons selected, all ambiguous deselected
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(sure.map(a => a.catalogId))
  );

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(addons.map(a => a.catalogId)));
  const selectNone = () => setSelected(new Set());

  const renderRow = (addon: UpdatableAddon) => (
    <label key={addon.catalogId} className="cleanup-item" onClick={() => toggle(addon.catalogId)}>
      <input type="checkbox" checked={selected.has(addon.catalogId)} readOnly />
      <span>
        {addon.title || addon.folderName}
        <span style={{ opacity: 0.7, marginLeft: '8px' }}>
          {addon.localVersion || '?'} → {addon.catalogVersion}
        </span>
      </span>
    </label>
  );

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog cleanup-dialog" style={{ width: 'min(600px, 90vw)' }} onClick={e => e.stopPropagation()}>
        <div className="restore-header">
          <div className="restore-title">⬆ Update All</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onCancel} title="Close">✕</button>
        </div>
        <div className="restore-content" style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
          {addons.length === 0 ? (
            <div style={{ opacity: 0.6, padding: '16px 0', textAlign: 'center' }}>
              All addons are up-to-date.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', fontSize: '0.85em', opacity: 0.8 }}>
                <span>{addons.length} addon(s) with updates</span>
                <span style={{ marginLeft: 'auto' }}>
                  <button className="link-btn" onClick={selectAll}>All</button>
                  {' · '}
                  <button className="link-btn" onClick={selectNone}>None</button>
                </span>
              </div>
              <div className="cleanup-items" style={{ maxHeight: 'none' }}>
                {sure.map(renderRow)}
                {ambiguous.length > 0 && (
                  <>
                    <div style={{
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      ⚠ Uncertain match — no ESOUI catalog ID in manifest ({ambiguous.length})
                    </div>
                    {ambiguous.map(renderRow)}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div className="settings-actions" style={{ padding: '12px 16px' }}>
          <button className="restore-btn" onClick={onCancel}>Cancel</button>
          <button
            className="restore-btn ie-action-btn"
            onClick={() => onConfirm(Array.from(selected))}
            disabled={selected.size === 0}
          >
            ⬆ Update {selected.size > 0 ? `${selected.size} addon(s)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default UpdateAllDialog;
