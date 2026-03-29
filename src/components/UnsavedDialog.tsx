// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef } from 'react';

interface UnsavedDialogProps {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

const UnsavedDialog: React.FC<UnsavedDialogProps> = ({ onSave, onDiscard, onCancel }) => {
  const saveRef = useRef<HTMLButtonElement>(null);

  // Focus the Save button on mount, handle Escape key
  useEffect(() => {
    saveRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="unsaved-overlay" onClick={onCancel}>
      <div className="unsaved-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="unsaved-icon">⚠️</div>
        <div className="unsaved-title">Unsaved Changes</div>
        <div className="unsaved-message">
          You have unsaved character setting changes.<br />
          Do you want to save them before exiting?
        </div>
        <div className="unsaved-actions">
          <button ref={saveRef} className="unsaved-btn unsaved-btn-save" onClick={onSave}>
            💾 Save &amp; Exit
          </button>
          <button className="unsaved-btn unsaved-btn-discard" onClick={onDiscard}>
            🗑️ Discard &amp; Exit
          </button>
          <button className="unsaved-btn unsaved-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default UnsavedDialog;
