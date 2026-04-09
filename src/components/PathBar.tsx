// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React from 'react';

interface PathBarProps {
  path: string;
  onPathChange: (path: string) => void;
  onBrowse: () => void;
  onSave: (path: string) => void;
  onRefresh: () => void;
  onOpenFolder: () => void;
  onCleanup: () => void;
  onCleanupSettings: () => void;
  onCleanupDownloads: () => void;
  onCleanupBackups: () => void;
  onUpdateAll: () => void;
  onGoBack: () => void;
  onImportExport: () => void;
  onAbout: () => void;
  onSettings: () => void;
  loading: boolean;
  hasAddons: boolean;
  unreferencedCount: number;
  updateCount: number;
  mightUpdateCount?: number;
  replacementCount?: number;
  updatingAll?: boolean;
  updateRemaining?: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

const PathBar: React.FC<PathBarProps> = ({
  path,
  onPathChange,
  onBrowse,
  onSave,
  onRefresh,
  onOpenFolder,
  onCleanup,
  onCleanupSettings,
  onCleanupDownloads,
  onCleanupBackups,
  onUpdateAll,
  onGoBack,
  onImportExport,
  onAbout,
  onSettings,
  loading,
  hasAddons,
  unreferencedCount,
  updateCount,
  mightUpdateCount = 0,
  replacementCount = 0,
  updatingAll,
  updateRemaining,
  theme,
  onToggleTheme,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleBlur = () => {
    if (path) onSave(path);
  };

  return (
    <div className="toolbar">
      <fieldset className="toolbar-group path-field">
        <legend>Addon Path</legend>
        <input
          type="text"
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder="~/Documents/Elder Scrolls Online/live/AddOns"
          spellCheck={false}
        />
      </fieldset>
      <fieldset className="toolbar-group">
        <legend>Path</legend>
        <button onClick={onBrowse} title="Browse for folder" aria-label="Browse for folder">
          📂
        </button>
        <button onClick={onRefresh} disabled={!path || loading} title="Re-scan addons" aria-label="Re-scan addons">
          🔄
        </button>
        <button onClick={onOpenFolder} disabled={!path} title="Open folder in file manager" aria-label="Open folder in file manager">
          ↗️
        </button>
      </fieldset>
      <fieldset className="toolbar-group">
        <legend>Cleanup</legend>
        <button
          onClick={onCleanup}
          disabled={!hasAddons || loading || unreferencedCount === 0}
          title={unreferencedCount === 0 ? `Libs — Move unreferenced libraries to Removed/\nNothing to clean up` : `Libs — Move unreferenced libraries to Removed/\n${unreferencedCount} unreferenced lib(s) found`}
          className="btn-warning"
        >
          🧹 {unreferencedCount > 0 && <>({unreferencedCount})</>}
        </button>
        <button
          onClick={onCleanupSettings}
          disabled={!hasAddons || loading}
          title={`Settings — Remove orphaned saved variables\nCleans AddOnSettings.txt and SavedVariables (creates backups)`}
          className="btn-warning"
        >
          🗑️
        </button>
        <button
          onClick={onCleanupDownloads}
          disabled={!path || loading}
          title={`Archives — Move .zip files to Downloads/\nMoves archives from AddOns folder into subfolder`}
          className="btn-warning"
        >
          📦
        </button>
        <button
          onClick={onCleanupBackups}
          disabled={!hasAddons || loading}
          title={`Backups — Delete old addon backups\nFree disk space by removing outdated backup files`}
          aria-label="Delete old addon backups"
          className="btn-warning"
        >
          🗄️
        </button>
      </fieldset>
      <fieldset className="toolbar-group">
        <legend>Updates</legend>
        <button
          onClick={onUpdateAll}
          disabled={!updatingAll && (!hasAddons || loading || (updateCount === 0 && mightUpdateCount === 0 && replacementCount === 0))}
          title={updatingAll ? 'Cancel update' : updateCount > 0 ? `Update ${updateCount} addon(s) with newer versions from catalog` : mightUpdateCount > 0 ? `${mightUpdateCount} addon(s) might have updates` : replacementCount > 0 ? `${replacementCount} addon(s) have replacements available` : 'All addons are up-to-date'}
          className={updatingAll ? 'btn-warning' : 'btn-secondary'}
        >
          {updatingAll ? `❌ Cancel Update${updateRemaining ? ` (${updateRemaining} left)` : ''}` : `⬆ Update All${updateCount > 0 ? ` (${updateCount})` : mightUpdateCount > 0 ? ` (${mightUpdateCount}?)` : ''}`}
        </button>
        <button
          onClick={onGoBack}
          disabled={!hasAddons || loading}
          title="Restore previous addon versions from backups"
          className="btn-secondary"
        >
          ⏪ Go Back
        </button>
        <button
          onClick={onImportExport}
          disabled={loading}
          title="Import or export addon profile (addons, settings, saved data)"
          className="btn-secondary"
        >
          📋 Import/Export
        </button>
      </fieldset>
      <fieldset className="toolbar-group">
        <legend>App</legend>
        <button
          onClick={onSettings}
          className="theme-toggle"
          title="Settings"
          aria-label="Settings"
        >
          ⚙️
        </button>
        <button
          onClick={onToggleTheme}
          className="theme-toggle"
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button
          onClick={onAbout}
          className="theme-toggle"
          title="About YAAM"
          aria-label="About YAAM"
        >
          ℹ️
        </button>
      </fieldset>
    </div>
  );
};

export default PathBar;
