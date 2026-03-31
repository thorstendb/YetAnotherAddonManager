// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState, useMemo } from 'react';

interface BackupEntry {
  folderName: string;
  version: string;
  backupPath: string;
  sizeBytes: number;
}

interface BackupCleanupDialogProps {
  backups: BackupEntry[];
  onConfirm: (backupPaths: string[]) => void;
  onCancel: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const BackupCleanupDialog: React.FC<BackupCleanupDialogProps> = ({ backups, onConfirm, onCancel }) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Group by folderName, then determine which are "old" (all except the last per group)
  const { grouped, defaultSelected } = useMemo(() => {
    const map = new Map<string, BackupEntry[]>();
    for (const b of backups) {
      const list = map.get(b.folderName) || [];
      list.push(b);
      map.set(b.folderName, list);
    }
    // Sort each group by version (the backup dir name) — newest first
    for (const list of map.values()) {
      list.sort((a, b) => b.version.localeCompare(a.version));
    }
    // Default: select all except newest (index 0) per group
    const sel = new Set<string>();
    for (const list of map.values()) {
      for (let i = 1; i < list.length; i++) {
        sel.add(list[i].backupPath);
      }
    }
    // Sort groups alphabetically
    const sorted = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return { grouped: sorted, defaultSelected: sel };
  }, [backups]);

  const [selected, setSelected] = useState<Set<string>>(() => defaultSelected);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const selectAllOld = () => setSelected(new Set(defaultSelected));
  const selectNone = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(backups.map(b => b.backupPath)));

  const selectedSize = backups
    .filter(b => selected.has(b.backupPath))
    .reduce((sum, b) => sum + b.sizeBytes, 0);

  const totalSize = backups.reduce((sum, b) => sum + b.sizeBytes, 0);

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog cleanup-dialog" style={{ width: 'min(600px, 90vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="restore-header">
          <div className="restore-title">🗄️ Cleanup Addon Backups</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onCancel} title="Close">✕</button>
        </div>
        <div className="restore-content" style={{ padding: '12px 16px', maxHeight: '60vh', overflowY: 'auto' }}>
          {backups.length === 0 ? (
            <div style={{ opacity: 0.6, padding: '16px 0', textAlign: 'center' }}>
              No backups found.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', fontSize: '0.85em', opacity: 0.8 }}>
                <span>Total: {backups.length} backup(s), {formatSize(totalSize)}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <button className="link-btn" onClick={selectAllOld}>Select old</button>
                  {' · '}
                  <button className="link-btn" onClick={selectAll}>All</button>
                  {' · '}
                  <button className="link-btn" onClick={selectNone}>None</button>
                </span>
              </div>
              {grouped.map(([folderName, entries]) => (
                <div key={folderName} style={{ marginBottom: '8px' }}>
                  <div className="cleanup-section-label">{folderName} ({entries.length})</div>
                  <div className="cleanup-items">
                    {entries.map((entry, idx) => {
                      const isNewest = idx === 0;
                      return (
                        <label
                          key={entry.backupPath}
                          className="cleanup-item"
                          onClick={() => toggle(entry.backupPath)}
                          style={isNewest ? { fontWeight: 500 } : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(entry.backupPath)}
                            readOnly
                          />
                          <span>
                            v{entry.version}
                            <span style={{ opacity: 0.5, marginLeft: '8px' }}>{formatSize(entry.sizeBytes)}</span>
                            {isNewest && entries.length > 1 && <span style={{ opacity: 0.5, marginLeft: '6px' }}>(newest)</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
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
            🗑️ Delete {selected.size > 0 ? `${selected.size} backup(s) (${formatSize(selectedSize)})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BackupCleanupDialog;
