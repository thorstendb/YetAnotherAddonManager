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
  /** True when this row is a language patch / fix pack layered into another addon's folder */
  overlay?: boolean;
  /** Title of the addon this overlay (or hijacking patch) belongs to */
  overlayOf?: string;
  /** Overlay was overwritten by a main-addon update and needs re-applying */
  needsReapply?: boolean;
  /** Folder manifest hijacked by an untracked patch — original state unknown */
  layered?: boolean;
}

interface UpdateAllDialogProps {
  addons: UpdatableAddon[];
  onConfirm: (catalogIds: string[]) => void;
  onCancel: () => void;
}

const UpdateAllDialog: React.FC<UpdateAllDialogProps> = ({ addons, onConfirm, onCancel }) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  const plain = addons.filter(a => !a.overlay && !a.layered);
  const sure = plain.filter(a => !a.ambiguous && !a.replacement && !a.mightUpdate);
  const ambiguous = plain.filter(a => a.ambiguous && !a.replacement && !a.mightUpdate);
  const replacements = plain.filter(a => a.replacement);
  const notTracked = plain.filter(a => a.mightUpdate && a.mightUpdateReason === 'not-tracked');
  const versionChanged = plain.filter(a => a.mightUpdate && a.mightUpdateReason === 'version-changed');
  const dateNewer = plain.filter(a => a.mightUpdate && a.mightUpdateReason === 'date-newer');
  const overlays = addons.filter(a => a.overlay);
  const layered = addons.filter(a => a.layered);

  // Default: sure addons and overlay updates selected;
  // replacements/ambiguous/mightUpdate/layered require explicit opt-in
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([...sure, ...overlays].map(a => a.catalogId))
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

  const SectionCheckbox: React.FC<{ section: UpdatableAddon[] }> = ({ section }) => {
    const count = section.filter(a => selected.has(a.catalogId)).length;
    const all = count === section.length;
    const none = count === 0;
    const ref = React.useCallback((el: HTMLInputElement | null) => {
      if (el) el.indeterminate = !all && !none;
    }, [all, none]);
    return (
      <input
        type="checkbox"
        ref={ref}
        checked={!none}
        onChange={() => selectSection(section, !all)}
        style={{ marginRight: '6px', accentColor: (!all && !none) ? '#888' : undefined }}
      />
    );
  };

  const renderRow = (addon: UpdatableAddon) => (
    <label key={addon.catalogId} className="cleanup-item">
      <input type="checkbox" checked={selected.has(addon.catalogId)} onChange={() => toggle(addon.catalogId)} />
      <span>
        {addon.replacement
          ? <>{addon.folderName} <span style={{ opacity: 0.7 }}>→</span> <strong>{addon.replacementName}</strong></>
          : (addon.title || addon.folderName)
        }
        {addon.overlay && addon.overlayOf && (
          <span style={{ opacity: 0.6, marginLeft: '6px' }}>in {addon.overlayOf}</span>
        )}
        {addon.layered && (
          <span style={{ opacity: 0.6, marginLeft: '6px' }}>folder: {addon.folderName}</span>
        )}
        {addon.needsReapply && (
          <span style={{ marginLeft: '6px' }} title="Overwritten by a main-addon update — re-apply to restore the patch">⚠️ re-apply</span>
        )}
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
              </div>
              <div className="cleanup-items" style={{ maxHeight: 'none' }}>
                {sure.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.82em', opacity: 0.7, marginBottom: '4px', cursor: 'pointer' }}>
                    <SectionCheckbox section={sure} />
                    ✅ Confirmed updates ({sure.length})
                  </label>
                )}
                {sure.map(renderRow)}
                {replacements.length > 0 && (
                  <>
                    <label style={{
                      display: 'flex', alignItems: 'center', cursor: 'pointer',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <SectionCheckbox section={replacements} />
                      <span>🔄 Replacement available — a different addon now uses the same folder ({replacements.length})</span>
                    </label>
                    {replacements.map(renderRow)}
                  </>
                )}
                {ambiguous.length > 0 && (
                  <>
                    <label style={{
                      display: 'flex', alignItems: 'center', cursor: 'pointer',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <SectionCheckbox section={ambiguous} />
                      <span>⚠ Uncertain match — no ESOUI catalog ID in manifest ({ambiguous.length})</span>
                    </label>
                    {ambiguous.map(renderRow)}
                  </>
                )}
                {notTracked.length > 0 && (
                  <>
                    <label style={{
                      display: 'flex', alignItems: 'center', cursor: 'pointer',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <SectionCheckbox section={notTracked} />
                      <span>📋 Not installed via YAAM — version comparison inconclusive ({notTracked.length})</span>
                    </label>
                    {notTracked.map(renderRow)}
                  </>
                )}
                {versionChanged.length > 0 && (
                  <>
                    <label style={{
                      display: 'flex', alignItems: 'center', cursor: 'pointer',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <SectionCheckbox section={versionChanged} />
                      <span>🔄 Catalog version changed since last install ({versionChanged.length})</span>
                    </label>
                    {versionChanged.map(renderRow)}
                  </>
                )}
                {dateNewer.length > 0 && (
                  <>
                    <label style={{
                      display: 'flex', alignItems: 'center', cursor: 'pointer',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <SectionCheckbox section={dateNewer} />
                      <span>📅 Catalog published after the files on disk — version strings contradict ({dateNewer.length})</span>
                    </label>
                    {dateNewer.map(renderRow)}
                  </>
                )}
                {overlays.length > 0 && (
                  <>
                    <label style={{
                      display: 'flex', alignItems: 'center', cursor: 'pointer',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <SectionCheckbox section={overlays} />
                      <span>🧩 Language patches & fix packs — layered into another addon's folder ({overlays.length})</span>
                    </label>
                    {overlays.map(renderRow)}
                  </>
                )}
                {layered.length > 0 && (
                  <>
                    <label style={{
                      display: 'flex', alignItems: 'center', cursor: 'pointer',
                      borderTop: '1px solid var(--border-color, #555)',
                      margin: '8px 0 4px',
                      paddingTop: '6px',
                      fontSize: '0.82em',
                      opacity: 0.7,
                    }}>
                      <SectionCheckbox section={layered} />
                      <span>🎭 Patched folders — original version unknown ({layered.length})</span>
                    </label>
                    <div style={{ fontSize: '0.78em', opacity: 0.6, margin: '0 0 4px 22px' }}>
                      A language patch replaced this folder's manifest, so YAAM cannot tell which
                      version of the ORIGINAL addon is underneath. Selecting reinstalls the original
                      from the catalog (overwriting the patch — reinstall it afterwards, or select it
                      above if listed). Alternatively, if you trust that everything is current, use
                      ⚓ Baseline once: it anchors original AND patch at their current catalog
                      versions, and this section disappears.
                    </div>
                    {layered.map(renderRow)}
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
