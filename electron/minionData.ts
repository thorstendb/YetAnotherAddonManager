// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Minion's record of what it installed.
 *
 * Someone switching over from Minion has no YAAM tracking yet, and comparing
 * version strings is a guess ("1157000" vs "1.5.7").  Minion knows the exact
 * catalog ID and version per folder, so YAAM can start from that.
 *
 * Minion 3 keeps it in ~/.minion/minion.xml, one <game> block per installation:
 *
 *   <game addon-path="<base64 of the AddOns path>" game-id="ESO" …>
 *     <auto-updated><addon date="…" title="…" version="…"/>…</auto-updated>
 *     <addons>
 *       <addon md5="…" ui-version="3.8.33" uid="2753">
 *         <dirs><dir>MasterMerchant</dir></dirs>
 *       </addon>
 *
 * The record only ever reflects Minion's OWN installs, so it says nothing about
 * a folder another tool updated afterwards.  Callers use it to bootstrap
 * folders without YAAM tracking, never to override existing tracking.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MinionEntry {
  uid: string;
  md5: string;
  uiVersion: string;
  dirs: string[];
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isNaN(code) ? whole : String.fromCodePoint(code);
  });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = decodeXml(m[2]);
  return attrs;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'linux' ? left === right : left.toLowerCase() === right.toLowerCase();
}

/**
 * Does a <game> block describe this AddOns folder?  The path is base64 — of
 * UTF-8 or of the JVM's default charset (Windows-1252 on a German Windows), so
 * a user name with an umlaut must match either way.  Older configs store it
 * in plain text.
 */
function describesFolder(addonPathAttr: string | undefined, addonsPath: string): boolean {
  if (!addonPathAttr) return false;
  const bytes = Buffer.from(addonPathAttr, 'base64');
  return [addonPathAttr, bytes.toString('utf8'), bytes.toString('latin1')].some((p) => samePath(p, addonsPath));
}

/**
 * Folder → entry.  Several records can claim one folder, and record order means
 * nothing: Provision's TeamFormation lists LibAddonMenu-2.0 as a bundled folder
 * and can come before the library's own record.
 *  - a record whose MAIN folder it is beats one that merely bundles it
 *  - several equal claims cannot be decided (AsylumTracker: two forks) → no
 *    entry, the catalog matching decides
 */
export function indexMinionEntries(entries: MinionEntry[]): Map<string, MinionEntry> {
  const claims = new Map<string, { main: MinionEntry[]; bundled: MinionEntry[] }>();
  for (const entry of entries) {
    if (!entry.uid || !entry.uiVersion) continue;
    (entry.dirs || []).forEach((dir, i) => {
      const claim = claims.get(dir) ?? { main: [], bundled: [] };
      (i === 0 ? claim.main : claim.bundled).push(entry);
      claims.set(dir, claim);
    });
  }
  const index = new Map<string, MinionEntry>();
  for (const [dir, { main, bundled }] of claims) {
    const owners = main.length > 0 ? main : bundled;
    if (owners.length === 1) index.set(dir, owners[0]);
  }
  return index;
}

/**
 * Read the entries for one AddOns folder from minion.xml.  Other installations
 * (PTS, a second ESO folder) and other games are different <game> blocks — their
 * records must not leak into this folder.  A half-written file simply yields
 * fewer or no entries; this is a bootstrap, the next scan sees the complete one.
 */
export function parseMinionConfig(xml: string, addonsPath: string): Map<string, MinionEntry> {
  const entries: MinionEntry[] = [];
  // \s after the tag name: <game-configs> and <game-config> are different elements
  for (const game of xml.matchAll(/<game\s([^>]*)>([\s\S]*?)<\/game>/g)) {
    const attrs = parseAttributes(game[1]);
    if (attrs['game-id'] !== 'ESO' || !describesFolder(attrs['addon-path'], addonsPath)) continue;
    // [^/>] before the closing bracket skips the self-closing <auto-updated> log entries
    for (const addon of game[2].matchAll(/<addon\s([^>]*[^/>])>([\s\S]*?)<\/addon>/g)) {
      const a = parseAttributes(addon[1]);
      entries.push({
        uid: a.uid ?? '',
        md5: a.md5 ?? '',
        uiVersion: a['ui-version'] ?? '',
        dirs: [...addon[2].matchAll(/<dir>([^<]*)<\/dir>/g)].map((d) => decodeXml(d[1])),
      });
    }
  }
  return indexMinionEntries(entries);
}

/**
 * Minion's record for this AddOns folder, or an empty map.  Besides minion.xml,
 * a JSON export in the AddOns root is honored: miniondata.json / minion_data.json,
 * an array of { uid, md5, uiVersion, dirs[] }.
 */
export function loadMinionData(addonsPath: string): Map<string, MinionEntry> {
  const configPath = path.join(os.homedir(), '.minion', 'minion.xml');
  try {
    if (fs.existsSync(configPath)) {
      const index = parseMinionConfig(fs.readFileSync(configPath, 'utf-8'), addonsPath);
      if (index.size > 0) return index;
    }
  } catch (err) {
    console.warn('[YAAM] Failed to read minion.xml:', err);
  }
  for (const name of ['miniondata.json', 'minion_data.json']) {
    const filePath = path.join(addonsPath, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const index = indexMinionEntries(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      console.log(`[YAAM] Loaded Minion tracking data: ${index.size} directories from ${name}`);
      return index;
    } catch (err) {
      console.warn(`[YAAM] Failed to parse ${name}:`, err);
    }
  }
  return new Map();
}
