// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React from 'react';
import { shortenCharName } from '../App';

interface TreePanelProps {
  title: string;
  count: number;
  children: React.ReactNode;
  scrollRef?: React.RefObject<HTMLDivElement>;
  flex?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  characters?: string[];
  characterFilter?: string;
  onCharacterFilterChange?: (value: string) => void;
  hasPendingChanges?: boolean;
  onSave?: () => void;
  onCollapseAll?: () => void;
}

const TreePanel: React.FC<TreePanelProps> = ({ title, count, children, scrollRef, flex, onKeyDown, searchQuery, onSearchChange, characters, characterFilter, onCharacterFilterChange, hasPendingChanges, onSave, onCollapseAll }) => {
  return (
    <div className="tree-panel" style={flex != null ? { flex } : undefined}>
      <div className="tree-panel-header">
        <span>{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {onCollapseAll && (
            <button className="collapse-all-btn" onClick={onCollapseAll} title="Collapse all">⏶</button>
          )}
          <span className="count">{count}</span>
        </div>
      </div>
      {onSearchChange != null && (
        <div className="tree-search-bar">
          <span className="tree-search-icon" title="Search">🔍</span>
          <input
            type="text"
            className="tree-search-input"
            value={searchQuery || ''}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={`Search ${title.toLowerCase()}...`}
            spellCheck={false}
          />
          {searchQuery && (
            <button className="tree-search-clear" onClick={() => onSearchChange('')} title="Clear search">✕</button>
          )}
          {characters && characters.length > 0 && onCharacterFilterChange && (
            <select
              className="tree-char-filter"
              value={characterFilter || ''}
              onChange={(e) => onCharacterFilterChange(e.target.value)}
              title="Filter by character"
            >
              <option value="">All characters</option>
              {characters.map((c) => (
                <option key={c} value={c}>{shortenCharName(c)}</option>
              ))}
            </select>
          )}
          {hasPendingChanges && onSave && (
            <button
              className="tree-save-btn"
              onClick={onSave}
              title="Save pending character setting changes (game must be closed or at login screen)"
            >
              💾 Save
            </button>
          )}
        </div>
      )}
      <div className="tree-scroll" ref={scrollRef ?? null} tabIndex={0} onKeyDown={onKeyDown}>{children}</div>
    </div>
  );
};

export default TreePanel;
