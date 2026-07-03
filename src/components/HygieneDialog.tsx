// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

export interface HygieneStray {
  file: string;
  addonName: string;
  title: string;
  version: string;
  addonVersion: number;
  relatedFiles: string[];
  folderExists: boolean;
  folderVersion: string;
  rootIsStale: boolean;
}

export interface HygieneDup {
  relPath: string;
  originalRelPath: string;
  isDirectory: boolean;
}

interface HygieneDialogProps {
  strayManifests: HygieneStray[];
  duplicates: HygieneDup[];
  unclaimedRootFiles: string[];
  onConfirm: (actions: { repairs: string[]; removals: string[] }) => void;
  onCancel: () => void;
}

/**
 * Folder hygiene review: broken installs (addon ZIPs extracted straight into
 * the AddOns root), stale root copies shadowed by a proper folder, macOS
 * Finder " 2"-duplicates, and leftover unclaimed root files.  Everything the
 * game silently ignores but that confuses users and tooling.
 */
const HygieneDialog: React.FC<HygieneDialogProps> = ({
  strayManifests,
  duplicates,
  unclaimedRootFiles,
  onConfirm,
  onCancel,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  const broken = strayManifests.filter((s) => !s.folderExists);
  const stale = strayManifests.filter((s) => s.folderExists);

  // Defaults: repair broken installs and remove duplicates/stale copies; leave
  // unclaimed files alone unless the user opts in.
  const [repairSel, setRepairSel] = useState<Set<string>>(() => new Set(broken.map((s) => s.file)));
  const [staleSel, setStaleSel] = useState<Set<string>>(() => new Set(stale.filter((s) => s.rootIsStale).map((s) => s.file)));
  const [dupSel, setDupSel] = useState<Set<string>>(() => new Set(duplicates.map((d) => d.relPath)));
  const [unclaimedSel, setUnclaimedSel] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (key: string) => {
    set((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const toggleRepair = toggle(setRepairSel);
  const toggleStale = toggle(setStaleSel);
  const toggleDup = toggle(setDupSel);
  const toggleUnclaimed = toggle(setUnclaimedSel);

  const totalItems = strayManifests.length + duplicates.length + unclaimedRootFiles.length;
  const totalSelected = repairSel.size + staleSel.size + dupSel.size + unclaimedSel.size;

  const handleConfirm = () => {
    if (totalSelected === 0) return;
    const removals: string[] = [];
    for (const s of stale) {
      if (staleSel.has(s.file)) removals.push(s.file, ...s.relatedFiles);
    }
    for (const d of duplicates) {
      if (dupSel.has(d.relPath)) removals.push(d.relPath);
    }
    for (const f of unclaimedRootFiles) {
      if (unclaimedSel.has(f)) removals.push(f);
    }
    onConfirm({ repairs: Array.from(repairSel), removals });
  };

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog cleanup-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="restore-header">
          <div className="restore-title">🩺 Folder Hygiene</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onCancel} title="Close">✕</button>
        </div>
        <div className="restore-content" style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
          {totalItems === 0 ? (
            <div style={{ opacity: 0.6, padding: '16px 0', textAlign: 'center' }}>
              No hygiene problems found — the AddOns folder is clean.
            </div>
          ) : (
            <>
              {broken.length > 0 && (
                <>
                  <div className="cleanup-section-label">
                    Broken installs — extracted into the AddOns root ({broken.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    The game never loads these. Repair moves the manifest and its files
                    into a proper addon folder; updates are then detected normally.
                  </div>
                  <div className="cleanup-items">
                    {broken.map((s) => (
                      <label key={s.file} className="cleanup-item" onClick={() => toggleRepair(s.file)}>
                        <input type="checkbox" checked={repairSel.has(s.file)} readOnly />
                        <span>
                          🔧 <strong>{s.title}</strong> v{s.version || '?'} — {s.file}
                          {s.relatedFiles.length > 0 && ` + ${s.relatedFiles.length} file(s)/folder(s)`}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {stale.length > 0 && (
                <>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    Stale root copies — a proper folder exists ({stale.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    Leftover files in the AddOns root shadowed by the installed folder.
                    Moved to Removed/, never deleted.
                  </div>
                  <div className="cleanup-items">
                    {stale.map((s) => (
                      <label key={s.file} className="cleanup-item" onClick={() => toggleStale(s.file)}>
                        <input type="checkbox" checked={staleSel.has(s.file)} readOnly />
                        <span>
                          {s.rootIsStale ? '🗑️' : '⚠️'} {s.file} v{s.version || '?'}
                          {' '}(folder has v{s.folderVersion || '?'})
                          {s.relatedFiles.length > 0 && ` + ${s.relatedFiles.length} file(s)/folder(s)`}
                          {!s.rootIsStale && ' — root copy looks NEWER, check manually'}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {duplicates.length > 0 && (
                <>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    Finder duplicates (" 2" copies) ({duplicates.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    Created by macOS when extracting into occupied folders. The original
                    exists next to each copy.
                  </div>
                  <div className="cleanup-items">
                    {duplicates.map((d) => (
                      <label key={d.relPath} className="cleanup-item" onClick={() => toggleDup(d.relPath)}>
                        <input type="checkbox" checked={dupSel.has(d.relPath)} readOnly />
                        <span>{d.isDirectory ? '📁' : '📄'} {d.relPath}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}

              {unclaimedRootFiles.length > 0 && (
                <>
                  <div className="cleanup-section-label" style={{ marginTop: '12px' }}>
                    Unclaimed root files ({unclaimedRootFiles.length})
                  </div>
                  <div style={{ fontSize: '0.8rem', opacity: 0.7, margin: '4px 0 8px' }}>
                    Files in the AddOns root that belong to no addon manifest
                    (README, logos, …). Optional to remove.
                  </div>
                  <div className="cleanup-items">
                    {unclaimedRootFiles.map((f) => (
                      <label key={f} className="cleanup-item" onClick={() => toggleUnclaimed(f)}>
                        <input type="checkbox" checked={unclaimedSel.has(f)} readOnly />
                        <span>📄 {f}</span>
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
            ✓ Apply {totalSelected > 0 ? `(${repairSel.size} repair, ${totalSelected - repairSel.size} remove)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HygieneDialog;
