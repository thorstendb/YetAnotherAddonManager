// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ImportExportDialogProps {
  addonPath: string;
  addons: { folderName: string; version: string; isLibrary: boolean; dependsOn: string[]; runtimeFiles?: string[] }[];
  catalogByDir: Map<string, { id: string; name: string; version: string; directories: string[] }>;
  onLog: (message: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  onScanPath: (path: string) => void;
  onClose: () => void;
}

type TabId = 'export' | 'import';
type ExportMode = 'full-archive' | 'references-only';

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
    hasMachineSettings: false;
    savedVarsCount: number;
    exportedAt: string;
    addonList?: { folderName: string; isLibrary: boolean }[];
  } | null>(null);
  const [importProgress, setImportProgress] = useState<{ phase: string; percent: number } | null>(null);
  // Checkboxes for individual SavedVariables .lua files
  const [savedVarFiles, setSavedVarFiles] = useState<Map<string, boolean>>(new Map());

  // Export checkboxes
  const [includeAddonSettings, setIncludeAddonSettings] = useState(true);
  const [includeSavedVars, setIncludeSavedVars] = useState(true);
  const [includeUserSettings, setIncludeUserSettings] = useState(true);
  const [exportMode, setExportMode] = useState<ExportMode>('full-archive');
  const [includeRuntimeFiles, setIncludeRuntimeFiles] = useState(true);
  // Export addon selection (map folderName → included)
  const [exportAddonSelection, setExportAddonSelection] = useState<Map<string, boolean>>(() => {
    return new Map(addons.map(a => [a.folderName, true]));
  });
  // Import checkboxes for settings files
  const [importAddonSettings, setImportAddonSettings] = useState(true);
  const [importUserSettings, setImportUserSettings] = useState(true);
  // Import addon selection (map folderName → included)
  const [importAddonSelection, setImportAddonSelection] = useState<Map<string, boolean>>(new Map());

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
      const nonLibAddons = addons.filter((a) => !a.isLibrary && exportAddonSelection.get(a.folderName) !== false);
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

      // Build addon list: non-libraries + required libraries (only selected ones)
      const addonList = nonLibAddons.map((a) => ({
        folderName: a.folderName,
        catalogId: catalogByDir.get(a.folderName)?.id,
        version: a.version,
        isLibrary: false,
      }));

      for (const libName of requiredLibs) {
        const lib = allAddonsByName.get(libName)!;
        if (exportAddonSelection.get(lib.folderName) === false) continue;
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

      if (exportMode === 'full-archive') {
        // Build runtime files map for exclusion if needed
        const runtimeFilesMap: Record<string, string[]> = {};
        if (!includeRuntimeFiles) {
          for (const a of addons) {
            if (a.runtimeFiles && a.runtimeFiles.length > 0 && exportAddonSelection.get(a.folderName) !== false) {
              runtimeFilesMap[a.folderName] = a.runtimeFiles;
            }
          }
        }
        // ZIP export — main process builds zip + shows save dialog
        const zipResult = await window.electronAPI.exportProfileAsZip(
          addonPath,
          addonList,
          bundleFolders.length > 0 ? bundleFolders : undefined,
          { includeAddonSettings, includeSavedVars, includeUserSettings, excludeRuntimeFiles: !includeRuntimeFiles ? runtimeFilesMap : undefined }
        );
        if ('error' in zipResult && zipResult.error) {
          onLog(`Export failed: ${zipResult.error}`, 'error');
          return;
        }
        if (zipResult.canceled) {
          onLog('Export canceled', 'info');
          return;
        }
        const sizeMB = ((zipResult.size || 0) / 1024 / 1024).toFixed(1);
        onLog(`Exported profile as ZIP (${sizeMB} MB): ${zipResult.filePath}`, 'success');
      } else {
        // JSON export — references + SavedVariables
        // Build runtime files map if user wants to include addon-created data
        let jsonRuntimeMap: Record<string, string[]> | undefined;
        if (includeRuntimeFiles) {
          const map: Record<string, string[]> = {};
          for (const a of addons) {
            if (a.runtimeFiles && a.runtimeFiles.length > 0 && exportAddonSelection.get(a.folderName) !== false) {
              map[a.folderName] = a.runtimeFiles;
            }
          }
          if (Object.keys(map).length > 0) jsonRuntimeMap = map;
        }
        const result = await window.electronAPI.exportProfile(addonPath, addonList, bundleFolders.length > 0 ? bundleFolders : undefined, jsonRuntimeMap);
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
      }
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

    const isZip = file.name.toLowerCase().endsWith('.zip');

    if (isZip) {
      // ZIP file — use main process for preview
      try {
        const filePath = (file as File & { path: string }).path;
        const preview = await window.electronAPI.previewProfileZip(filePath);
        if ('error' in preview && preview.error) {
          onLog(`Invalid ZIP profile: ${preview.error}`, 'error');
          setImportFile(null);
          return;
        }
        setImportAddonSettings(preview.hasSettings);
        setImportUserSettings(preview.hasUserSettings);
        const svKeys = (preview.savedVarFiles || []).sort();
        setSavedVarFiles(new Map(svKeys.map((k: string) => [k, true])));
        const addonList = (preview.addonList || []) as { folderName: string; isLibrary: boolean }[];
        setImportAddonSelection(new Map(addonList.map((a: { folderName: string }) => [a.folderName, true])));
        setImportPreview({
          totalAddons: preview.totalAddons,
          totalLibraries: preview.totalLibraries,
          bundledCount: preview.bundledCount,
          hasSettings: preview.hasSettings,
          hasUserSettings: preview.hasUserSettings,
          hasMachineSettings: false,
          savedVarsCount: preview.savedVarsCount,
          exportedAt: preview.exportedAt,
          addonList,
        });
      } catch {
        onLog('Failed to read ZIP profile', 'error');
        setImportFile(null);
      }
    } else {
      // JSON file — current behavior
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.formatVersion == null || !Array.isArray(data.addons)) {
          onLog('Invalid export file format', 'error');
          setImportFile(null);
          return;
        }
        setImportAddonSettings(!!data.addonSettings);
        setImportUserSettings(!!data.userSettings);

        const svKeys = Object.keys(data.savedVariables || {}).sort();
        setSavedVarFiles(new Map(svKeys.map((k) => [k, true])));

        const addonList = (data.addons || []).map((a: { folderName: string; isLibrary: boolean }) => ({
          folderName: a.folderName,
          isLibrary: a.isLibrary,
        }));
        setImportAddonSelection(new Map(addonList.map((a: { folderName: string }) => [a.folderName, true])));
        setImportPreview({
          totalAddons: data.addons.filter((a: { isLibrary: boolean }) => !a.isLibrary).length,
          totalLibraries: data.addons.filter((a: { isLibrary: boolean }) => a.isLibrary).length,
          bundledCount: data.bundledAddons ? Object.keys(data.bundledAddons).length : 0,
          hasSettings: !!data.addonSettings,
          hasUserSettings: !!data.userSettings,
          hasMachineSettings: false,
          savedVarsCount: svKeys.length,
          exportedAt: data.exportedAt,
          addonList,
        });
      } catch {
        onLog('Failed to parse export file — is it valid JSON?', 'error');
        setImportFile(null);
      }
    }
  };

  // --- Import: execute ---
  const handleImport = async () => {
    if (!importFile || !addonPath) return;
    setImporting(true);
    setImportProgress({ phase: 'Reading file…', percent: 5 });

    const isZip = importFile.name.toLowerCase().endsWith('.zip');

    try {
      let result: { addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; restoredBundles: string[]; errors: string[] };

      if (isZip) {
        // ZIP import — use file path + main process
        const filePath = (importFile as File & { path: string }).path;
        const savedVarFilter: Record<string, boolean> = {};
        for (const [k, v] of savedVarFiles) savedVarFilter[k] = v;
        const addonFilter: Record<string, boolean> = {};
        for (const [k, v] of importAddonSelection) addonFilter[k] = v;

        setImportProgress({ phase: 'Restoring from ZIP…', percent: 20 });
        result = await window.electronAPI.importProfileFromZip(addonPath, filePath, {
          importAddonSettings,
          importUserSettings,
          savedVarFilter,
          addonFilter,
        });
      } else {
        // JSON import — current behavior
        const text = await importFile.text();
        const data = JSON.parse(text);
        setImportProgress({ phase: 'Parsing…', percent: 10 });

        if (!importAddonSettings) data.addonSettings = null;
        if (!importUserSettings) data.userSettings = null;
        if (data.savedVariables) {
          const filtered: Record<string, string> = {};
          for (const [fileName, content] of Object.entries(data.savedVariables)) {
            if (savedVarFiles.get(fileName) !== false) {
              filtered[fileName] = content as string;
            }
          }
          data.savedVariables = filtered;
        }

        setImportProgress({ phase: 'Restoring settings…', percent: 20 });
        result = await window.electronAPI.importProfile(addonPath, data);
      }

      for (const s of result.restoredSettings) {
        onLog(`Restored: ${s}`, 'success');
      }
      if (result.restoredBundles.length > 0) {
        onLog(`Restored ${result.restoredBundles.length} bundled addon(s): ${result.restoredBundles.join(', ')}`, 'success');
      }
      for (const e of result.errors) {
        onLog(`Import error: ${e}`, 'error');
      }

      // Step 2: Install missing addons from catalog (only selected ones)
      const selectedAddons = new Set(
        Array.from(importAddonSelection.entries())
          .filter(([, v]) => v)
          .map(([k]) => k)
      );
      const toInstall = result.addonsToInstall.filter((a) => a.catalogId && selectedAddons.has(a.folderName));
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

      const noCatalog = result.addonsToInstall.filter((a) => !a.catalogId && selectedAddons.has(a.folderName));
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
                Export addon references, settings, and saved data for import on another system.
              </p>

              {/* Export mode radio buttons */}
              <div className="ie-options" style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.786rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>Export Mode</div>
                <label className="ie-option">
                  <input
                    type="radio"
                    name="exportMode"
                    checked={exportMode === 'full-archive'}
                    onChange={() => setExportMode('full-archive')}
                  />
                  📦 Full Archive (ZIP with all AddOn folders + SavedVariables)
                </label>
                <label className="ie-option">
                  <input
                    type="radio"
                    name="exportMode"
                    checked={exportMode === 'references-only'}
                    onChange={() => setExportMode('references-only')}
                  />
                  📋 References + SavedVariables (JSON, addons installed from ESOUI on import)
                </label>
                {exportMode === 'references-only' && (
                  <>
                    <div style={{
                      margin: '4px 0 0 22px', padding: '6px 10px', fontSize: '0.786rem',
                      background: 'var(--warning-bg, rgba(255,180,0,0.1))',
                      color: 'var(--warning-text, #e0a000)',
                      borderRadius: 4, borderLeft: '3px solid var(--warning-text, #e0a000)',
                    }}>
                      ⚠️ Some addons store data (caches, databases) in their own folder.
                      These files may <strong>not</strong> be included in this export mode
                      {addons.some(a => a.runtimeFiles && a.runtimeFiles.length > 0) && (
                        <span> — <strong>{addons.filter(a => a.runtimeFiles && a.runtimeFiles.length > 0).length}</strong> addon(s) have extra files</span>
                      )}.
                    </div>
                    <label className="ie-option" style={{ marginLeft: 22 }}>
                      <input
                        type="checkbox"
                        checked={includeRuntimeFiles}
                        onChange={(e) => setIncludeRuntimeFiles(e.target.checked)}
                      />
                      Include addon-created data files (caches, databases)
                    </label>
                  </>
                )}
              </div>

              {/* Settings checkboxes */}
              <div className="ie-options">
                <div style={{ fontSize: '0.786rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>Include Settings</div>
                <label className="ie-option">
                  <input type="checkbox" checked={includeAddonSettings} onChange={(e) => setIncludeAddonSettings(e.target.checked)} />
                  ⚙️ AddOnSettings.txt (addon on/off per character)
                </label>
                <label className="ie-option">
                  <input type="checkbox" checked={includeUserSettings} onChange={(e) => setIncludeUserSettings(e.target.checked)} />
                  🎮 UserSettings.txt (keybinds, graphics, audio)
                </label>
                <label className="ie-option">
                  <input type="checkbox" checked={includeSavedVars} onChange={(e) => setIncludeSavedVars(e.target.checked)} />
                  💾 SavedVariables (addon saved data)
                </label>
              </div>

              {/* AddOn selection list */}
              <div className="ie-sv-section" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 10, marginTop: 10 }}>
                <div className="ie-sv-header">
                  <span>🧩 AddOns ({Array.from(exportAddonSelection.values()).filter(Boolean).length}/{exportAddonSelection.size})</span>
                  <span className="ie-sv-toggle-all">
                    <button
                      className="ie-sv-toggle-btn"
                      onClick={() => {
                        const allOn = Array.from(exportAddonSelection.values()).every(Boolean);
                        setExportAddonSelection(new Map(Array.from(exportAddonSelection.keys()).map(k => [k, !allOn])));
                      }}
                    >
                      {Array.from(exportAddonSelection.values()).every(Boolean) ? 'Deselect All' : 'Select All'}
                    </button>
                  </span>
                </div>
                <div className="ie-sv-list">
                  {addons
                    .filter(a => !a.isLibrary)
                    .sort((a, b) => a.folderName.localeCompare(b.folderName))
                    .map(addon => (
                      <label key={addon.folderName} className="ie-sv-item">
                        <input
                          type="checkbox"
                          checked={exportAddonSelection.get(addon.folderName) !== false}
                          onChange={(e) => {
                            setExportAddonSelection(prev => {
                              const next = new Map(prev);
                              next.set(addon.folderName, e.target.checked);
                              return next;
                            });
                          }}
                        />
                        <span className="ie-sv-name">
                          {addon.folderName}
                          {addon.runtimeFiles && addon.runtimeFiles.length > 0 && (
                            <span style={{ color: 'var(--warning-text, #e0a000)', marginLeft: 4, fontSize: '0.714rem' }}
                              title={`${addon.runtimeFiles.length} extra file(s): ${addon.runtimeFiles.slice(0, 5).join(', ')}${addon.runtimeFiles.length > 5 ? '…' : ''}`}>
                              📂+{addon.runtimeFiles.length}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                </div>
              </div>

              {exportProgress && (
                <div style={{ margin: '12px 0' }}>
                  <div style={{ fontSize: '0.857rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
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
                  accept=".json,.zip"
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

                  {(importPreview.hasSettings || importPreview.hasUserSettings) && (
                    <div className="ie-options" style={{ marginTop: 10 }}>
                      <div style={{ fontSize: '0.786rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>General Settings</div>
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
                  )}

                  {/* AddOn selection list */}
                  {importPreview.addonList && importPreview.addonList.length > 0 && (
                    <div className="ie-sv-section" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 10, marginTop: 10 }}>
                      <div className="ie-sv-header">
                        <span>🧩 AddOns ({Array.from(importAddonSelection.values()).filter(Boolean).length}/{importAddonSelection.size})</span>
                        <span className="ie-sv-toggle-all">
                          <button
                            className="ie-sv-toggle-btn"
                            onClick={() => {
                              const allOn = Array.from(importAddonSelection.values()).every(Boolean);
                              setImportAddonSelection(new Map(Array.from(importAddonSelection.keys()).map(k => [k, !allOn])));
                            }}
                          >
                            {Array.from(importAddonSelection.values()).every(Boolean) ? 'Deselect All' : 'Select All'}
                          </button>
                        </span>
                      </div>
                      <div className="ie-sv-list">
                        {importPreview.addonList
                          .sort((a, b) => a.folderName.localeCompare(b.folderName))
                          .map(addon => (
                            <label key={addon.folderName} className="ie-sv-item">
                              <input
                                type="checkbox"
                                checked={importAddonSelection.get(addon.folderName) !== false}
                                onChange={(e) => {
                                  setImportAddonSelection(prev => {
                                    const next = new Map(prev);
                                    next.set(addon.folderName, e.target.checked);
                                    return next;
                                  });
                                }}
                              />
                              <span className="ie-sv-name">
                                {addon.folderName}
                                {addon.isLibrary && <span style={{ opacity: 0.5, marginLeft: 4, fontSize: '0.714rem' }}>📚</span>}
                              </span>
                            </label>
                          ))}
                      </div>
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
                  <div style={{ fontSize: '0.857rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
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

        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px 12px', borderTop: '1px solid var(--border)', gap: 8 }}>
          <div>
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
          </div>
          <button className="restore-btn ie-action-btn" onClick={onClose}>Exit</button>
        </div>
      </div>
    </div>
  );
};

export default ImportExportDialog;
