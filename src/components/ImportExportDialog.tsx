// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

interface ImportExportDialogProps {
  addonPath: string;
  addons: { folderName: string; version: string; isLibrary: boolean }[];
  catalogByDir: Map<string, { id: string; name: string; version: string; directories: string[] }>;
  onLog: (message: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  onScanPath: (path: string) => void;
  onClose: () => void;
}

type TabId = 'export' | 'import';

const ImportExportDialog: React.FC<ImportExportDialogProps> = ({
  addonPath,
  addons,
  catalogByDir,
  onLog,
  onScanPath,
  onClose,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<TabId>('export');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ phase: string; percent: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<{
    totalAddons: number;
    totalLibraries: number;
    hasSettings: boolean;
    hasUserSettings: boolean;
    savedVarsCount: number;
    exportedAt: string;
  } | null>(null);
  const [importProgress, setImportProgress] = useState('');
  // Checkboxes for individual SavedVariables .lua files
  const [savedVarFiles, setSavedVarFiles] = useState<Map<string, boolean>>(new Map());

  // Export checkboxes
  const [includeAddonSettings, setIncludeAddonSettings] = useState(true);
  const [includeSavedVars, setIncludeSavedVars] = useState(true);
  const [includeUserSettings, setIncludeUserSettings] = useState(true);
  // Import checkboxes for settings files
  const [importAddonSettings, setImportAddonSettings] = useState(true);
  const [importUserSettings, setImportUserSettings] = useState(true);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const cleanupProgress = window.electronAPI.onExportProgress((data) => {
      setExportProgress(data);
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      cleanupProgress();
    };
  }, [onClose]);

  const libraryCount = addons.filter((a) => a.isLibrary).length;
  const addonCount = addons.length - libraryCount;

  // --- Export ---
  const handleExport = async () => {
    setExporting(true);
    setExportProgress({ phase: 'Preparing…', percent: 0 });
    try {
      const addonList = addons.map((a) => {
        const catalogAddon = catalogByDir.get(a.folderName);
        return {
          folderName: a.folderName,
          catalogId: catalogAddon?.id,
          version: a.version,
          isLibrary: a.isLibrary,
        };
      });

      const result = await window.electronAPI.exportProfile(addonPath, addonList);
      if ('error' in result) {
        onLog(`Export failed: ${result.error}`, 'error');
        return;
      }

      // Remove optional data based on user choice
      if (!includeAddonSettings) {
        result.addonSettings = null;
      }
      if (!includeSavedVars) {
        result.savedVariables = {};
      }
      if (!includeUserSettings) {
        result.userSettings = null;
      }

      // Trigger download as JSON file
      setExportProgress({ phase: 'Writing file…', percent: 98 });
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `yaam-profile-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const svCount = Object.keys(result.savedVariables).length;
      onLog(
        `Exported ${result.addons.length} addons` +
        (result.addonSettings ? ', AddOnSettings.txt' : '') +
        (svCount > 0 ? `, ${svCount} SavedVariables` : '') +
        (result.userSettings ? ', UserSettings.txt' : ''),
        'success'
      );
    } catch (err: any) {
      onLog(`Export failed: ${err.message || err}`, 'error');
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  // --- Import: file selection + preview ---
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportPreview(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.formatVersion !== 1 || !Array.isArray(data.addons)) {
        onLog('Invalid export file format', 'error');
        setImportFile(null);
        return;
      }
      // Reset import checkboxes for settings files
      setImportAddonSettings(!!data.addonSettings);
      setImportUserSettings(!!data.userSettings);

      // Build checkbox map for SavedVariables (all enabled by default)
      const svKeys = Object.keys(data.savedVariables || {}).sort();
      setSavedVarFiles(new Map(svKeys.map((k) => [k, true])));

      setImportPreview({
        totalAddons: data.addons.filter((a: any) => !a.isLibrary).length,
        totalLibraries: data.addons.filter((a: any) => a.isLibrary).length,
        hasSettings: !!data.addonSettings,
        hasUserSettings: !!data.userSettings,
        savedVarsCount: svKeys.length,
        exportedAt: data.exportedAt,
      });
    } catch {
      onLog('Failed to parse export file — is it valid JSON?', 'error');
      setImportFile(null);
    }
  };

  // --- Import: execute ---
  const handleImport = async () => {
    if (!importFile || !addonPath) return;
    setImporting(true);
    setImportProgress('Reading file...');
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);

      // Filter based on user checkbox selection
      if (!importAddonSettings) {
        data.addonSettings = null;
      }
      if (!importUserSettings) {
        data.userSettings = null;
      }
      if (data.savedVariables) {
        const filtered: Record<string, string> = {};
        for (const [fileName, content] of Object.entries(data.savedVariables)) {
          if (savedVarFiles.get(fileName) !== false) {
            filtered[fileName] = content as string;
          }
        }
        data.savedVariables = filtered;
      }

      // Step 1: Restore settings & SavedVariables
      setImportProgress('Restoring settings...');
      const result = await window.electronAPI.importProfile(addonPath, data);

      for (const s of result.restoredSettings) {
        onLog(`Restored: ${s}`, 'success');
      }
      for (const e of result.errors) {
        onLog(`Import error: ${e}`, 'error');
      }

      // Step 2: Install missing addons from catalog
      const toInstall = result.addonsToInstall.filter((a) => a.catalogId);
      if (toInstall.length > 0) {
        // Deduplicate: a catalog addon may provide multiple directories
        const seenIds = new Set<string>();
        const uniqueIds: string[] = [];
        for (const addon of toInstall) {
          if (addon.catalogId && !seenIds.has(addon.catalogId)) {
            seenIds.add(addon.catalogId);
            uniqueIds.push(addon.catalogId);
          }
        }

        setImportProgress(`Installing ${uniqueIds.length} addon(s)...`);
        onLog(`Installing ${uniqueIds.length} missing addon(s) from catalog...`);

        const installResults = await window.electronAPI.batchInstallAddons(addonPath, uniqueIds);
        let installed = 0;
        let failed = 0;
        for (const r of installResults) {
          if (r.error) {
            onLog(`Failed to install ${r.addonId}: ${r.error}`, 'error');
            failed++;
          } else {
            installed++;
          }
        }
        onLog(`Installed ${installed} addon(s)${failed > 0 ? `, ${failed} failed` : ''}`, installed > 0 ? 'success' : 'error');
      }

      const noCatalog = result.addonsToInstall.filter((a) => !a.catalogId);
      if (noCatalog.length > 0) {
        onLog(`${noCatalog.length} addon(s) not in catalog (manual install needed): ${noCatalog.map((a) => a.folderName).join(', ')}`, 'warn');
      }

      setImportProgress('Done!');
      onLog('Import complete', 'success');
      onScanPath(addonPath);
    } catch (err: any) {
      onLog(`Import failed: ${err.message || err}`, 'error');
      setImportProgress('');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="unsaved-overlay" onClick={onClose}>
      <div className="restore-dialog" style={{ width: 'min(560px, 90vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="restore-header">
          <div className="restore-title">📋 Import / Export Profile</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="restore-tabs">
          <button className={`restore-tab ${activeTab === 'export' ? 'active' : ''}`} onClick={() => setActiveTab('export')}>
            📤 Export
          </button>
          <button className={`restore-tab ${activeTab === 'import' ? 'active' : ''}`} onClick={() => setActiveTab('import')}>
            📥 Import
          </button>
        </div>

        <div className="restore-content" style={{ minHeight: 200 }}>
          {activeTab === 'export' && (
            <div className="ie-section">
              <p className="ie-description">
                Export all addon references, settings, and saved data into a single file
                that can be imported on another system.
              </p>
              <div className="ie-stats">
                <span className="ie-stat">🧩 <strong>{addonCount}</strong> AddOns</span>
                <span className="ie-stat">📚 <strong>{libraryCount}</strong> Libraries</span>
              </div>
              <div className="ie-options">
                <label className="ie-option">
                  <input
                    type="checkbox"
                    checked={includeAddonSettings}
                    onChange={(e) => setIncludeAddonSettings(e.target.checked)}
                  />
                  Include AddOnSettings.txt (addon on/off per character)
                </label>
                <label className="ie-option">
                  <input
                    type="checkbox"
                    checked={includeUserSettings}
                    onChange={(e) => setIncludeUserSettings(e.target.checked)}
                  />
                  Include UserSettings.txt (keybinds, graphics, audio)
                </label>
                <label className="ie-option">
                  <input
                    type="checkbox"
                    checked={includeSavedVars}
                    onChange={(e) => setIncludeSavedVars(e.target.checked)}
                  />
                  Include SavedVariables (addon saved data)
                </label>
              </div>
              {exportProgress && (
                <div style={{ margin: '12px 0' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 4 }}>
                    {exportProgress.phase}
                  </div>
                  <div className="status-progress-track" style={{ height: 6 }}>
                    <div
                      className="status-progress-fill status-progress-current"
                      style={{ width: `${exportProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}
              <button
                className="restore-btn ie-action-btn"
                onClick={handleExport}
                disabled={exporting || addons.length === 0}
              >
                {exporting ? 'Exporting...' : '📤 Export Profile'}
              </button>
            </div>
          )}

          {activeTab === 'import' && (
            <div className="ie-section">
              <p className="ie-description">
                Import a previously exported profile. Existing settings will be backed up
                before being overwritten. Missing addons will be installed from the catalog.
              </p>
              <div className="ie-file-row">
                <button
                  className="restore-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                >
                  📁 Choose File
                </button>
                <span className="ie-file-name">
                  {importFile ? importFile.name : 'No file selected'}
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
              </div>

              {importPreview && (
                <div className="ie-preview">
                  <div className="ie-stats">
                    <span className="ie-stat">🧩 <strong>{importPreview.totalAddons}</strong> AddOns</span>
                    <span className="ie-stat">📚 <strong>{importPreview.totalLibraries}</strong> Libraries</span>
                  </div>
                  <div className="ie-date">
                    Exported: {new Date(importPreview.exportedAt).toLocaleString()}
                  </div>
                  <div className="ie-options" style={{ marginTop: 10 }}>
                    {importPreview.hasSettings && (
                      <label className="ie-option">
                        <input
                          type="checkbox"
                          checked={importAddonSettings}
                          onChange={(e) => setImportAddonSettings(e.target.checked)}
                        />
                        ⚙️ AddOnSettings.txt (addon on/off per character)
                      </label>
                    )}
                    {importPreview.hasUserSettings && (
                      <label className="ie-option">
                        <input
                          type="checkbox"
                          checked={importUserSettings}
                          onChange={(e) => setImportUserSettings(e.target.checked)}
                        />
                        🎮 UserSettings.txt (keybinds, graphics, audio)
                      </label>
                    )}
                  </div>

                  {savedVarFiles.size > 0 && (
                    <div className="ie-sv-section">
                      <div className="ie-sv-header">
                        <span>💾 SavedVariables ({Array.from(savedVarFiles.values()).filter(Boolean).length}/{savedVarFiles.size})</span>
                        <span className="ie-sv-toggle-all">
                          <button
                            className="ie-sv-toggle-btn"
                            onClick={() => {
                              const allOn = Array.from(savedVarFiles.values()).every(Boolean);
                              setSavedVarFiles(new Map(Array.from(savedVarFiles.keys()).map((k) => [k, !allOn])));
                            }}
                          >
                            {Array.from(savedVarFiles.values()).every(Boolean) ? 'Deselect All' : 'Select All'}
                          </button>
                        </span>
                      </div>
                      <div className="ie-sv-list">
                        {Array.from(savedVarFiles.entries()).map(([fileName, checked]) => (
                          <label key={fileName} className="ie-sv-item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                setSavedVarFiles((prev) => {
                                  const next = new Map(prev);
                                  next.set(fileName, e.target.checked);
                                  return next;
                                });
                              }}
                            />
                            <span className="ie-sv-name">{fileName}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {importProgress && (
                <div className="ie-progress">{importProgress}</div>
              )}

              <button
                className="restore-btn ie-action-btn"
                onClick={handleImport}
                disabled={importing || !importFile || !importPreview}
              >
                {importing ? 'Importing...' : '📥 Import Profile'}
              </button>

              {!addonPath && (
                <p className="ie-warning">Set an AddOns path first before importing.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ImportExportDialog;
