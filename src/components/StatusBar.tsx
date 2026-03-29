// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useMemo } from 'react';

interface StatusBarProps {
  totalAddons: number;
  totalLibraries: number;
  unreferencedCount: number;
  loading: boolean;
  installProgress: Record<string, { phase: string; percent?: number }>;
  updateTotal: number;
  updateRemaining: number;
}

const StatusBar: React.FC<StatusBarProps> = ({
  totalAddons,
  totalLibraries,
  unreferencedCount,
  loading,
  installProgress,
  updateTotal,
  updateRemaining,
}) => {
  // Current single-addon download progress (pick the first one that has a percent)
  const currentProgress = useMemo(() => {
    const entries = Object.values(installProgress);
    if (entries.length === 0) return null;
    // Find the one that's downloading with a percent
    const downloading = entries.find((e) => e.phase === 'downloading' && e.percent !== undefined);
    if (downloading) return { phase: 'downloading', percent: downloading.percent! };
    const resolving = entries.find((e) => e.phase === 'resolving');
    if (resolving) return { phase: 'resolving', percent: 0 };
    const extracting = entries.find((e) => e.phase === 'extracting');
    if (extracting) return { phase: 'extracting', percent: extracting.percent ?? 100 };
    return null;
  }, [installProgress]);

  // Overall batch progress
  const batchPercent = updateTotal > 0
    ? Math.round(((updateTotal - updateRemaining) / updateTotal) * 100)
    : 0;

  const hasCurrentProgress = currentProgress !== null;
  const hasBatchProgress = updateTotal > 0;

  return (
    <div className="status-bar">
      <div className="status-bar-stats">
        <div className="stat">
          AddOns: <span className="stat-value">{totalAddons}</span>
        </div>
        <div className="stat">
          Libraries: <span className="stat-value">{totalLibraries}</span>
        </div>
        <div className="stat">
          Unreferenced Libraries:{' '}
          <span className="stat-value" style={{ color: unreferencedCount > 0 ? 'var(--yellow)' : undefined }}>
            {unreferencedCount}
          </span>
        </div>
        {loading && (
          <div className="stat" style={{ color: 'var(--accent)' }}>
            Scanning...
          </div>
        )}
      </div>
      {(hasCurrentProgress || hasBatchProgress) && (
        <div className="status-bar-progress">
          {hasCurrentProgress && (
            <div className="status-progress-track" title={`${currentProgress!.phase} ${currentProgress!.percent}%`}>
              <div
                className="status-progress-fill status-progress-current"
                style={{ width: `${currentProgress!.percent}%` }}
              />
            </div>
          )}
          {hasBatchProgress && (
            <div className="status-progress-track" title={`Overall: ${updateTotal - updateRemaining}/${updateTotal}`}>
              <div
                className="status-progress-fill status-progress-batch"
                style={{ width: `${batchPercent}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StatusBar;
