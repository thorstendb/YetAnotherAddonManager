// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useState, useRef, useMemo } from 'react';

interface SnapshotAddon {
  folderName: string;
  version: string;
}

interface AddonSnapshot {
  timestamp: string;
  addons: SnapshotAddon[];
}

interface AddonBackup {
  folderName: string;
  version: string;
  backupPath: string;
  mtimeMs: number;
}

interface SvBackupEntry {
  fileName: string;
  backupDirName: string;
  backupFilePath: string;
  type: 'backup' | 'cleanup';
  timestamp: string;
}

interface CurrentAddon {
  folderName: string;
  version: string;
}

interface RestoreDialogProps {
  snapshots: AddonSnapshot[];
  backups: AddonBackup[];
  svBackups: SvBackupEntry[];
  currentAddons: CurrentAddon[];
  onRestoreBackup: (folderName: string, version: string, backupPath: string) => void;
  onRestoreSvFile: (backupFilePath: string) => void;
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

type TabId = 'backups' | 'snapshots' | 'savedvars';

const RestoreDialog: React.FC<RestoreDialogProps> = ({
  snapshots,
  backups,
  svBackups,
  currentAddons,
  onRestoreBackup,
  onRestoreSvFile,
  onClose,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [activeTab, setActiveTab] = useState<TabId>('backups');
  const [selectedSnapshot, setSelectedSnapshot] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [svSearchQuery, setSvSearchQuery] = useState('');

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Build current addon map
  const currentMap = useMemo(
    () => new Map(currentAddons.map((a) => [a.folderName, a.version])),
    [currentAddons]
  );

  // Build backup lookup: folderName -> versions[] (sorted newest first within each group)
  const backupsByAddon = useMemo(() => {
    const map = new Map<string, AddonBackup[]>();
    for (const b of backups) {
      if (!map.has(b.folderName)) map.set(b.folderName, []);
      map.get(b.folderName)!.push(b);
    }
    // Sort versions within each addon group: newest first
    for (const versions of map.values()) {
      versions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
    return map;
  }, [backups]);

  // Filter backups by search, sorted by most recent backup first
  const filteredBackupAddons = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const addonNames = Array.from(backupsByAddon.keys());
    // Sort addon groups by newest backup first
    addonNames.sort((a, b) => {
      const aMax = backupsByAddon.get(a)![0]?.mtimeMs ?? 0;
      const bMax = backupsByAddon.get(b)![0]?.mtimeMs ?? 0;
      return bMax - aMax;
    });
    if (!q) return addonNames;
    return addonNames.filter((name) => name.toLowerCase().includes(q));
  }, [backupsByAddon, searchQuery]);

  // Group SV backups by backup directory (timestamp), then filter by search
  const svByDir = useMemo(() => {
    const map = new Map<string, { timestamp: string; type: 'backup' | 'cleanup'; files: SvBackupEntry[] }>();
    for (const entry of svBackups) {
      if (!map.has(entry.backupDirName)) {
        map.set(entry.backupDirName, { timestamp: entry.timestamp, type: entry.type, files: [] });
      }
      map.get(entry.backupDirName)!.files.push(entry);
    }
    return map;
  }, [svBackups]);

  const filteredSvDirs = useMemo(() => {
    const q = svSearchQuery.toLowerCase();
    const dirs = Array.from(svByDir.entries())
      .sort(([, a], [, b]) => b.timestamp.localeCompare(a.timestamp));
    if (!q) return dirs;
    return dirs.filter(([, group]) =>
      group.files.some((f) => f.fileName.toLowerCase().includes(q))
    );
  }, [svByDir, svSearchQuery]);

  // Compute snapshot diffs
  const snapshotDiff = useMemo(() => {
    if (snapshots.length === 0 || selectedSnapshot >= snapshots.length) return null;
    const snap = snapshots[selectedSnapshot];
    const snapMap = new Map(snap.addons.map((a) => [a.folderName, a.version]));

    const added: { folderName: string; version: string }[] = [];
    const removed: { folderName: string; version: string }[] = [];
    const changed: { folderName: string; fromVersion: string; toVersion: string }[] = [];

    // Addons in current but not in snapshot (added since snapshot)
    for (const [name, ver] of currentMap) {
      if (!snapMap.has(name)) {
        added.push({ folderName: name, version: ver });
      } else if (snapMap.get(name) !== ver) {
        changed.push({ folderName: name, fromVersion: snapMap.get(name)!, toVersion: ver });
      }
    }

    // Addons in snapshot but not in current (removed since snapshot)
    for (const [name, ver] of snapMap) {
      if (!currentMap.has(name)) {
        removed.push({ folderName: name, version: ver });
      }
    }

    return { added, removed, changed, snapshot: snap };
  }, [snapshots, selectedSnapshot, currentMap]);

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog">
        <div className="restore-header">
          <div className="restore-title">⏪ Restore Previous Versions</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="restore-tabs">
          <button
            className={`restore-tab ${activeTab === 'backups' ? 'active' : ''}`}
            onClick={() => setActiveTab('backups')}
          >
            📦 Addon Backups ({backups.length})
          </button>
          <button
            className={`restore-tab ${activeTab === 'snapshots' ? 'active' : ''}`}
            onClick={() => setActiveTab('snapshots')}
          >
            📸 Snapshots ({snapshots.length})
          </button>
          <button
            className={`restore-tab ${activeTab === 'savedvars' ? 'active' : ''}`}
            onClick={() => setActiveTab('savedvars')}
          >
            💾 SavedVariables ({svBackups.length})
          </button>
        </div>

        {activeTab === 'backups' && (
          <div className="restore-content">
            <input
              type="text"
              className="restore-search"
              placeholder="Search backups..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              spellCheck={false}
            />
            {filteredBackupAddons.length === 0 ? (
              <div className="restore-empty">
                {backups.length === 0
                  ? 'No addon backups yet. Backups are created automatically when addons are updated.'
                  : 'No matching backups.'}
              </div>
            ) : (
              <div className="restore-list">
                {filteredBackupAddons.map((addonName) => {
                  const versions = backupsByAddon.get(addonName)!;
                  const currentVer = currentMap.get(addonName);
                  return (
                    <div key={addonName} className="restore-addon-group">
                      <div className="restore-addon-name">
                        {addonName}
                        {currentVer && <span className="restore-current-ver"> (current: {currentVer})</span>}
                        {!currentVer && <span className="restore-not-installed"> (not installed)</span>}
                      </div>
                      <div className="restore-versions">
                        {versions.map((bk) => (
                          <div key={bk.backupPath} className="restore-version-row">
                            <span className="restore-version-label">{bk.version}</span>
                            <button
                              className="restore-btn"
                              onClick={() => onRestoreBackup(bk.folderName, bk.version, bk.backupPath)}
                              disabled={currentVer === bk.version}
                              title={currentVer === bk.version ? 'Already at this version' : `Restore ${addonName} to version ${bk.version}`}
                            >
                              {currentVer === bk.version ? '✓ Current' : '↩ Restore'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'snapshots' && (
          <div className="restore-content">
            {snapshots.length === 0 ? (
              <div className="restore-empty">
                No snapshots yet. Snapshots are created automatically on startup when addon changes are detected.
              </div>
            ) : (
              <>
                <div className="restore-snapshot-selector">
                  <label>Snapshot:</label>
                  <select
                    value={selectedSnapshot}
                    onChange={(e) => setSelectedSnapshot(Number(e.target.value))}
                  >
                    {snapshots.map((snap, i) => (
                      <option key={i} value={i}>
                        {formatTimestamp(snap.timestamp)} — {snap.addons.length} addons
                      </option>
                    ))}
                  </select>
                </div>

                {snapshotDiff && (
                  <div className="restore-diff">
                    <div className="restore-diff-title">
                      Changes since {formatTimestamp(snapshotDiff.snapshot.timestamp)}:
                    </div>

                    {snapshotDiff.added.length === 0 && snapshotDiff.removed.length === 0 && snapshotDiff.changed.length === 0 && (
                      <div className="restore-diff-empty">No differences — current state matches this snapshot.</div>
                    )}

                    {snapshotDiff.changed.length > 0 && (
                      <div className="restore-diff-section">
                        <div className="restore-diff-label">🔄 Version changed ({snapshotDiff.changed.length}):</div>
                        {snapshotDiff.changed.map((c) => {
                          const bk = backupsByAddon.get(c.folderName)?.find((b) => b.version === c.fromVersion);
                          return (
                            <div key={c.folderName} className="restore-diff-row">
                              <span className="restore-diff-name">{c.folderName}</span>
                              <span className="restore-diff-ver">{c.fromVersion} → {c.toVersion}</span>
                              {bk && (
                                <button
                                  className="restore-btn restore-btn-sm"
                                  onClick={() => onRestoreBackup(bk.folderName, bk.version, bk.backupPath)}
                                  title={`Restore to ${c.fromVersion}`}
                                >
                                  ↩ Restore
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {snapshotDiff.added.length > 0 && (
                      <div className="restore-diff-section">
                        <div className="restore-diff-label">➕ Added since ({snapshotDiff.added.length}):</div>
                        {snapshotDiff.added.map((a) => (
                          <div key={a.folderName} className="restore-diff-row">
                            <span className="restore-diff-name">{a.folderName}</span>
                            <span className="restore-diff-ver">{a.version}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {snapshotDiff.removed.length > 0 && (
                      <div className="restore-diff-section">
                        <div className="restore-diff-label">➖ Removed since ({snapshotDiff.removed.length}):</div>
                        {snapshotDiff.removed.map((r) => {
                          const bk = backupsByAddon.get(r.folderName)?.find((b) => b.version === r.version);
                          return (
                            <div key={r.folderName} className="restore-diff-row">
                              <span className="restore-diff-name">{r.folderName}</span>
                              <span className="restore-diff-ver">{r.version}</span>
                              {bk && (
                                <button
                                  className="restore-btn restore-btn-sm"
                                  onClick={() => onRestoreBackup(bk.folderName, bk.version, bk.backupPath)}
                                  title={`Restore ${r.folderName} ${r.version}`}
                                >
                                  ↩ Restore
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'savedvars' && (
          <div className="restore-content">
            <input
              type="text"
              className="restore-search"
              placeholder="Search saved variables..."
              value={svSearchQuery}
              onChange={(e) => setSvSearchQuery(e.target.value)}
              spellCheck={false}
            />
            {filteredSvDirs.length === 0 ? (
              <div className="restore-empty">
                {svBackups.length === 0
                  ? 'No SavedVariables backups yet. Backups are created when variables are deleted or cleaned up.'
                  : 'No matching saved variables.'}
              </div>
            ) : (
              <div className="restore-list">
                {filteredSvDirs.map(([dirName, group]) => {
                  const q = svSearchQuery.toLowerCase();
                  const filesToShow = q
                    ? group.files.filter((f) => f.fileName.toLowerCase().includes(q))
                    : group.files;
                  return (
                    <div key={dirName} className="restore-addon-group">
                      <div className="restore-addon-name">
                        {group.type === 'cleanup' ? '🧹 Cleanup' : '🗑️ Deleted'}{' '}
                        — {formatTimestamp(group.timestamp)}
                        <span className="restore-current-ver"> ({group.files.length} files)</span>
                      </div>
                      <div className="restore-versions">
                        {filesToShow.map((entry) => (
                          <div key={entry.backupFilePath} className="restore-version-row">
                            <span className="restore-version-label">{entry.fileName}</span>
                            <button
                              className="restore-btn restore-btn-sm"
                              onClick={() => onRestoreSvFile(entry.backupFilePath)}
                              title={`Restore ${entry.fileName} to SavedVariables`}
                            >
                              ↩ Restore
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default RestoreDialog;
