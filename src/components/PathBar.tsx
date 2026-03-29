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
  onUpdateAll: () => void;
  onGoBack: () => void;
  onImportExport: () => void;
  onAbout: () => void;
  loading: boolean;
  hasAddons: boolean;
  unreferencedCount: number;
  updateCount: number;
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
  onUpdateAll,
  onGoBack,
  onImportExport,
  onAbout,
  loading,
  hasAddons,
  unreferencedCount,
  updateCount,
  updatingAll,
  updateRemaining,
  theme,
  onToggleTheme,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSave(path);
    }
  };

  return (
    <div className="toolbar">
      <label>AddOns Path:</label>
      <input
        type="text"
        value={path}
        onChange={(e) => onPathChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="~/Documents/Elder Scrolls Online/live/AddOns"
        spellCheck={false}
      />
      <button onClick={onBrowse} title="Browse for folder">
        📂
      </button>
      <button onClick={() => onSave(path)} disabled={!path || loading} title="Save path and scan">
        💾
      </button>
      <button onClick={onRefresh} disabled={!path || loading} title="Re-scan addons">
        🔄
      </button>
      <button onClick={onOpenFolder} disabled={!path} title="Open folder in file manager">
        📁
      </button>
      <div className="toolbar-separator" />
      <button
        onClick={onCleanup}
        disabled={!hasAddons || loading || unreferencedCount === 0}
        title={`Move ${unreferencedCount} unreferenced libraries to Removed/ folder`}
        className="btn-warning"
      >
        🧹 Cleanup Libs ({unreferencedCount})
      </button>
      <button
        onClick={onCleanupSettings}
        disabled={!hasAddons || loading}
        title="Remove orphaned entries from AddOnSettings.txt and SavedVariables (creates backups)"
        className="btn-warning"
      >
        🗑️ Cleanup Settings
      </button>
      <button
        onClick={onCleanupDownloads}
        disabled={!path || loading}
        title="Move .zip archives from AddOns folder into Downloads subfolder"
        className="btn-warning"
      >
        📦 Cleanup Archives
      </button>
      <button
        onClick={onUpdateAll}
        disabled={!updatingAll && (!hasAddons || loading || updateCount === 0)}
        title={updatingAll ? 'Cancel update' : updateCount > 0 ? `Update ${updateCount} addon(s) with newer versions from catalog` : 'All addons are up-to-date'}
        className={updatingAll ? 'btn-warning' : 'btn-secondary'}
      >
        {updatingAll ? `❌ Cancel Update${updateRemaining ? ` (${updateRemaining} left)` : ''}` : `⬆ Update All${updateCount > 0 ? ` (${updateCount})` : ''}`}
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
      <button
        onClick={onToggleTheme}
        className="theme-toggle"
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
      <button
        onClick={onAbout}
        className="theme-toggle"
        title="About YAAM"
      >
        ℹ️
      </button>
    </div>
  );
};

export default PathBar;
