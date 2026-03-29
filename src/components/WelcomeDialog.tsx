// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React from 'react';

interface WelcomeDialogProps {
  onAccept: () => void;
  onCancel: () => void;
}

const WelcomeDialog: React.FC<WelcomeDialogProps> = ({ onAccept, onCancel }) => {
  return (
    <div className="welcome-overlay">
      <div className="welcome-dialog">
        <div className="welcome-header">
          <span className="welcome-icon">&#9888;&#65038;</span>
          <h2>YAAM - Yet Another Addon Manager</h2>
        </div>
        <div className="welcome-body">
          <p className="welcome-warning">
            <strong>Beta Version</strong>
          </p>
          <p>
            This software is provided <strong>&quot;as is&quot;</strong>, without warranty of any
            kind, express or implied, including but not limited to the warranties of
            merchantability, fitness for a particular purpose, and noninfringement.
          </p>
          <p>
            In no event shall the authors or copyright holders be liable for any claim,
            damages, or other liability arising from the use of this software.
          </p>
          <div className="welcome-backup-notice">
            <strong>Before continuing, please back up:</strong>
            <ul>
              <li>Your <code>AddOns</code> folder</li>
              <li>Your <code>SavedVariables</code> folder</li>
              <li>Your <code>AddOnSettings.txt</code> file</li>
            </ul>
          </div>
          <p className="welcome-hint">
            These are typically located in:<br />
            <code>Documents\Elder Scrolls Online\live\</code>
          </p>
        </div>
        <div className="welcome-footer">
          <button className="welcome-btn welcome-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="welcome-btn welcome-btn-ok" onClick={onAccept}>
            I Understand &mdash; Continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeDialog;
