// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React from 'react';
import { ColorSegment } from '../../electron/shared/types';

interface ColoredTextProps {
  segments: ColorSegment[];
  className?: string;
}

/**
 * Renders color-coded text as styled <span> elements.
 */
const ColoredText: React.FC<ColoredTextProps> = ({ segments, className }) => {
  if (!segments || segments.length === 0) return null;

  return (
    <span className={className}>
      {segments.map((seg, i) => (
        <span key={i} style={seg.color ? { color: seg.color } : undefined}>
          {seg.text}
        </span>
      ))}
    </span>
  );
};

export default ColoredText;
