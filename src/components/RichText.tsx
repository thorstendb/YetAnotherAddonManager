// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React from 'react';

/**
 * Render BBCode-formatted text (from ESOUI API) as styled React elements.
 * Supports: [color="HHHHHH"], [b], [i], [u], [size="N"], [url], [url="..."],
 *           [list], [*], [img], [font], [indent], and ESO |cHHHHHH / |r color codes.
 */
export function renderBBCode(raw: string): React.ReactNode {
  if (!raw) return null;
  // First pass: convert ESO |cHHHHHH / |r codes to BBCode equivalents
  let text = raw
    .replace(/\|c([0-9a-fA-F]{6})/g, '[color="$1"]')
    .replace(/\|r/g, '[/color]');

  return parseBBNodes(text, 0).nodes;
}

interface ParseResult {
  nodes: React.ReactNode[];
  pos: number;
}

let keyCounter = 0;

function parseBBNodes(text: string, start: number, stopTag?: string): ParseResult {
  const nodes: React.ReactNode[] = [];
  let buffer = '';
  let i = start;

  const flushBuffer = () => {
    if (buffer) {
      nodes.push(buffer);
      buffer = '';
    }
  };

  while (i < text.length) {
    // Check for closing tag we're looking for
    if (stopTag && text[i] === '[' && text.substring(i, i + stopTag.length + 3).toLowerCase() === `[/${stopTag}]`) {
      flushBuffer();
      return { nodes, pos: i + stopTag.length + 3 };
    }

    if (text[i] === '[') {
      // Try to parse a BBCode tag — supports [TAG], [TAG="val"], [TAG=val]
      const tagMatch = text.substring(i).match(/^\[(\w+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/i);
      if (tagMatch) {
        const tag = tagMatch[1].toLowerCase();
        const attr = tagMatch[2] ?? tagMatch[3]; // quoted or unquoted
        const tagEnd = i + tagMatch[0].length;

        if (tag === 'color' && attr) {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'color');
          const hex = attr.startsWith('#') ? attr : `#${attr}`;
          nodes.push(<span key={++keyCounter} style={{ color: hex }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'b') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'b');
          nodes.push(<strong key={++keyCounter}>{inner.nodes}</strong>);
          i = inner.pos;
          continue;
        } else if (tag === 'i') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'i');
          nodes.push(<em key={++keyCounter}>{inner.nodes}</em>);
          i = inner.pos;
          continue;
        } else if (tag === 'u') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'u');
          nodes.push(<span key={++keyCounter} style={{ textDecoration: 'underline' }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'size' && attr) {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'size');
          // Handle relative sizes like +1, +2 and absolute sizes
          const relative = attr.startsWith('+') || attr.startsWith('-');
          const num = parseInt(attr, 10) || 0;
          const px = relative
            ? Math.min(Math.max(13 + num * 2, 8), 28)
            : Math.min(Math.max(num, 8), 28);
          nodes.push(<span key={++keyCounter} style={{ fontSize: `${px}px` }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'url') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'url');
          const href = attr || (inner.nodes.length === 1 && typeof inner.nodes[0] === 'string' ? inner.nodes[0] : '');
          if (href && typeof href === 'string') {
            nodes.push(
              <a key={++keyCounter} className="online-link" href={href}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.electronAPI.openExternalUrl(href); }}>
                {inner.nodes}
              </a>
            );
          } else {
            nodes.push(...inner.nodes);
          }
          i = inner.pos;
          continue;
        } else if (tag === 'img') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'img');
          // Skip images — just show text placeholder
          const src = inner.nodes.length === 1 && typeof inner.nodes[0] === 'string' ? inner.nodes[0] : '';
          nodes.push(<span key={++keyCounter} title={src}>[img]</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'font') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'font');
          if (attr) {
            nodes.push(<span key={++keyCounter} style={{ fontFamily: attr }}>{inner.nodes}</span>);
          } else {
            nodes.push(<span key={++keyCounter}>{inner.nodes}</span>);
          }
          i = inner.pos;
          continue;
        } else if (tag === 'indent') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'indent');
          nodes.push(<span key={++keyCounter} style={{ display: 'block', marginLeft: '1.5em' }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'list') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'list');
          nodes.push(<span key={++keyCounter}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        }
      }
      // [*] list item
      if (text.substring(i, i + 3) === '[*]') {
        flushBuffer();
        buffer = '';
        nodes.push(<span key={++keyCounter}>{'\n• '}</span>);
        i += 3;
        continue;
      }
      // Unrecognized closing tag — skip it
      const closingMatch = text.substring(i).match(/^\[\/\w+\]/i);
      if (closingMatch) {
        i += closingMatch[0].length;
        continue;
      }
    }

    // Handle newlines
    if (text[i] === '\n') {
      flushBuffer();
      nodes.push(<br key={++keyCounter} />);
      i++;
      continue;
    }

    buffer += text[i];
    i++;
  }

  flushBuffer();
  return { nodes, pos: i };
}

/**
 * Convenience component for rendering BBCode text inline.
 */
const RichText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const content = renderBBCode(text);
  return className ? <span className={className}>{content}</span> : <>{content}</>;
};

export default RichText;
