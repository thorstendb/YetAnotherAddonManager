// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';

interface SettingsDialogProps {
  fontSize: number;
  fontFamily: string;
  skipCleanupConfirm: boolean;
  onApply: (settings: { fontSize: number; fontFamily: string; skipCleanupConfirm: boolean }) => void;
  onClose: () => void;
}

const DEFAULT_FONT = "'Segoe UI', sans-serif";

const SettingsDialog: React.FC<SettingsDialogProps> = ({
  fontSize,
  fontFamily,
  skipCleanupConfirm,
  onApply,
  onClose,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [localFontSize, setLocalFontSize] = useState(fontSize);
  const [localFontFamily, setLocalFontFamily] = useState(fontFamily);
  const [localSkipCleanup, setLocalSkipCleanup] = useState(skipCleanupConfirm);
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
    onApply({ fontSize: localFontSize, fontFamily: localFontFamily, skipCleanupConfirm: localSkipCleanup });
    onClose();
  };

  const handleReset = () => {
    setLocalFontSize(14);
    setLocalFontFamily(DEFAULT_FONT);
    setLocalSkipCleanup(false);
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
            <label className="settings-label">Font Size</label>
            <div className="settings-control">
              <input
                type="range"
                min={10}
                max={22}
                step={1}
                value={localFontSize}
                onChange={(e) => setLocalFontSize(Number(e.target.value))}
              />
              <span className="settings-value">{localFontSize}px</span>
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
          <div className="settings-preview" style={{ fontFamily: localFontFamily, fontSize: localFontSize }}>
            <span style={{ opacity: 0.5, fontSize: '11px' }}>{displayFontName(localFontFamily)}</span>
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
