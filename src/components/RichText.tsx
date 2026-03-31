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
    .replace(/\|r/g, '[/color]')
    // Normalize: strip \r, collapse 3+ newlines to 2
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n');

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
        } else if (tag === 'center') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'center');
          nodes.push(<span key={++keyCounter} style={{ display: 'block', textAlign: 'center' }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'code') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'code');
          nodes.push(<code key={++keyCounter} style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, fontSize: '0.9em' }}>{inner.nodes}</code>);
          i = inner.pos;
          continue;
        } else if (tag === 'youtube') {
          // [youtube]ID[/youtube] — skip, just show link
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'youtube');
          const videoId = inner.nodes.length === 1 && typeof inner.nodes[0] === 'string' ? inner.nodes[0].trim() : '';
          if (videoId) {
            const href = `https://www.youtube.com/watch?v=${videoId}`;
            nodes.push(
              <a key={++keyCounter} className="online-link" href={href}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.electronAPI.openExternalUrl(href); }}>
                ▶ YouTube
              </a>
            );
          }
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
        nodes.push(<span key={++keyCounter}>{'\u2022 '}</span>);
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

    // Handle newlines: just a simple line break
    if (text[i] === '\n') {
      flushBuffer();
      // Skip all consecutive newlines
      while (i < text.length && text[i] === '\n') i++;
      nodes.push(<br key={++keyCounter} />);
      continue;
    }

    // Handle --- separator lines (3+ dashes)
    if (text[i] === '-' && (i === 0 || text[i - 1] === '\n')) {
      const dashMatch = text.substring(i).match(/^-{3,}/);
      if (dashMatch) {
        flushBuffer();
        nodes.push(<hr key={++keyCounter} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0', opacity: 0.4 }} />);
        i += dashMatch[0].length;
        continue;
      }
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

/** Strip all BBCode tags and ESO color codes, returning plain text. */
export function stripBBCode(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\|c[0-9a-fA-F]{6}/g, '')
    .replace(/\|r/g, '')
    .replace(/\[\*\]/g, '• ')
    .replace(/\[\/?[\w]+(?:=[^\]]*)?\]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export default RichText;
