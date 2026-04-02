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
  /** True when a different catalog addon now targets the same folder (replacement/fork) */
  replacement?: boolean;
  /** Name of the replacement addon (for display) */
  replacementName?: string;
  /** True when detection is based on catalog date only (not version comparison) */
  mightUpdate?: boolean;
  /** Reason for mightUpdate classification */
  mightUpdateReason?: 'not-tracked' | 'version-changed' | 'date-newer';
}

interface UpdateAllDialogProps {
  addons: UpdatableAddon[];
  onConfirm: (catalogIds: string[]) => void;
  onCancel: () => void;
}

const UpdateAllDialog: React.FC<UpdateAllDialogProps> = ({ addons, onConfirm, onCancel }) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  const sure = addons.filter(a => !a.ambiguous && !a.replacement && !a.mightUpdate);
  const ambiguous = addons.filter(a => a.ambiguous && !a.replacement && !a.mightUpdate);
  const replacements = addons.filter(a => a.replacement);
  const notTracked = addons.filter(a => a.mightUpdate && a.mightUpdateReason === 'not-tracked');
  const versionChanged = addons.filter(a => a.mightUpdate && a.mightUpdateReason === 'version-changed');
  const dateNewer = addons.filter(a => a.mightUpdate && a.mightUpdateReason === 'date-newer');

  // Default: all sure addons selected, replacements/ambiguous/mightUpdate deselected
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

  const selectSection = (section: UpdatableAddon[], on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const a of section) on ? next.add(a.catalogId) : next.delete(a.catalogId);
      return next;
    });
  };

  const sectionToggle = (section: UpdatableAddon[]) => (
    <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
      <button className="link-btn" onClick={() => selectSection(section, true)}>All</button>
      {' · '}
      <button className="link-btn" onClick={() => selectSection(section, false)}>None</button>
    </span>
  );

  const renderRow = (addon: UpdatableAddon) => (
    <label key={addon.catalogId} className="cleanup-item">
      <input type="checkbox" checked={selected.has(addon.catalogId)} onChange={() => toggle(addon.catalogId)} />
      <span>
        {addon.replacement
          ? <>{addon.folderName} <span style={{ opacity: 0.7 }}>→</span> <strong>{addon.replacementName}</strong></>
          : (addon.title || addon.folderName)
        }
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
                {sure.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', fontSize: '0.82em', opacity: 0.7, marginBottom: '4px' }}>
                    ✅ Confirmed updates ({sure.length})
                    {sectionToggle(sure)}
                  </div>
                )}
                {sure.map(renderRow)}
                {replacements.length > 0 && (
                  <>
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <span>🔄 Replacement available — a different addon now uses the same folder ({replacements.length})</span>
                    {sectionToggle(replacements)}
                    </div>
                    {replacements.map(renderRow)}
                  </>
                )}
                {ambiguous.length > 0 && (
                  <>
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <span>⚠ Uncertain match — no ESOUI catalog ID in manifest ({ambiguous.length})</span>
                    {sectionToggle(ambiguous)}
                    </div>
                    {ambiguous.map(renderRow)}
                  </>
                )}
                {notTracked.length > 0 && (
                  <>
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <span>📋 Not installed via YAAM — version comparison inconclusive ({notTracked.length})</span>
                    {sectionToggle(notTracked)}
                    </div>
                    {notTracked.map(renderRow)}
                  </>
                )}
                {versionChanged.length > 0 && (
                  <>
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <span>🔄 Catalog version changed since last install ({versionChanged.length})</span>
                    {sectionToggle(versionChanged)}
                    </div>
                    {versionChanged.map(renderRow)}
                  </>
                )}
                {dateNewer.length > 0 && (
                  <>
                    <div style={{
                      display: 'flex', alignItems: 'center',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <span>📅 Catalog date is newer than local install ({dateNewer.length})</span>
                    {sectionToggle(dateNewer)}
                    </div>
                    {dateNewer.map(renderRow)}
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
          >
            ⬆ Update {selected.size > 0 ? `${selected.size} addon(s)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default UpdateAllDialog;
