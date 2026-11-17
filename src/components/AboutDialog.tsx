// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from 'react';
import { AppUpdateCheck } from '../../electron/shared/types';

interface AboutDialogProps {
  onClose: () => void;
  /** Runs the shared update check (also logs and lights the toolbar badge) */
  onCheckUpdates?: () => Promise<AppUpdateCheck>;
}

const AboutDialog: React.FC<AboutDialogProps> = ({ onClose, onCheckUpdates }) => {
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<AppUpdateCheck | null>(null);

  // The Windows menu bar is hidden in release builds, so this button is where
  // most users find Help › Check for Updates…
  const runCheck = async () => {
    if (!onCheckUpdates) return;
    setChecking(true);
    try {
      setCheck(await onCheckUpdates());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion);
  }, []);

  const openRepo = () => {
    window.electronAPI.openExternalUrl('https://github.com/thorstendb/YetAnotherAddonManager');
  };

  return (
    <div className="welcome-overlay">
      <div className="welcome-dialog" style={{ width: 'min(420px, 90vw)' }}>
        <div className="welcome-header">
          <h2>About YAAM</h2>
        </div>
        <div className="welcome-body" style={{ textAlign: 'center' }}>
          <p style={{ fontSize: '1.143rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            YAAM – Yet Another Addon Manager
          </p>
          <p style={{ fontSize: '0.929rem', color: 'var(--text-secondary)', margin: '4px 0 16px' }}>
            Version {version || '…'}
          </p>
          <p>
            A lightweight addon manager for<br />
            The Elder Scrolls Online.
          </p>
          <p style={{ margin: '16px 0', display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={openRepo} className="btn-secondary" style={{ cursor: 'pointer' }}>
              🔗 GitHub Repository
            </button>
            {onCheckUpdates && (
              <button onClick={runCheck} className="btn-secondary" style={{ cursor: 'pointer' }} disabled={checking}>
                {checking ? '⏳ Checking…' : '🔄 Check for Updates'}
              </button>
            )}
          </p>
          {check && (
            <p style={{ fontSize: '0.929rem', margin: '0 0 16px' }}>
              {check.error ? (
                <span style={{ color: 'var(--yellow)' }}>Could not check: {check.error}</span>
              ) : check.newer ? (
                <>
                  <span style={{ color: 'var(--green)', fontWeight: 700 }}>Version {check.latest} is available.</span>{' '}
                  <button
                    onClick={() => window.electronAPI.openExternalUrl(check.url)}
                    className="btn-secondary"
                    style={{ cursor: 'pointer' }}
                  >
                    Open release page
                  </button>
                </>
              ) : (
                <span style={{ color: 'var(--green)' }}>You are up to date.</span>
              )}
            </p>
          )}
          <p style={{ fontSize: '0.857rem', color: 'var(--text-secondary)' }}>
            © 2026 thorstendb · MIT License
          </p>
        </div>
        <div className="welcome-footer" style={{ padding: '12px 24px', display: 'flex', justifyContent: 'center' }}>
          <button onClick={onClose} className="btn-primary">Close</button>
        </div>
      </div>
    </div>
  );
};

export default AboutDialog;
