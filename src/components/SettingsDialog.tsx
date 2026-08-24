// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

interface SettingsDialogProps {
  fontScale: number;
  fontFamily: string;
  skipCleanupConfirm: boolean;
  autoUpdateOnStart: boolean;
  showDependencies: boolean;
  onApply: (settings: { fontScale: number; fontFamily: string; skipCleanupConfirm: boolean; autoUpdateOnStart: boolean; showDependencies: boolean }) => void;
  onCleanupMarkers?: () => void;
  onClose: () => void;
}

const DEFAULT_FONT = "'Segoe UI', sans-serif";

const SettingsDialog: React.FC<SettingsDialogProps> = ({
  fontScale,
  fontFamily,
  skipCleanupConfirm,
  autoUpdateOnStart,
  showDependencies,
  onApply,
  onCleanupMarkers,
  onClose,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [localFontScale, setLocalFontScale] = useState(fontScale);
  const [localFontFamily, setLocalFontFamily] = useState(fontFamily);
  const [localSkipCleanup, setLocalSkipCleanup] = useState(skipCleanupConfirm);
  const [localAutoUpdate, setLocalAutoUpdate] = useState(autoUpdateOnStart);
  const [localShowDeps, setLocalShowDeps] = useState(showDependencies);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    window.electronAPI.getSystemFonts().then((fonts) => {
      setSystemFonts(fonts);
    });
  }, []);

  const handleApply = () => {
    onApply({
      fontScale: localFontScale,
      fontFamily: localFontFamily,
      skipCleanupConfirm: localSkipCleanup,
      autoUpdateOnStart: localAutoUpdate,
      showDependencies: localShowDeps,
    });
    onClose();
  };

  const handleReset = () => {
    setLocalFontScale(100);
    setLocalFontFamily(DEFAULT_FONT);
    setLocalSkipCleanup(false);
    setLocalAutoUpdate(false);
    setLocalShowDeps(true);
  };

  // Extract the primary font name from a CSS font-family string for display
  const displayFontName = (css: string) => css.replace(/^'|'$/g, '').split(',')[0].trim().replace(/^'|'$/g, '');

  return (
    <div className="unsaved-overlay">
      <div className="restore-dialog settings-dialog">
        <div className="restore-header">
          <div className="restore-title">⚙️ Settings</div>
          <button ref={closeRef} className="restore-close-btn" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="restore-content" style={{ padding: '16px 20px' }}>
          <div className="settings-row">
            <label className="settings-label">Font Scale</label>
            <div className="settings-control">
              <input
                type="range"
                min={75}
                max={150}
                step={5}
                value={localFontScale}
                onChange={(e) => setLocalFontScale(Number(e.target.value))}
              />
              <span className="settings-value">{localFontScale}%</span>
            </div>
          </div>
          <div className="settings-row">
            <label className="settings-label">Font</label>
            <div className="settings-control">
              <select
                value={localFontFamily}
                onChange={(e) => setLocalFontFamily(e.target.value)}
                className="settings-select"
              >
                <option value={DEFAULT_FONT}>System Default</option>
                {systemFonts.map((f) => (
                  <option key={f} value={`'${f}', sans-serif`} style={{ fontFamily: f }}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="settings-preview" style={{ fontFamily: localFontFamily, fontSize: `${14 * localFontScale / 100}px` }}>
            <span style={{ opacity: 0.5, fontSize: '0.786rem' }}>{displayFontName(localFontFamily)}</span>
            <br />
            ABCabc 0123456789 — Preview
          </div>
          <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0', paddingTop: '12px' }}>
            <label className="settings-row" style={{ cursor: 'pointer', userSelect: 'none', marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={localSkipCleanup}
                onChange={(e) => setLocalSkipCleanup(e.target.checked)}
              />
              <span className="settings-label" style={{ minWidth: 0 }}>Cleanup without confirmation</span>
            </label>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0', paddingTop: '12px' }}>
            <label className="settings-row" style={{ cursor: 'pointer', userSelect: 'none', marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={localShowDeps}
                onChange={(e) => setLocalShowDeps(e.target.checked)}
              />
              <span className="settings-label" style={{ minWidth: 0 }}>Show dependencies across columns</span>
            </label>
            <div style={{ marginTop: 6, fontSize: '0.857rem', color: 'var(--text-secondary)' }}>
              Relates the three columns: a search also surfaces the dependencies of its hits, and selecting an
              entry pins the libraries it needs, the AddOns that need it, and its counterpart in the catalog to
              the top of the other columns. Off, every column keeps to itself.
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0', paddingTop: '12px' }}>
            <label className="settings-row" style={{ cursor: 'pointer', userSelect: 'none', marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={localAutoUpdate}
                onChange={(e) => setLocalAutoUpdate(e.target.checked)}
              />
              <span className="settings-label" style={{ minWidth: 0 }}>Update all addons on startup</span>
            </label>
            <div style={{ marginTop: 6, fontSize: '0.857rem', color: 'var(--text-secondary)' }}>
              Installs every pending update right after the start-up scan, the same set the ⬆️ badge marks.
              Ambiguous cases stay manual: replacement suggestions, addons whose version cannot be compared,
              and folders a language patch has taken over.
            </div>
          </div>
          {onCleanupMarkers && (
            <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0', paddingTop: '12px' }}>
              <div style={{ marginBottom: 6, fontSize: '0.857rem', color: 'var(--text-secondary)' }}>
                Remove all YAAM tracking files (.yaam.json) from addon folders and reset version tracking.
                Addons will use best-effort update detection until the next install/update.
              </div>
              <button
                className="restore-btn"
                style={{ color: 'var(--red)' }}
                onClick={onCleanupMarkers}
              >
                🗑️ Reset YAAM Tracking
              </button>
            </div>
          )}
          <div className="settings-actions">
            <button className="restore-btn" onClick={handleReset}>
              ↩ Reset
            </button>
            <button className="restore-btn ie-action-btn" onClick={handleApply}>
              ✓ Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsDialog;
