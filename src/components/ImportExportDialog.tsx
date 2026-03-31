// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ImportExportDialogProps {
  addonPath: string;
  addons: { folderName: string; version: string; isLibrary: boolean; dependsOn: string[] }[];
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
    bundledCount: number;
    hasSettings: boolean;
    hasUserSettings: boolean;
    hasMachineSettings: boolean;
    savedVarsCount: number;
    exportedAt: string;
  } | null>(null);
  const [importProgress, setImportProgress] = useState<{ phase: string; percent: number } | null>(null);
  // Checkboxes for individual SavedVariables .lua files
  const [savedVarFiles, setSavedVarFiles] = useState<Map<string, boolean>>(new Map());

  // Export checkboxes
  const [includeAddonSettings, setIncludeAddonSettings] = useState(true);
  const [includeSavedVars, setIncludeSavedVars] = useState(true);
  const [includeUserSettings, setIncludeUserSettings] = useState(true);
  const [includeMachineSettings, setIncludeMachineSettings] = useState(true);
  // Import checkboxes for settings files
  const [importAddonSettings, setImportAddonSettings] = useState(true);
  const [importUserSettings, setImportUserSettings] = useState(true);
  const [importMachineSettings, setImportMachineSettings] = useState(true);

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
  const nonCatalogCount = addons.filter((a) => !a.isLibrary && !catalogByDir.has(a.folderName)).length;

  // Compute required libraries (transitively used by non-library addons)
  const requiredLibNames = (() => {
    const allByName = new Map(addons.map((a) => [a.folderName, a]));
    const required = new Set<string>();
    const q = addons.filter((a) => !a.isLibrary).flatMap((a) => a.dependsOn);
    while (q.length > 0) {
      const dep = q.shift()!;
      if (required.has(dep)) continue;
      const d = allByName.get(dep);
      if (d && d.isLibrary) {
        required.add(dep);
        q.push(...d.dependsOn);
      }
    }
    return required;
  })();
  const requiredLibCount = requiredLibNames.size;
  const unusedLibCount = libraryCount - requiredLibCount;

  // --- Export ---
  const handleExport = async () => {
    setExporting(true);
    setExportProgress({ phase: 'Preparing…', percent: 0 });
    try {
      const nonLibAddons = addons.filter((a) => !a.isLibrary);
      const allAddonsByName = new Map(addons.map((a) => [a.folderName, a]));

      // Transitively collect all required libraries
      const requiredLibs = new Set<string>();
      const queue = nonLibAddons.flatMap((a) => a.dependsOn);
      while (queue.length > 0) {
        const depName = queue.shift()!;
        if (requiredLibs.has(depName)) continue;
        const dep = allAddonsByName.get(depName);
        if (dep && dep.isLibrary) {
          requiredLibs.add(depName);
          // Also add transitive deps of this library
          queue.push(...dep.dependsOn);
        }
      }

      // Build addon list: non-libraries + required libraries
      const addonList = nonLibAddons.map((a) => ({
        folderName: a.folderName,
        catalogId: catalogByDir.get(a.folderName)?.id,
        version: a.version,
        isLibrary: false,
      }));

      for (const libName of requiredLibs) {
        const lib = allAddonsByName.get(libName)!;
        addonList.push({
          folderName: lib.folderName,
          catalogId: catalogByDir.get(lib.folderName)?.id,
          version: lib.version,
          isLibrary: true,
        });
      }

      // Identify non-catalog folders to bundle (both addons and libs without catalog entry)
      const bundleFolders = addonList
        .filter((a) => !catalogByDir.has(a.folderName))
        .map((a) => a.folderName);

      const result = await window.electronAPI.exportProfile(addonPath, addonList, bundleFolders.length > 0 ? bundleFolders : undefined);
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
      if (!includeMachineSettings) {
        result.machineSettings = null;
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
      const bundledCount = result.bundledAddons ? Object.keys(result.bundledAddons).length : 0;
      const exportedAddons = result.addons.filter((a: { isLibrary: boolean }) => !a.isLibrary).length;
      const exportedLibs = result.addons.filter((a: { isLibrary: boolean }) => a.isLibrary).length;
      onLog(
        `Exported ${exportedAddons} addon(s), ${exportedLibs} librar${exportedLibs === 1 ? 'y' : 'ies'}` +
        (bundledCount > 0 ? ` (${bundledCount} bundled)` : '') +
        (result.addonSettings ? ', AddOnSettings.txt' : '') +
        (svCount > 0 ? `, ${svCount} SavedVariables` : '') +
        (result.userSettings ? ', UserSettings.txt' : ''),
        'success'
      );
    } catch (err: unknown) {
      onLog(`Export failed: ${errMsg(err)}`, 'error');
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
      setImportMachineSettings(!!data.machineSettings);

      // Build checkbox map for SavedVariables (all enabled by default)
      const svKeys = Object.keys(data.savedVariables || {}).sort();
      setSavedVarFiles(new Map(svKeys.map((k) => [k, true])));

      setImportPreview({
        totalAddons: data.addons.filter((a: { isLibrary: boolean }) => !a.isLibrary).length,
        totalLibraries: data.addons.filter((a: { isLibrary: boolean }) => a.isLibrary).length,
        bundledCount: data.bundledAddons ? Object.keys(data.bundledAddons).length : 0,
        hasSettings: !!data.addonSettings,
        hasUserSettings: !!data.userSettings,
        hasMachineSettings: !!data.machineSettings,
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
    setImportProgress({ phase: 'Reading file…', percent: 5 });
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);
      setImportProgress({ phase: 'Parsing…', percent: 10 });

      // Filter based on user checkbox selection
      if (!importAddonSettings) {
        data.addonSettings = null;
      }
      if (!importUserSettings) {
        data.userSettings = null;
      }
      if (!importMachineSettings) {
        data.machineSettings = null;
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
      setImportProgress({ phase: 'Restoring settings…', percent: 20 });
      const result = await window.electronAPI.importProfile(addonPath, data);

      for (const s of result.restoredSettings) {
        onLog(`Restored: ${s}`, 'success');
      }
      if (result.restoredBundles.length > 0) {
        onLog(`Restored ${result.restoredBundles.length} bundled addon(s): ${result.restoredBundles.join(', ')}`, 'success');
      }
      for (const e of result.errors) {
        onLog(`Import error: ${e}`, 'error');
      }

      // Step 2: Install missing addons from catalog
      const toInstall = result.addonsToInstall.filter((a) => a.catalogId);
      if (toInstall.length > 0) {
        const seenIds = new Set<string>();
        const uniqueIds: string[] = [];
        for (const addon of toInstall) {
          if (addon.catalogId && !seenIds.has(addon.catalogId)) {
            seenIds.add(addon.catalogId);
            uniqueIds.push(addon.catalogId);
          }
        }

        setImportProgress({ phase: `Installing 0/${uniqueIds.length} addon(s)…`, percent: 30 });
        onLog(`Installing ${uniqueIds.length} missing addon(s) from catalog...`);

        // Listen for per-addon 'done' events in real-time to update the progress bar
        let installedSoFar = 0;
        const totalToInstall = uniqueIds.length;
        const cleanupProgress = window.electronAPI.onInstallProgress((data) => {
          if (data.phase === 'done') {
            installedSoFar++;
            const shown = Math.min(installedSoFar, totalToInstall);
            const pct = 30 + Math.round((shown / totalToInstall) * 65);
            setImportProgress({ phase: `Installing ${shown}/${totalToInstall} addon(s)…`, percent: pct });
          }
        });

        let installResults;
        try {
          installResults = await window.electronAPI.batchInstallAddons(addonPath, uniqueIds);
        } finally {
          cleanupProgress();
        }
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

      setImportProgress({ phase: 'Done!', percent: 100 });
      onLog('Import complete', 'success');
      onScanPath(addonPath);
    } catch (err: unknown) {
      onLog(`Import failed: ${errMsg(err)}`, 'error');
      setImportProgress(null);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="unsaved-overlay">
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
                <span className="ie-stat">📚 <strong>{requiredLibCount}</strong> Libraries</span>
                {unusedLibCount > 0 && (
                  <span className="ie-stat" style={{ opacity: 0.6 }}>🗑️ <strong>{unusedLibCount}</strong> unused libs (excluded)</span>
                )}
                {nonCatalogCount > 0 && (
                  <span className="ie-stat">📦 <strong>{nonCatalogCount}</strong> bundled (not on ESOUI)</span>
                )}
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
                    checked={includeMachineSettings}
                    onChange={(e) => setIncludeMachineSettings(e.target.checked)}
                  />
                  Include MachineSettings.txt (GPU, resolution)
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
                    {importPreview.bundledCount > 0 && (
                      <span className="ie-stat">📦 <strong>{importPreview.bundledCount}</strong> bundled</span>
                    )}
                  </div>
                  <div className="ie-date">
                    Exported: {new Date(importPreview.exportedAt).toLocaleString()}
                  </div>

                  {(importPreview.hasSettings || importPreview.hasUserSettings || importPreview.hasMachineSettings) && (
                    <div className="ie-options" style={{ marginTop: 10 }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>General Settings</div>
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
                      {importPreview.hasMachineSettings && (
                        <label className="ie-option">
                          <input
                            type="checkbox"
                            checked={importMachineSettings}
                            onChange={(e) => setImportMachineSettings(e.target.checked)}
                          />
                          🖥️ MachineSettings.txt (GPU, resolution)
                        </label>
                      )}
                    </div>
                  )}

                  {savedVarFiles.size > 0 && (
                    <div className="ie-sv-section" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 10, marginTop: 10 }}>
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
                <div style={{ margin: '12px 0' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 4 }}>
                    {importProgress.phase}
                  </div>
                  <div className="status-progress-track" style={{ height: 6 }}>
                    <div
                      className="status-progress-fill status-progress-current"
                      style={{ width: `${importProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}

              {!addonPath && (
                <p className="ie-warning">Set an AddOns path first before importing.</p>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '8px 16px 12px', borderTop: '1px solid var(--border)' }}>
          {activeTab === 'export' && (
            <button
              className="restore-btn ie-action-btn"
              onClick={handleExport}
              disabled={exporting || addons.length === 0}
            >
              {exporting ? 'Exporting...' : '📤 Export Profile'}
            </button>
          )}
          {activeTab === 'import' && (
            <button
              className="restore-btn ie-action-btn"
              onClick={handleImport}
              disabled={importing || !importFile || !importPreview}
            >
              {importing ? 'Importing...' : '📥 Import Profile'}
            </button>
          )}
          <button className="restore-btn ie-action-btn" onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
};

export default ImportExportDialog;
