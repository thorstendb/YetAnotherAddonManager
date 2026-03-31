// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from 'react';

interface AboutDialogProps {
  onClose: () => void;
}

const AboutDialog: React.FC<AboutDialogProps> = ({ onClose }) => {
  const [version, setVersion] = useState('');

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
          <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            YAAM – Yet Another Addon Manager
          </p>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '4px 0 16px' }}>
            Version {version || '…'}
          </p>
          <p>
            A lightweight addon manager for<br />
            The Elder Scrolls Online.
          </p>
          <p style={{ margin: '16px 0' }}>
            <button onClick={openRepo} className="btn-secondary" style={{ cursor: 'pointer' }}>
              🔗 GitHub Repository
            </button>
          </p>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
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
