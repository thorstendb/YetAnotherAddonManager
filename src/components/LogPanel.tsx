// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useMemo } from 'react';

export interface LogEntry {
  timestamp: Date;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  action?: { label: string; onClick: () => void };
}

interface LogPanelProps {
  logs: LogEntry[];
  height?: number;
  knownNames?: Set<string>;
  onNavigate?: (name: string) => void;
  onClear?: () => void;
}

const LogPanel: React.FC<LogPanelProps> = ({ logs, height, knownNames, onNavigate, onClear }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Build a regex that matches any known addon/library name (longest first to avoid partial matches)
  const nameRegex = useMemo(() => {
    if (!knownNames || knownNames.size === 0) return null;
    // Sort by length descending so longer names match first
    const sorted = Array.from(knownNames)
      .filter((n) => n.length >= 3) // skip very short names to avoid false matches
      .sort((a, b) => b.length - a.length);
    if (sorted.length === 0) return null;
    const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(?:^|(?<=["\\s(,]))(?:${escaped.join('|')})(?=["\\s),]|$)`, 'g');
  }, [knownNames]);

  // Render a log message with clickable addon names
  const renderMessage = (msg: string) => {
    if (!nameRegex || !onNavigate) return msg;
    const parts: (string | React.ReactElement)[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    nameRegex.lastIndex = 0;
    while ((match = nameRegex.exec(msg)) !== null) {
      if (match.index > lastIndex) {
        parts.push(msg.slice(lastIndex, match.index));
      }
      const name = match[0];
      parts.push(
        <span
          key={`${match.index}-${name}`}
          className="log-link"          role="link"          onClick={() => onNavigate(name)}
          title={`Go to ${name}`}
        >
          {name}
        </span>
      );
      lastIndex = match.index + name.length;
    }
    if (lastIndex < msg.length) {
      parts.push(msg.slice(lastIndex));
    }
    return parts.length > 0 ? parts : msg;
  };

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const levelColors: Record<string, string> = {
    info: 'var(--text-muted)',
    warn: 'var(--yellow)',
    error: 'var(--red)',
    success: 'var(--green)',
  };

  return (
    <div className="log-panel" style={height ? { height } : undefined}>
      <div className="log-panel-header">
        <div className="log-header-left">
          <span>Log</span>
          <span className="count">{logs.length}</span>
        </div>
        <div className="log-header-actions">
          <button
            className="log-action-btn"
            title="Copy selected text or all log entries"
            onClick={() => {
              const sel = window.getSelection();
              // Only use selection if it's within the log scroll area
              const selText = sel && scrollRef.current && scrollRef.current.contains(sel.anchorNode)
                ? sel.toString() : '';
              const text = selText || logs
                .map((e) => `[${e.timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}] ${e.message}`)
                .join('\n');
              if (text) window.electronAPI.writeClipboard(text);
            }}
          >
            Copy
          </button>
          {onClear && (
            <button className="log-action-btn" title="Clear all log entries" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
      </div>
      <div
        className="log-scroll"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={(e) => {
          // Ctrl+A: select only log content, not the whole page
          if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            const sel = window.getSelection();
            if (sel && scrollRef.current) {
              const range = document.createRange();
              range.selectNodeContents(scrollRef.current);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        }}
      >
        {logs.length === 0 ? (
          <div className="log-empty">No log entries</div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="log-entry" style={{ color: levelColors[entry.level] || undefined }}>
              <span className="log-time">[{formatTime(entry.timestamp)}]</span>
              <span className="log-message">
                {renderMessage(entry.message)}
                {entry.action && (
                  <button
                    className="log-action-inline-btn"
                    onClick={entry.action.onClick}
                    title={entry.action.label}
                  >
                    {entry.action.label}
                  </button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LogPanel;
