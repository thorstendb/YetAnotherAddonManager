// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import React from 'react';

/**
 * Render BBCode-formatted text as styled React elements.
 * Full BBCode support: [b], [i], [u], [s], [color], [size], [font], [url], [img],
 * [center], [left], [right], [quote], [spoiler], [code], [pre], [list], [ol], [ul],
 * [li], [*], [table], [tr], [td], [th], [indent], [hr], [sub], [sup], [youtube],
 * [style], and ESO |cHHHHHH / |r color codes.
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

        // --- Inline formatting ---
        if (tag === 'b') {
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
        } else if (tag === 's') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 's');
          nodes.push(<span key={++keyCounter} style={{ textDecoration: 'line-through' }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'sub') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'sub');
          nodes.push(<sub key={++keyCounter}>{inner.nodes}</sub>);
          i = inner.pos;
          continue;
        } else if (tag === 'sup') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'sup');
          nodes.push(<sup key={++keyCounter}>{inner.nodes}</sup>);
          i = inner.pos;
          continue;

        // --- Color, size, font ---
        } else if (tag === 'color' && attr) {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'color');
          const hex = attr.startsWith('#') ? attr : /^[0-9a-fA-F]{6}$/.test(attr) ? `#${attr}` : attr;
          nodes.push(<span key={++keyCounter} style={{ color: hex }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'size' && attr) {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'size');
          const relative = attr.startsWith('+') || attr.startsWith('-');
          const num = parseInt(attr, 10) || 0;
          const px = relative
            ? Math.min(Math.max(13 + num * 2, 8), 28)
            : Math.min(Math.max(num, 8), 28);
          nodes.push(<span key={++keyCounter} style={{ fontSize: `${px}px` }}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'font') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'font');
          nodes.push(<span key={++keyCounter} style={attr ? { fontFamily: attr } : undefined}>{inner.nodes}</span>);
          i = inner.pos;
          continue;
        } else if (tag === 'style') {
          // [style size="N" color="X"] — parse inline attributes
          flushBuffer();
          const styleStr = tagMatch[0];
          const sizeM = styleStr.match(/size\s*=\s*"?(\+?-?\d+)"?/i);
          const colorM = styleStr.match(/color\s*=\s*"?(#?[\w]+)"?/i);
          const inner = parseBBNodes(text, tagEnd, 'style');
          const css: React.CSSProperties = {};
          if (sizeM) {
            const sn = parseInt(sizeM[1], 10) || 0;
            const rel = sizeM[1].startsWith('+') || sizeM[1].startsWith('-');
            css.fontSize = `${rel ? Math.min(Math.max(13 + sn * 2, 8), 28) : Math.min(Math.max(sn, 8), 28)}px`;
          }
          if (colorM) {
            const c = colorM[1];
            css.color = c.startsWith('#') ? c : /^[0-9a-fA-F]{6}$/.test(c) ? `#${c}` : c;
          }
          nodes.push(<span key={++keyCounter} style={css}>{inner.nodes}</span>);
          i = inner.pos;
          continue;

        // --- Links & media ---
        } else if (tag === 'url') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'url');
          const href = attr || (inner.nodes.length === 1 && typeof inner.nodes[0] === 'string' ? inner.nodes[0] : '');
          if (href && typeof href === 'string') {
            nodes.push(
              <a key={++keyCounter} className="online-link" href={href}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.electronAPI.openExternalUrl(href); }}>
                {attr ? inner.nodes : href}
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
          const src = inner.nodes.length === 1 && typeof inner.nodes[0] === 'string' ? inner.nodes[0].trim() : '';
          if (src) {
            // Parse optional dimensions from [img=WxH] or [img width=W height=H]
            const dimShort = attr?.match(/^(\d+)x(\d+)$/i);
            const wM = tagMatch[0].match(/width\s*=\s*"?(\d+)"?/i);
            const hM = tagMatch[0].match(/height\s*=\s*"?(\d+)"?/i);
            const w = dimShort ? Number(dimShort[1]) : wM ? Number(wM[1]) : undefined;
            const h = dimShort ? Number(dimShort[2]) : hM ? Number(hM[1]) : undefined;
            nodes.push(
              <img key={++keyCounter} src={src} alt="" style={{
                maxWidth: '100%', maxHeight: 200, borderRadius: 3,
                ...(w ? { width: w } : {}), ...(h ? { height: h } : {})
              }} />
            );
          } else {
            nodes.push(<span key={++keyCounter}>[img]</span>);
          }
          i = inner.pos;
          continue;
        } else if (tag === 'youtube') {
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

        // --- Block alignment ---
        } else if (tag === 'center') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'center');
          nodes.push(<div key={++keyCounter} style={{ textAlign: 'center' }}>{inner.nodes}</div>);
          i = inner.pos;
          continue;
        } else if (tag === 'left') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'left');
          nodes.push(<div key={++keyCounter} style={{ textAlign: 'left' }}>{inner.nodes}</div>);
          i = inner.pos;
          continue;
        } else if (tag === 'right') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'right');
          nodes.push(<div key={++keyCounter} style={{ textAlign: 'right' }}>{inner.nodes}</div>);
          i = inner.pos;
          continue;
        } else if (tag === 'indent') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'indent');
          nodes.push(<div key={++keyCounter} style={{ marginLeft: '1.5em' }}>{inner.nodes}</div>);
          i = inner.pos;
          continue;

        // --- Quote & spoiler ---
        } else if (tag === 'quote') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'quote');
          nodes.push(
            <div key={++keyCounter} style={{
              borderLeft: '3px solid var(--border)', marginLeft: 4, paddingLeft: 8,
              opacity: 0.85, fontStyle: 'italic'
            }}>
              {attr && <div style={{ fontWeight: 600, fontStyle: 'normal', marginBottom: 2 }}>{attr}:</div>}
              {inner.nodes}
            </div>
          );
          i = inner.pos;
          continue;
        } else if (tag === 'spoiler') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'spoiler');
          const spoilerKey = ++keyCounter;
          nodes.push(
            <SpoilerBlock key={spoilerKey} label={attr}>
              {inner.nodes}
            </SpoilerBlock>
          );
          i = inner.pos;
          continue;

        // --- Code & preformatted ---
        } else if (tag === 'code') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'code');
          nodes.push(
            <code key={++keyCounter} style={{
              display: 'block', background: 'rgba(255,255,255,0.06)', padding: '4px 8px',
              borderRadius: 3, fontSize: '0.9em', fontFamily: 'monospace', whiteSpace: 'pre-wrap',
              border: '1px solid var(--border)', margin: '2px 0'
            }}>
              {inner.nodes}
            </code>
          );
          i = inner.pos;
          continue;
        } else if (tag === 'pre') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'pre');
          nodes.push(
            <pre key={++keyCounter} style={{
              fontFamily: 'monospace', whiteSpace: 'pre-wrap', margin: '2px 0',
              fontSize: '0.9em'
            }}>
              {inner.nodes}
            </pre>
          );
          i = inner.pos;
          continue;

        // --- Lists ---
        } else if (tag === 'list' || tag === 'ul') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, tag);
          nodes.push(
            <ul key={++keyCounter} style={{ margin: '2px 0', paddingLeft: '1.5em' }}>
              {inner.nodes}
            </ul>
          );
          i = inner.pos;
          continue;
        } else if (tag === 'ol') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'ol');
          nodes.push(
            <ol key={++keyCounter} style={{ margin: '2px 0', paddingLeft: '1.5em' }}>
              {inner.nodes}
            </ol>
          );
          i = inner.pos;
          continue;
        } else if (tag === 'li') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'li');
          nodes.push(<li key={++keyCounter}>{inner.nodes}</li>);
          i = inner.pos;
          continue;

        // --- Tables ---
        } else if (tag === 'table') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'table');
          nodes.push(
            <table key={++keyCounter} style={{
              borderCollapse: 'collapse', margin: '2px 0', fontSize: '0.95em',
              border: '1px solid var(--border)'
            }}>
              <tbody>{inner.nodes}</tbody>
            </table>
          );
          i = inner.pos;
          continue;
        } else if (tag === 'tr') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'tr');
          nodes.push(<tr key={++keyCounter}>{inner.nodes}</tr>);
          i = inner.pos;
          continue;
        } else if (tag === 'td') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'td');
          nodes.push(
            <td key={++keyCounter} style={{ border: '1px solid var(--border)', padding: '2px 6px' }}>
              {inner.nodes}
            </td>
          );
          i = inner.pos;
          continue;
        } else if (tag === 'th') {
          flushBuffer();
          const inner = parseBBNodes(text, tagEnd, 'th');
          nodes.push(
            <th key={++keyCounter} style={{
              border: '1px solid var(--border)', padding: '2px 6px', fontWeight: 600,
              background: 'rgba(255,255,255,0.04)'
            }}>
              {inner.nodes}
            </th>
          );
          i = inner.pos;
          continue;

        // --- Misc ---
        } else if (tag === 'hr') {
          flushBuffer();
          // Self-closing [hr] — skip to end, consume optional [/hr]
          nodes.push(<hr key={++keyCounter} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0', opacity: 0.4 }} />);
          i = tagEnd;
          continue;
        }
      }
      // [*] list item (shorthand without closing tag)
      if (text.substring(i, i + 3) === '[*]') {
        flushBuffer();
        nodes.push(<li key={++keyCounter} style={{ listStyle: 'disc' }}>{''}</li>);
        // Parse until next [*] or [/list] or [/ul] or [/ol] — but simpler: just emit bullet marker
        nodes.pop(); // remove empty li
        nodes.push(<span key={++keyCounter}>{'• '}</span>);
        i += 3;
        continue;
      }
      // Unrecognized closing tag — skip it
      const closingMatch = text.substring(i).match(/^\[\/\w+\]/i);
      if (closingMatch) {
        i += closingMatch[0].length;
        continue;
      }
      // Unrecognized opening tag — skip it silently
      const unknownOpen = text.substring(i).match(/^\[\w+(?:=[^\]]*)?\]/i);
      if (unknownOpen) {
        i += unknownOpen[0].length;
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

/** Expandable spoiler block component */
const SpoilerBlock: React.FC<{ label?: string; children: React.ReactNode }> = ({ label, children }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ margin: '2px 0', border: '1px solid var(--border)', borderRadius: 3 }}>
      <div
        style={{ padding: '2px 8px', cursor: 'pointer', background: 'rgba(255,255,255,0.04)', fontSize: '0.95em' }}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
      >
        {open ? '▼' : '▶'} {label || 'Spoiler'}
      </div>
      {open && <div style={{ padding: '4px 8px' }}>{children}</div>}
    </div>
  );
};

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
