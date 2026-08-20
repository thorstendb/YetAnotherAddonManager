// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { AddonInfo, DependencyRef, ColorSegment, YaamAddonEntry, compareVersionStrings } from './shared/types';
import { loadDatabase, saveDatabase, YaamDatabase, readMarkerFile, writeMarkerFile, backupTrackingState } from './yaamDatabase';
import { canEnterDir } from './shared/fsWalk';

/**
 * Parse color codes from a string.
 * Format: |cHHHHHH starts coloring (6 hex digits RRGGBB), |r resets to default.
 * Returns an array of ColorSegment for rich display.
 */
export function parseColorCodes(raw: string): { plain: string; segments: ColorSegment[] } {
  const segments: ColorSegment[] = [];
  let plain = '';
  let currentColor: string | undefined = undefined;
  let buffer = '';
  let i = 0;

  while (i < raw.length) {
    if (raw[i] === '|' && i + 1 < raw.length) {
      if (raw[i + 1] === 'c' && i + 8 <= raw.length) {
        if (buffer) {
          segments.push({ text: buffer, color: currentColor });
          plain += buffer;
          buffer = '';
        }
        const hex = raw.substring(i + 2, i + 8);
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          currentColor = '#' + hex;
          i += 8;
          continue;
        }
      } else if (raw[i + 1] === 'r') {
        if (buffer) {
          segments.push({ text: buffer, color: currentColor });
          plain += buffer;
          buffer = '';
        }
        currentColor = undefined;
        i += 2;
        continue;
      }
    }
    buffer += raw[i];
    i++;
  }

  if (buffer) {
    segments.push({ text: buffer, color: currentColor });
    plain += buffer;
  }

  return { plain, segments };
}

/**
 * Try to extract a download URL from the manifest content.
 */
function extractDownloadUrl(content: string, folderName: string, title?: string): string {
  const urls = content.match(/https?:\/\/(?:www\.)?esoui\.com\/downloads\/info\d+-[^\s"'<>]+\.html/gi);
  if (!urls || urls.length === 0) return '';

  // Manifests often list their DEPENDENCIES' ESOUI URLs (e.g. WritWorthy links
  // LibAddonMenu, LibPrice, …).  Blindly taking the first URL would match the
  // addon to the wrong catalog entry.  Prefer a URL whose slug resembles this
  // addon's own folder name or title.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targets = [norm(folderName), title ? norm(title) : ''].filter(Boolean);
  for (const url of urls) {
    const slug = url.match(/\/info\d+-([^\s"'<>]+)\.html/i)?.[1] ?? '';
    const ns = norm(slug);
    if (ns && targets.some((t) => ns.includes(t) || t.includes(ns))) return url;
  }
  // No slug matches: a single URL is most likely still a self-link with a
  // renamed slug — keep it.  Multiple non-matching URLs are almost certainly
  // a dependency list — trusting any of them would be wrong.
  return urls.length === 1 ? urls[0] : '';
}

/**
 * Parse a dependency string like "LibAddonMenu-2.0>=38 LibCustomMenu>=730 LibDataEncode"
 * into structured DependencyRef objects.
 */
function parseDependencies(raw: string): DependencyRef[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(.+?)(?:>=(\d+))?$/);
      if (!match) return { name: token };
      return {
        name: match[1],
        minVersion: match[2] ? parseInt(match[2], 10) : undefined,
      };
    });
}

/**
 * Merge two dependency lists, avoiding duplicates (keep higher minVersion).
 */
function mergeDepLists(base: DependencyRef[], extra: DependencyRef[]): DependencyRef[] {
  const byName = new Map<string, DependencyRef>();
  for (const dep of base) byName.set(dep.name, dep);
  for (const dep of extra) {
    const existing = byName.get(dep.name);
    if (!existing) {
      byName.set(dep.name, dep);
    } else if (dep.minVersion !== undefined) {
      if (existing.minVersion === undefined || dep.minVersion > existing.minVersion) {
        byName.set(dep.name, dep);
      }
    }
  }
  return Array.from(byName.values());
}

/**
 * Parse header lines from an addon manifest file (.txt or .addon).
 * Header lines start with "## Key: Value".
 *
 * The game client recognizes both .txt and .addon extensions.
 * The manifest file MUST be named <FolderName>.txt or <FolderName>.addon
 * where <FolderName> matches the containing directory name exactly –
 * this is the fixed anchor the game uses to discover addons.
 */
function parseManifestHeaders(content: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^##\s*(\w+)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      // Some headers can appear multiple times (e.g. OptionalDependsOn) – merge
      if (headers[key]) {
        headers[key] += ' ' + value;
      } else {
        headers[key] = value;
      }
    }
  }
  return headers;
}

/**
 * Parse the file list from the manifest (non-header, non-comment lines).
 */
function parseFileList(content: string): string[] {
  const files: string[] = [];
  let pastHeaders = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('##')) continue;
    if (trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('#') && !pastHeaders) continue;
    if (trimmed === '') { pastHeaders = true; continue; }
    pastHeaders = true;
    files.push(trimmed);
  }
  return files;
}

/**
 * Read and parse a single addon manifest file.
 *
 * @param manifestPath  Full path to the .txt or .addon file
 * @param folderName    The addon's directory name (= primary identifier)
 * @param parentAddon   If this is a sub-addon, the top-level parent's folder name
 * @param addonsRootPath Root AddOns directory (for context)
 */
function parseManifest(
  manifestPath: string,
  folderName: string,
  parentAddon?: string,
  addonsRootPath?: string,
): AddonInfo {
  const content = fs.readFileSync(manifestPath, 'utf-8');
  const headers = parseManifestHeaders(content);
  const files = parseFileList(content);
  const folderPath = path.dirname(manifestPath);
  const manifestExt = path.extname(manifestPath).replace('.', '') as 'txt' | 'addon';
  let manifestMtime: number | undefined;
  try {
    manifestMtime = Math.floor(fs.statSync(manifestPath).mtimeMs / 1000);
  } catch { /* stat failure — hint simply unavailable */ }

  const rawTitle = headers['Title'] || folderName;
  const { plain: title, segments: titleSegments } = parseColorCodes(rawTitle);
  const rawAuthor = headers['Author'] || '';
  const { plain: author, segments: authorSegments } = parseColorCodes(rawAuthor);
  const rawDescription = headers['Description'] || '';
  const { plain: description, segments: descriptionSegments } = parseColorCodes(rawDescription);
  const rawContributors = headers['Contributors'] || '';
  const { plain: contributors, segments: contributorsSegments } = parseColorCodes(rawContributors);
  const downloadUrl = extractDownloadUrl(content, folderName, title);
  // Extract ESOUI catalog UID from URL like "info1346-Name.html"
  const uidMatch = downloadUrl.match(/\/info(\d+)-/);
  const catalogId = uidMatch ? uidMatch[1] : '';

  // Parse dependencies – on PC we merge PCDependsOn into DependsOn
  const baseDeps = parseDependencies(headers['DependsOn'] || '');
  const pcDeps = parseDependencies(headers['PCDependsOn'] || '');
  const mergedDeps = mergeDepLists(baseDeps, pcDeps);

  const optionalDeps = parseDependencies(headers['OptionalDependsOn'] || '');

  const savedVariables = (headers['SavedVariables'] || '')
    .split(/\s+/)
    .filter((s) => s && !s.startsWith('ZO_'));

  // ─── Discover sub-addons (recursive, any depth) ───
  const subAddons: AddonInfo[] = [];
  if (!parentAddon) {
    collectSubAddons(folderPath, folderName, folderName, subAddons);
  }

  // Build the complete SavedVariable name list (self + all sub-addons)
  const allSavedVariableNames = [...savedVariables];
  for (const sub of subAddons) {
    allSavedVariableNames.push(...sub.savedVariables);
  }

  // yaamMeta is injected after scan from the central database, not read per-folder

  return {
    folderName,
    title,
    titleSegments,
    author,
    authorSegments,
    // Version fallback chain: Version → AddOnVersion (as string) → empty
    version: headers['Version'] || (headers['AddOnVersion'] ? headers['AddOnVersion'] : ''),
    addonVersion: headers['AddOnVersion'] ? parseInt(headers['AddOnVersion'], 10) : 0,
    apiVersion: headers['APIVersion'] || '',
    description,
    descriptionSegments,
    isLibrary: (headers['IsLibrary'] || '').toLowerCase() === 'true' || /^Lib[A-Z]/.test(folderName),
    dependsOn: mergedDeps,
    optionalDependsOn: optionalDeps,
    savedVariables,
    contributors,
    contributorsSegments,
    files,
    path: folderPath,
    downloadUrl,
    catalogId,
    // New fields
    subAddons,
    parentAddon,
    manifestType: manifestExt,
    pcDependsOn: pcDeps,
    allSavedVariableNames,
    yaamMeta: undefined, // injected from DB after scan
    yaamMarker: undefined, // injected from .yaam.json after scan
    manifestMtime,
  };
}

/**
 * Locate the manifest file for an addon folder.
 *
 * Both .addon and .txt are valid.  When BOTH exist, the folder usually went
 * through a packaging change (author switched .addon ↔ .txt between releases)
 * and extraction left the OLD manifest behind — blindly preferring one
 * extension would then read a stale version forever (seen with StaggerTracker:
 * leftover .addon said 1.2 while the shipped .txt was 1.3).
 * Rule: the manifest with the higher AddOnVersion wins; tie → newer file.
 */
function resolveManifestPath(folderPath: string, name: string): string | null {
  const addonPath = path.join(folderPath, `${name}.addon`);
  const txtPath = path.join(folderPath, `${name}.txt`);
  const hasAddon = fs.existsSync(addonPath);
  const hasTxt = fs.existsSync(txtPath);
  if (hasAddon && !hasTxt) return addonPath;
  if (!hasAddon && hasTxt) return txtPath;
  if (!hasAddon && !hasTxt) return null;

  const readAddOnVersion = (p: string): number => {
    try {
      const m = fs.readFileSync(p, 'utf-8').match(/^##\s*AddOnVersion\s*:\s*(\d+)/im);
      return m ? parseInt(m[1], 10) : 0;
    } catch {
      return 0;
    }
  };
  const av = readAddOnVersion(addonPath);
  const tv = readAddOnVersion(txtPath);
  if (av !== tv) return av > tv ? addonPath : txtPath;
  try {
    return fs.statSync(addonPath).mtimeMs >= fs.statSync(txtPath).mtimeMs ? addonPath : txtPath;
  } catch {
    return addonPath;
  }
}

/**
 * Recursively scan a directory for sub-addon manifests.
 *
 * A sub-addon is any subfolder (at any depth) that contains
 * <SubFolderName>.txt or <SubFolderName>.addon matching the subfolder's name.
 *
 * Handles structures like:
 *   PersonalAssistant/PersonalAssistantBanking/
 *   HarvestMap/Modules/HarvestMapAD/
 *   MasterMerchant/Libs/GS00Data/
 */
function collectSubAddons(
  dir: string,
  selfName: string,
  topParent: string,
  results: AddonInfo[],
  depth = 0,
  visited: Set<string> = new Set(),
): void {
  if (!canEnterDir(dir, depth, visited)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Track already-found names to avoid duplicates from different paths
  const foundNames = new Set(results.map((r) => r.folderName));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subName = entry.name;
    if (subName === selfName) continue;
    if (subName.startsWith('.') || subName.startsWith('ZO_')) continue;

    const subDir = path.join(dir, subName);

    // Check for manifest matching the subfolder name
    const manifestPath = resolveManifestPath(subDir, subName);

    if (manifestPath && !foundNames.has(subName)) {
      try {
        const subAddon = parseManifest(manifestPath, subName, topParent);
        results.push(subAddon);
        foundNames.add(subName);
      } catch (err) {
        console.error(`Failed to parse sub-addon manifest ${manifestPath}:`, err);
      }
    }

    // Recurse deeper (e.g. HarvestMap/Modules/HarvestMapAD/)
    collectSubAddons(subDir, selfName, topParent, results, depth + 1, visited);
  }
}

/**
 * Scan an AddOns directory and return parsed info for all addons found.
 *
 * Each top-level subfolder may contain a .txt or .addon manifest file
 * whose base name matches the folder name.  The folder name IS the
 * addon identifier used by the game client.
 *
 * Sub-addons (manifests inside subdirectories of a top-level addon) are
 * attached to the parent's `subAddons` array and do NOT appear as separate
 * top-level entries – but they ARE included in `allSavedVariableNames`
 * and can be enumerated via `collectAllAddonNames()`.
 */
export function scanAddonsFolder(addonsPath: string): AddonInfo[] {
  if (!fs.existsSync(addonsPath)) {
    throw new Error(`AddOns folder not found: ${addonsPath}`);
  }

  const entries = fs.readdirSync(addonsPath, { withFileTypes: true });
  const addons: AddonInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderName = entry.name;
    if (folderName.startsWith('.') || folderName.startsWith('ZO_')) continue;
    const folderPath = path.join(addonsPath, folderName);

    // Look for manifest: FolderName.addon or FolderName.txt
    const manifestPath = resolveManifestPath(folderPath, folderName);

    if (manifestPath) {
      try {
        addons.push(parseManifest(manifestPath, folderName, undefined, addonsPath));
      } catch (err) {
        console.error(`Failed to parse manifest for ${folderName}:`, err);
      }
    }
  }

  // Inject yaamMeta from the central database + detect runtime-created files.
  // If the DB has no entry but a .yaam.json marker exists in the folder,
  // restore the DB entry from it (resilience against DB loss).
  const db = loadDatabase(addonsPath);
  const minionData = loadMinionData(addonsPath);
  let dbChanged = false;
  for (const addon of addons) {
    let entry = db.addons[addon.folderName];

    // Read .yaam.json marker file from the addon folder
    const marker = readMarkerFile(addonsPath, addon.folderName);
    addon.yaamMarker = marker ?? undefined;

    if (!entry?.esouid && marker) {
      // DB entry missing but marker exists — restore from marker
      entry = {
        esouid: marker.esouid,
        url: '',
        catalogName: marker.catalogName,
        catalogAuthor: '',
        catalogVersion: marker.catalogVersion,
        catalogDate: marker.catalogDate,
        localVersion: marker.localVersion ?? addon.version,
        installedAt: marker.installedAt,
        updatedAt: marker.updatedAt,
        overlays: marker.overlays,
        installedFiles: marker.installedFiles,
      };
      db.addons[addon.folderName] = entry;
      dbChanged = true;
    } else if (!entry?.esouid && !marker) {
      // No YAAM tracking at all — check Minion data as a bootstrap source.
      // Minion's uiVersion is the catalog version string at last Minion install,
      // equivalent to YAAM's catalogVersion for Tier 2 update detection.
      const minion = minionData.get(addon.folderName);
      if (minion) {
        const now = new Date().toISOString();
        entry = {
          esouid: minion.uid,
          url: '',
          catalogName: '',
          catalogAuthor: '',
          catalogVersion: minion.uiVersion,
          catalogDate: undefined,
          localVersion: addon.version,
          installedAt: now,
          updatedAt: now,
        };
        db.addons[addon.folderName] = entry;
        // Write a marker file so subsequent scans don't clear catalogVersion
        // (the "DB has entry but no marker → clear" branch would otherwise wipe it).
        writeMarkerFile(addonsPath, addon.folderName, entry);
        dbChanged = true;
      }
    } else if (entry?.esouid && marker && entry.catalogVersion !== marker.catalogVersion) {
      // Marker differs from DB (e.g. after restoring an older backup).
      // The marker lives inside the addon folder and is the ground truth
      // for what is actually on disk.
      entry.catalogVersion = marker.catalogVersion;
      entry.catalogDate = marker.catalogDate;
      if (marker.localVersion) entry.localVersion = marker.localVersion;
      if (marker.overlays) entry.overlays = marker.overlays;
      if (marker.installedFiles) entry.installedFiles = marker.installedFiles;
      db.addons[addon.folderName] = entry;
      dbChanged = true;
    } else if (entry?.esouid && entry.catalogVersion && !marker) {
      // DB has a tracked version but no marker file on disk.
      // The addon folder was likely replaced (e.g. restored from a backup
      // taken before YAAM tracking).  Clear catalogVersion so the addon
      // falls to Tier 3 (best-effort) update detection.
      entry.catalogVersion = '';
      entry.catalogDate = undefined;
      db.addons[addon.folderName] = entry;
      dbChanged = true;
    } else if (entry?.esouid && !entry.catalogVersion && !marker) {
      // DB entry exists (e.g. from reconciliation) but has no catalogVersion
      // and no marker.  Try to backfill from Minion data so Tier 2 detection
      // works instead of falling to Tier 3 best-effort.
      const minion = minionData.get(addon.folderName);
      if (minion) {
        console.log(`[YAAM] Backfill catalogVersion from Minion: ${addon.folderName} → "${minion.uiVersion}" (uid=${minion.uid})`);
        entry.catalogVersion = minion.uiVersion;
        db.addons[addon.folderName] = entry;
        writeMarkerFile(addonsPath, addon.folderName, entry);
        dbChanged = true;
      }
    }

    // Migration: installs from before localVersion tracking have no anchor.
    // Backfill once with the current manifest version — from then on the
    // "files unchanged since install" check works for this addon.
    if (entry?.esouid && !entry.localVersion && addon.version) {
      entry.localVersion = addon.version;
      db.addons[addon.folderName] = entry;
      dbChanged = true;
    }
    // Upgrade marker files written before localVersion existed (one-time).
    if (entry?.esouid && marker && marker.localVersion === undefined && entry.localVersion) {
      writeMarkerFile(addonsPath, addon.folderName, entry);
    }
    // Upgrade marker files written before installedFiles moved into the marker
    // (one-time).  Required for the "central DB is a disposable cache" invariant:
    // every field must be reconstructable from the folders alone.
    if (entry?.esouid && marker && marker.installedFiles === undefined && entry.installedFiles?.length) {
      writeMarkerFile(addonsPath, addon.folderName, entry);
    }

    if (entry?.esouid) {
      addon.yaamMeta = entry;
    }
    // Detect runtime-created files if we have an install manifest
    if (entry?.installedFiles) {
      const runtimeFiles = detectRuntimeFiles(addonsPath, addon.folderName, entry.installedFiles);
      if (runtimeFiles.length > 0) {
        addon.runtimeFiles = runtimeFiles;
      }
    }
  }

  // ── Stale-entry cleanup ──
  // DB entries whose folder no longer exists are dead weight and a trap: a
  // later, unrelated addon reusing the same folder name would INHERIT the old
  // identity (wrong esouid, wrong version anchors).  Markers travel inside
  // the folders, so restoring a folder restores its entry — removing stale
  // entries is lossless.  Guarded on a non-empty scan so pointing YAAM at an
  // empty/wrong directory can never wipe the database of the real one.
  if (addons.length > 0) {
    const present = new Set(addons.map((a) => a.folderName));
    for (const key of Object.keys(db.addons)) {
      if (present.has(key)) continue;
      // Folder may still exist without a parseable manifest (broken install,
      // data-only folder) — keep its entry, only true orphans are removed.
      if (fs.existsSync(path.join(addonsPath, key))) continue;
      console.log(`[YAAM] Removing stale DB entry for missing folder: ${key}`);
      delete db.addons[key];
      dbChanged = true;
    }
  }

  if (dbChanged) saveDatabase(db, addonsPath);

  return addons;
}

/** Entry format used by Minion's tracking file (miniondata.json in AddOns root) */
interface MinionEntry {
  uid: string;
  md5: string;
  uiVersion: string;
  dirs: string[];
}

/**
 * Try to load Minion's tracking file from the AddOns folder root.
 * Returns a map from folder name → Minion entry, or an empty map if not found.
 *
 * File searched (in order): miniondata.json, minion_data.json
 * Format: array of { uid, md5, uiVersion, dirs[] }
 */
function loadMinionData(addonsPath: string): Map<string, MinionEntry> {
  const candidates = ['miniondata.json', 'minion_data.json'];
  for (const name of candidates) {
    const filePath = path.join(addonsPath, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data: MinionEntry[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const map = new Map<string, MinionEntry>();
      for (const entry of data) {
        if (!entry.uid || !entry.uiVersion) continue;
        for (const dir of entry.dirs || []) {
          if (!map.has(dir)) map.set(dir, entry); // first dir wins (primary owner)
        }
      }
      console.log(`[YAAM] Loaded Minion tracking data: ${map.size} directories from ${name}`);
      return map;
    } catch (err) {
      console.warn(`[YAAM] Failed to parse ${name}:`, err);
    }
  }
  return new Map();
}

/**
 * Walk an addon folder recursively and return all file paths relative to the addon root.
 *
 * Bounded by depth, file count and a visited-set: the scan is fully synchronous,
 * so a link loop here does not just slow things down — it wedges the entire
 * Electron main process and every IPC call along with it.
 */
const WALK_MAX_FILES = 50_000;

function walkAddonFolder(
  folderPath: string,
  prefix = '',
  depth = 0,
  visited: Set<string> = new Set(),
  results: string[] = []
): string[] {
  if (results.length >= WALK_MAX_FILES) return results;
  if (!canEnterDir(folderPath, depth, visited)) return results;

  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= WALK_MAX_FILES) {
        console.warn(`[YAAM] Walk truncated at ${WALK_MAX_FILES} files in ${folderPath}`);
        break;
      }
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        // Counted as a plain entry (as before) but never descended into.
        results.push(relPath);
      } else if (entry.isDirectory()) {
        walkAddonFolder(path.join(folderPath, entry.name), relPath, depth + 1, visited, results);
      } else {
        results.push(relPath);
      }
    }
  } catch { /* skip unreadable */ }
  return results;
}

/**
 * Detect files in an addon folder that were NOT part of the original ZIP install.
 * These are runtime-created files (caches, data, configs) that addons store in their own folder.
 */
function detectRuntimeFiles(addonsPath: string, folderName: string, installedFiles: string[]): string[] {
  const folderPath = path.join(addonsPath, folderName);
  if (!fs.existsSync(folderPath)) return [];
  const installedSet = new Set(installedFiles.map(f => f.replace(/\\/g, '/')));
  const actualFiles = walkAddonFolder(folderPath);
  // YAAM's own marker file is infrastructure, not an addon runtime artifact
  return actualFiles.filter(f => f !== '.yaam.json' && !installedSet.has(f));
}

/**
 * Scan only specific addon folders (by name) inside the AddOns directory.
 * Much faster than scanAddonsFolder when only a few folders are needed.
 */
export function scanSpecificAddons(addonsPath: string, folderNames: string[]): AddonInfo[] {
  const addons: AddonInfo[] = [];
  for (const folderName of folderNames) {
    const folderPath = path.join(addonsPath, folderName);
    if (!fs.existsSync(folderPath)) continue;
    const manifestPath = resolveManifestPath(folderPath, folderName);
    if (manifestPath) {
      try {
        addons.push(parseManifest(manifestPath, folderName, undefined, addonsPath));
      } catch { /* skip unparseable */ }
    }
  }
  return addons;
}

/** Reconcile result returned to the renderer */
export interface ReconcileResult {
  created: number;
  updated: number;
  details: string[];
}

/** Match entry sent from the renderer for reconciliation */
export interface ReconcileMatch {
  folderName: string;
  esouid: string;
  name: string;
  author: string;
  version: string;
  url: string;
  /** Catalog date (epoch seconds) at time of match */
  catalogDate: number;
  /** Local addon version from ## Version header */
  localVersion: string;
  /** true when the match is by DB entry or catalogId (high confidence) */
  confident: boolean;
}

/**
 * Reconcile the central YAAM addon database with catalog matches.
 * - Creates entries for addons matched confidently but not yet in DB
 * - Updates entries when catalog data has changed (name, author, version, url)
 * - Updates localVersion from each addon's manifest
 * - Skips low-confidence matches (name-only or dir-only with ambiguity)
 */
export function reconcileYaamMetadata(
  addonsPath: string,
  matches: ReconcileMatch[]
): ReconcileResult {
  const result: ReconcileResult = { created: 0, updated: 0, details: [] };
  const now = new Date().toISOString();
  const db = loadDatabase(addonsPath);
  let changed = false;

  for (const m of matches) {
    const existing = db.addons[m.folderName];

    if (!existing) {
      // No DB entry yet — create if confident match.
      // catalogVersion is intentionally left EMPTY for reconciliation-created
      // entries.  We don't know when the user installed this addon, so we
      // can't assume it matches the current catalog version.  An empty
      // catalogVersion signals "never installed/verified by YAAM", which
      // makes the addon eligible for the "possible update" list.
      if (!m.confident) continue;
      db.addons[m.folderName] = {
        esouid: m.esouid,
        url: m.url,
        catalogName: m.name,
        catalogAuthor: m.author,
        catalogVersion: '',
        catalogDate: undefined,
        localVersion: m.localVersion,
        installedAt: now,
        updatedAt: now,
      };
      changed = true;
      result.created++;
      result.details.push(`Created DB entry for ${m.folderName} → ${m.name} (#${m.esouid})`);
    } else {
      // Existing entry — check if it needs updating.
      // catalogVersion tracks what was current AT INSTALL/UPDATE TIME.
      // It should NOT be bumped to the latest catalog value during reconciliation,
      // because isUpdateAvailable uses (catalogVersion !== current catalog version)
      // to detect that a new version was published since last install.
      // Only update non-catalog fields: esouid, name, author, url, localVersion.
      const needsUpdate =
        existing.esouid !== m.esouid ||
        existing.catalogName !== m.name ||
        existing.catalogAuthor !== m.author ||
        existing.url !== m.url ||
        existing.localVersion !== m.localVersion;

      if (!needsUpdate) continue;

      const changes: string[] = [];
      const idChanged = existing.esouid !== m.esouid;
      if (idChanged) changes.push(`id: ${existing.esouid}→${m.esouid}`);
      if (existing.catalogName !== m.name) changes.push(`name: ${existing.catalogName}→${m.name}`);
      if (existing.localVersion !== m.localVersion) changes.push(`localVer: ${existing.localVersion}→${m.localVersion}`);

      db.addons[m.folderName] = {
        esouid: m.esouid,
        url: m.url,
        catalogName: m.name,
        catalogAuthor: m.author,
        // Preserve install-time anchors — UNLESS the identity changed (healed
        // poisoned entry): then they described the WRONG catalog entry and
        // must be cleared so the addon falls back to best-effort detection
        // instead of comparing against a foreign version history.
        catalogVersion: idChanged ? '' : existing.catalogVersion,
        catalogDate: idChanged ? undefined : existing.catalogDate,
        localVersion: m.localVersion,
        installedAt: existing.installedAt,
        // Only bump updatedAt when the local addon files actually changed
        // (i.e. localVersion differs).  Catalog-only metadata changes
        // (new catalogVersion, name, author) must NOT reset the timestamp,
        // otherwise the date-based "possible update" check in
        // isUpdateAvailable is defeated (updatedAt would always be > catalog date).
        updatedAt: existing.localVersion !== m.localVersion ? now : existing.updatedAt,
        installedFiles: existing.installedFiles,
      };
      // Keep an existing .yaam.json marker in sync — a stale marker with the
      // old esouid would otherwise re-poison or fight the healed DB entry.
      if (idChanged && readMarkerFile(addonsPath, m.folderName)) {
        writeMarkerFile(addonsPath, m.folderName, db.addons[m.folderName]);
      }
      changed = true;
      result.updated++;
      result.details.push(`Updated ${m.folderName}: ${changes.join(', ')}`);
    }
  }

  if (changed) saveDatabase(db, addonsPath);
  return result;
}

/** One addon to anchor as "currently up to date" (baseline commit). */
export interface BaselineEntry {
  folderName: string;
  esouid: string;
  url: string;
  name: string;
  author: string;
  /** Current catalog version string — becomes the Tier-2 anchor */
  catalogVersion: string;
  /** Current catalog date (epoch seconds) */
  catalogDate?: number;
  /** Current manifest version — becomes the files-unchanged anchor */
  localVersion: string;
  /** Detected-but-untracked overlays (language patches) to anchor alongside */
  overlays?: { esouid: string; catalogName: string; catalogVersion: string; catalogDate?: number }[];
}

/**
 * Baseline commit: anchor the CURRENT state of the given addons as
 * "up to date".  Writes catalogVersion/catalogDate (+ marker files) so these
 * addons switch from Tier-3 heuristic comparison to deterministic Tier-2
 * tracking — from now on ANY catalog change is a reliably detected update,
 * no matter how chaotic the author's version strings are.
 */
export function commitBaseline(
  addonsPath: string,
  entries: BaselineEntry[]
): { anchored: number; details: string[]; trackingBackupDir: string } {
  // Anchoring overwrites version anchors in DB and markers — back up the full
  // tracking state first so the commit is undoable like every other action.
  const trackingBackupDir = entries.length > 0 ? backupTrackingState(addonsPath) : '';
  const result = { anchored: 0, details: [] as string[], trackingBackupDir };
  const now = new Date().toISOString();
  const db = loadDatabase(addonsPath);

  for (const e of entries) {
    const existing = db.addons[e.folderName];
    // Anchor detected-but-untracked overlays too: merge with already-tracked
    // ones (tracked entries win — they carry real install metadata).
    const trackedOverlays = existing?.overlays ?? [];
    const newOverlays = (e.overlays ?? [])
      .filter((ov) => !trackedOverlays.some((t) => t.esouid === ov.esouid))
      .map((ov) => ({
        esouid: ov.esouid,
        catalogName: ov.catalogName,
        catalogVersion: ov.catalogVersion,
        catalogDate: ov.catalogDate,
        installedAt: now,
        updatedAt: now,
        needsReapply: false,
      }));
    const overlays = [...trackedOverlays, ...newOverlays];
    db.addons[e.folderName] = {
      esouid: e.esouid,
      url: e.url,
      catalogName: e.name,
      catalogAuthor: e.author,
      catalogVersion: e.catalogVersion,
      catalogDate: e.catalogDate,
      localVersion: e.localVersion,
      installedAt: existing?.installedAt ?? now,
      // "The state on disk is current as of now" — also prevents stale
      // date-fallback false positives against older catalog dates.
      updatedAt: now,
      installedFiles: existing?.installedFiles,
      overlays: overlays.length > 0 ? overlays : undefined,
    };
    writeMarkerFile(addonsPath, e.folderName, db.addons[e.folderName]);
    result.anchored++;
    result.details.push(`${e.folderName} → "${e.catalogVersion}" (#${e.esouid})${newOverlays.length > 0 ? ` + overlay ${newOverlays.map((o) => `"${o.catalogName}" v${o.catalogVersion}`).join(', ')}` : ''}`);
  }

  if (result.anchored > 0) saveDatabase(db, addonsPath);
  return result;
}

/**
 * This is critical for settings/SavedVariables cleanup — we must never remove
 * entries for legitimately installed sub-addons.
 */
export function collectAllAddonNames(addons: AddonInfo[]): string[] {
  const names: string[] = [];
  for (const addon of addons) {
    names.push(addon.folderName);
    for (const sub of addon.subAddons) {
      names.push(sub.folderName);
    }
  }
  return names;
}

/**
 * Collect ALL SavedVariable names declared across all addons and sub-addons.
 */
export function collectAllSavedVarNames(addons: AddonInfo[]): string[] {
  const names: string[] = [];
  for (const addon of addons) {
    names.push(...addon.allSavedVariableNames);
  }
  return [...new Set(names)];
}

// ─── Folder hygiene: root orphans, broken installs, Finder duplicates ───

/** A manifest file lying directly in the AddOns root (broken extraction). */
export interface HygieneStrayManifest {
  /** Manifest file name in the AddOns root, e.g. "ArchiveHelper.txt" */
  file: string;
  /** Addon name derived from the manifest file base name */
  addonName: string;
  title: string;
  version: string;
  addonVersion: number;
  /** Root-level files/folders belonging to this manifest that exist on disk */
  relatedFiles: string[];
  /** Whether a proper folder AddOns/<addonName>/ with its own manifest exists */
  folderExists: boolean;
  /** Version of the proper folder's manifest (when folderExists) */
  folderVersion: string;
  /** True when the folder's manifest is same or newer → the root copy is stale */
  rootIsStale: boolean;
}

/** A " 2"/" 3" copy created by macOS Finder when extracting into occupied folders. */
export interface HygieneDuplicate {
  /** Path relative to the AddOns root, e.g. "HodorReflexes/core 2" */
  relPath: string;
  /** The existing original it duplicates, relative to the AddOns root */
  originalRelPath: string;
  isDirectory: boolean;
}

export interface HygienePreview {
  strayManifests: HygieneStrayManifest[];
  duplicates: HygieneDuplicate[];
  /** Root-level files not claimed by any stray manifest (e.g. README.md, esologo.dds) */
  unclaimedRootFiles: string[];
}

const DUPLICATE_RE = /^(.+?) (\d+)(\.[^.]+)?$/;

/** Read version headers from a manifest file (cheap, no full parse). */
function readManifestVersionInfo(p: string): { title: string; version: string; addonVersion: number; files: string[] } | null {
  try {
    const content = fs.readFileSync(p, 'utf-8');
    if (!/^##\s*(Title|APIVersion|Version)\s*:/im.test(content)) return null;
    const headers = parseManifestHeaders(content);
    return {
      title: parseColorCodes(headers['Title'] || '').plain,
      version: headers['Version'] || '',
      addonVersion: headers['AddOnVersion'] ? parseInt(headers['AddOnVersion'], 10) : 0,
      files: parseFileList(content),
    };
  } catch {
    return null;
  }
}

/**
 * Recursively find Finder-duplicate entries ("core 2", "Foo 3.addon") whose
 * original sibling exists.  Depth-limited to keep the scan cheap.
 */
function collectDuplicates(root: string, dir: string, depth: number, results: HygieneDuplicate[]): void {
  if (depth > 5) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.map((e) => e.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const m = entry.name.match(DUPLICATE_RE);
    if (m) {
      const original = m[1] + (m[3] ?? '');
      if (names.has(original)) {
        const rel = path.relative(root, path.join(dir, entry.name));
        results.push({
          relPath: rel,
          originalRelPath: path.relative(root, path.join(dir, original)),
          isDirectory: entry.isDirectory(),
        });
        continue; // don't descend into a folder we already flag as duplicate
      }
    }
    if (entry.isDirectory()) {
      collectDuplicates(root, path.join(dir, entry.name), depth + 1, results);
    }
  }
}

/**
 * Scan the AddOns folder for hygiene problems:
 *  - stray manifests in the root (ZIP extracted into AddOns/ instead of a
 *    subfolder) with the root files/folders belonging to them,
 *  - Finder duplicates (" 2"/" 3" copies) at any depth,
 *  - leftover unclaimed root files.
 * The game only loads AddOns/<Name>/<Name>.txt — everything found here is
 * invisible to ESO and to the normal YAAM scan.
 */
export function previewFolderHygiene(addonsPath: string): HygienePreview {
  const result: HygienePreview = { strayManifests: [], duplicates: [], unclaimedRootFiles: [] };
  if (!fs.existsSync(addonsPath)) return result;

  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(addonsPath, { withFileTypes: true });
  } catch {
    return result;
  }

  const rootFiles = rootEntries.filter((e) => e.isFile()).map((e) => e.name);
  const rootDirs = new Set(rootEntries.filter((e) => e.isDirectory()).map((e) => e.name));
  const minionFiles = new Set(['miniondata.json', 'minion_data.json']);
  const claimed = new Set<string>();

  // 1. Stray manifests in the AddOns root
  for (const file of rootFiles) {
    if (!/\.(txt|addon)$/i.test(file)) continue;
    const info = readManifestVersionInfo(path.join(addonsPath, file));
    if (!info) continue; // not an addon manifest (e.g. a README.txt)
    const addonName = file.replace(/\.(txt|addon)$/i, '');
    claimed.add(file);

    // Root files/folders belonging to this manifest: everything its file list
    // references (first path segment) plus same-basename siblings (Foo.lua/.xml).
    const related = new Set<string>();
    for (const f of info.files) {
      const first = f.replace(/\\/g, '/').split('/')[0].trim();
      if (!first || first === file) continue;
      if (rootDirs.has(first)) related.add(first);
      else if (rootFiles.includes(first)) related.add(first);
    }
    for (const f of rootFiles) {
      if (f !== file && f.startsWith(addonName + '.')) related.add(f);
    }
    for (const r of related) claimed.add(r);

    // Compare against a properly installed folder of the same name
    let folderExists = false;
    let folderVersion = '';
    let rootIsStale = false;
    const properManifest = resolveManifestPath(path.join(addonsPath, addonName), addonName);
    if (properManifest) {
      folderExists = true;
      const folderInfo = readManifestVersionInfo(properManifest);
      folderVersion = folderInfo?.version || '';
      if (folderInfo) {
        // AddOnVersion integers are the most reliable ordering; fall back to
        // version-string comparison, then to "folder wins" (the root copy is
        // dead weight either way — the game never loads it).
        if (info.addonVersion > 0 && folderInfo.addonVersion > 0) {
          rootIsStale = folderInfo.addonVersion >= info.addonVersion;
        } else {
          rootIsStale = compareVersionStrings(info.version, folderInfo.version) <= 0;
        }
      } else {
        rootIsStale = true;
      }
    }

    result.strayManifests.push({
      file,
      addonName,
      title: info.title || addonName,
      version: info.version,
      addonVersion: info.addonVersion,
      relatedFiles: Array.from(related).sort(),
      folderExists,
      folderVersion,
      rootIsStale,
    });
  }

  // 2. Finder duplicates (root level and inside addon folders)
  collectDuplicates(addonsPath, addonsPath, 0, result.duplicates);

  // 3. Unclaimed root files (not a manifest, not claimed, not Minion's data)
  for (const file of rootFiles) {
    if (claimed.has(file)) continue;
    if (file.startsWith('.')) continue; // .DS_Store & friends — pointless to move
    if (minionFiles.has(file.toLowerCase())) continue;
    result.unclaimedRootFiles.push(file);
  }
  result.unclaimedRootFiles.sort();

  return result;
}

/** Undo information returned by applyFolderHygiene — enough to reverse every move. */
export interface HygieneUndoInfo {
  /** Removed/_hygiene/<stamp>/ directory holding the removed items ('' if none) */
  hygieneDir: string;
  /** Removed item paths relative to the AddOns root */
  removals: string[];
  /** Repairs: which items were moved into which new folder */
  repairs: { addonName: string; movedItems: string[] }[];
}

/**
 * Apply selected hygiene actions.
 *  - repairs: stray manifest file names → create AddOns/<Name>/ and MOVE the
 *    manifest plus its related root files into it (fixes the broken install).
 *  - removals: paths relative to the AddOns root → moved (never deleted) to
 *    Removed/_hygiene/<timestamp>/ preserving their relative structure.
 * Returns undo info so the whole operation can be reversed.
 */
export function applyFolderHygiene(
  addonsPath: string,
  actions: { repairs: string[]; removals: string[] }
): { repaired: string[]; removed: string[]; errors: string[]; undo: HygieneUndoInfo } {
  const out = {
    repaired: [] as string[],
    removed: [] as string[],
    errors: [] as string[],
    undo: { hygieneDir: '', removals: [], repairs: [] } as HygieneUndoInfo,
  };

  // Re-scan so we act on current on-disk state, not a stale renderer preview
  const preview = previewFolderHygiene(addonsPath);
  const strayByFile = new Map(preview.strayManifests.map((s) => [s.file, s]));

  for (const file of actions.repairs) {
    const stray = strayByFile.get(file);
    if (!stray) {
      out.errors.push(`Repair skipped: ${file} is no longer a stray manifest`);
      continue;
    }
    if (stray.folderExists) {
      out.errors.push(`Repair skipped: folder ${stray.addonName}/ already exists (use remove instead)`);
      continue;
    }
    try {
      const targetDir = path.join(addonsPath, stray.addonName);
      fs.mkdirSync(targetDir, { recursive: true });
      const toMove = [stray.file, ...stray.relatedFiles];
      const movedItems: string[] = [];
      for (const item of toMove) {
        const src = path.join(addonsPath, item);
        if (!fs.existsSync(src)) continue;
        fs.renameSync(src, path.join(targetDir, item));
        movedItems.push(item);
      }
      out.repaired.push(stray.addonName);
      out.undo.repairs.push({ addonName: stray.addonName, movedItems });
    } catch (err) {
      out.errors.push(`Repair failed for ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (actions.removals.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const removedRoot = path.join(path.dirname(addonsPath), 'Removed', '_hygiene', stamp);
    for (const rel of actions.removals) {
      // Guard against path escapes — only paths inside the AddOns folder
      const src = path.resolve(addonsPath, rel);
      if (!src.startsWith(path.resolve(addonsPath) + path.sep)) {
        out.errors.push(`Removal skipped (outside AddOns): ${rel}`);
        continue;
      }
      if (!fs.existsSync(src)) continue;
      try {
        const dest = path.join(removedRoot, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
        out.removed.push(rel);
        out.undo.hygieneDir = removedRoot;
        out.undo.removals.push(rel);
      } catch (err) {
        out.errors.push(`Removal failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Record what was moved as a unit — listRemovedEntries offers exactly
    // these items for restore (intermediate dirs are scaffolding, not items).
    if (out.undo.removals.length > 0) {
      try {
        fs.writeFileSync(path.join(removedRoot, '_meta.json'), JSON.stringify({ removals: out.undo.removals }, null, 2), 'utf-8');
      } catch { /* listing falls back to first-level entries */ }
    }
  }

  return out;
}

/**
 * Reverse a folder-hygiene run: removed items move back from
 * Removed/_hygiene/<stamp>/ to their original paths, repaired installs move
 * back into the AddOns root (the created folder is removed when empty).
 */
export function undoFolderHygiene(
  addonsPath: string,
  undo: HygieneUndoInfo
): { restored: number; errors: string[] } {
  const out = { restored: 0, errors: [] as string[] };

  // 1. Bring removed items back to their original locations
  for (const rel of undo.removals) {
    const src = path.join(undo.hygieneDir, rel);
    const dest = path.resolve(addonsPath, rel);
    if (!dest.startsWith(path.resolve(addonsPath) + path.sep)) continue;
    if (!fs.existsSync(src)) continue;
    try {
      if (fs.existsSync(dest)) {
        out.errors.push(`Undo skipped (already exists): ${rel}`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      out.restored++;
    } catch (err) {
      out.errors.push(`Undo failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Move repaired items back into the AddOns root
  for (const rep of undo.repairs) {
    const folder = path.join(addonsPath, rep.addonName);
    for (const item of rep.movedItems) {
      const src = path.join(folder, item);
      const dest = path.join(addonsPath, item);
      if (!fs.existsSync(src)) continue;
      try {
        if (fs.existsSync(dest)) {
          out.errors.push(`Undo skipped (already exists): ${item}`);
          continue;
        }
        fs.renameSync(src, dest);
        out.restored++;
      } catch (err) {
        out.errors.push(`Undo failed for ${item}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Drop the created folder when nothing is left inside
    try {
      if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) {
        fs.rmdirSync(folder);
      }
    } catch { /* leave non-empty folder in place */ }
  }

  return out;
}

// ─── Removed/ management (global restore path for every move-style delete) ───

/** One restorable entry from the Removed/ folder. */
export interface RemovedEntry {
  /** Display name (folder or file name) */
  name: string;
  /** Path relative to Removed/ — key for restore */
  relPath: string;
  /** True when this entry came from a hygiene run (nested under _hygiene/<stamp>/) */
  fromHygiene: boolean;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * List everything restorable from Removed/: top-level folders moved by
 * delete/cleanup operations, plus items captured by hygiene runs.
 */
export function listRemovedEntries(addonsPath: string): RemovedEntry[] {
  const removedRoot = path.join(path.dirname(addonsPath), 'Removed');
  if (!fs.existsSync(removedRoot)) return [];
  const results: RemovedEntry[] = [];

  const statOf = (p: string): { size: number; mtimeMs: number; isDir: boolean } => {
    try {
      const st = fs.statSync(p);
      return { size: st.isDirectory() ? getDirSizeSafe(p) : st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
    } catch {
      return { size: 0, mtimeMs: 0, isDir: false };
    }
  };

  for (const entry of fs.readdirSync(removedRoot, { withFileTypes: true })) {
    if (entry.name === '_hygiene') {
      // Hygiene stamps: list each item that was moved AS A UNIT (recorded in
      // _meta.json); intermediate directories are scaffolding, not items.
      const hygieneRoot = path.join(removedRoot, '_hygiene');
      for (const stamp of fs.readdirSync(hygieneRoot, { withFileTypes: true })) {
        if (!stamp.isDirectory()) continue;
        const stampDir = path.join(hygieneRoot, stamp.name);
        let items: string[] = [];
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(stampDir, '_meta.json'), 'utf-8'));
          if (Array.isArray(meta.removals)) items = meta.removals as string[];
        } catch {
          // Pre-meta stamps: fall back to first-level entries
          items = fs.readdirSync(stampDir).filter((n) => n !== '_meta.json');
        }
        for (const rel of items) {
          const abs = path.join(stampDir, rel);
          if (!fs.existsSync(abs)) continue; // already restored
          const st = statOf(abs);
          results.push({
            name: rel,
            relPath: `_hygiene/${stamp.name}/${rel}`,
            fromHygiene: true,
            isDirectory: st.isDir,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      }
      continue;
    }
    const st = statOf(path.join(removedRoot, entry.name));
    results.push({
      name: entry.name,
      relPath: entry.name,
      fromHygiene: false,
      isDirectory: st.isDir,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** getDirSize that tolerates unreadable entries. Bounded against link loops. */
function getDirSizeSafe(dirPath: string, depth = 0, visited: Set<string> = new Set()): number {
  if (!canEnterDir(dirPath, depth, visited)) return 0;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) continue; // size of the target, not the link
      if (entry.isDirectory()) total += getDirSizeSafe(full, depth + 1, visited);
      else {
        try { total += fs.statSync(full).size; } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total;
}

/**
 * Restore an entry from Removed/ back into the AddOns folder.
 * Top-level entries go to AddOns/<name>; hygiene entries return to their
 * captured relative path.  Never overwrites an existing target.
 */
export function restoreRemovedEntry(
  addonsPath: string,
  relPath: string
): { restored: boolean; target: string; error?: string } {
  const removedRoot = path.join(path.dirname(addonsPath), 'Removed');
  const src = path.resolve(removedRoot, relPath);
  if (!src.startsWith(path.resolve(removedRoot) + path.sep)) {
    return { restored: false, target: '', error: 'Invalid path' };
  }
  if (!fs.existsSync(src)) {
    return { restored: false, target: '', error: 'Entry no longer exists' };
  }
  // Hygiene entries carry their original AddOns-relative path after the stamp
  const hygieneMatch = relPath.match(/^_hygiene\/[^/]+\/(.+)$/);
  const targetRel = hygieneMatch ? hygieneMatch[1] : relPath;
  const dest = path.resolve(addonsPath, targetRel);
  if (!dest.startsWith(path.resolve(addonsPath) + path.sep)) {
    return { restored: false, target: targetRel, error: 'Invalid target path' };
  }
  if (fs.existsSync(dest)) {
    return { restored: false, target: targetRel, error: 'Target already exists — delete it first' };
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return { restored: true, target: targetRel };
  } catch (err) {
    return { restored: false, target: targetRel, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Deletion / Cleanup ───

function moveToRemoved(addonsPath: string, folderNames: string[]): string[] {
  const removedDir = path.join(path.dirname(addonsPath), 'Removed');
  if (!fs.existsSync(removedDir)) {
    fs.mkdirSync(removedDir, { recursive: true });
  }
  const moved: string[] = [];
  for (const name of folderNames) {
    const src = path.join(addonsPath, name);
    const dest = path.join(removedDir, name);
    if (fs.existsSync(src)) {
      try {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(src, dest);
        moved.push(name);
      } catch (err) {
        console.error(`Failed to move ${name}:`, err);
      }
    }
  }
  return moved;
}

/**
 * Move all unreferenced libraries into Removed/.
 */
export function previewUnusedLibraries(addonsPath: string): { unreferenced: string[]; optionalOnly: string[] } {
  const allAddons = scanAddonsFolder(addonsPath);
  // Track required vs optional references separately
  const requiredRefs = new Set<string>();
  const optionalRefs = new Set<string>();
  for (const addon of allAddons) {
    for (const dep of addon.dependsOn) requiredRefs.add(dep.name);
    for (const dep of addon.optionalDependsOn) optionalRefs.add(dep.name);
    for (const sub of addon.subAddons) {
      for (const dep of sub.dependsOn) requiredRefs.add(dep.name);
      for (const dep of sub.optionalDependsOn) optionalRefs.add(dep.name);
    }
  }
  const unreferenced: string[] = [];
  const optionalOnly: string[] = [];
  for (const a of allAddons) {
    if (!a.isLibrary) continue;
    const isRequired = requiredRefs.has(a.folderName) || requiredRefs.has(a.title);
    const isOptional = optionalRefs.has(a.folderName) || optionalRefs.has(a.title);
    if (!isRequired && !isOptional) {
      unreferenced.push(a.folderName);
    } else if (!isRequired && isOptional) {
      optionalOnly.push(a.folderName);
    }
  }
  return { unreferenced: unreferenced.sort(), optionalOnly: optionalOnly.sort() };
}

export function cleanupSelectedLibraries(addonsPath: string, folderNames: string[]): { moved: string[]; addons: AddonInfo[] } {
  const moved = moveToRemoved(addonsPath, folderNames);
  const updatedAddons = scanAddonsFolder(addonsPath);
  return { moved, addons: updatedAddons };
}

export function cleanupUnusedLibraries(addonsPath: string): { moved: string[]; addons: AddonInfo[] } {
  const allAddons = scanAddonsFolder(addonsPath);

  // Build set of all referenced dependency names (top-level AND sub-addons)
  const referenced = new Set<string>();
  for (const addon of allAddons) {
    for (const dep of addon.dependsOn) referenced.add(dep.name);
    for (const dep of addon.optionalDependsOn) referenced.add(dep.name);
    for (const sub of addon.subAddons) {
      for (const dep of sub.dependsOn) referenced.add(dep.name);
      for (const dep of sub.optionalDependsOn) referenced.add(dep.name);
    }
  }

  const unreferenced = allAddons
    .filter((a) => a.isLibrary && !referenced.has(a.folderName) && !referenced.has(a.title))
    .map((a) => a.folderName);

  const moved = moveToRemoved(addonsPath, unreferenced);
  const updatedAddons = scanAddonsFolder(addonsPath);
  return { moved, addons: updatedAddons };
}

export function deleteAddon(addonsPath: string, folderName: string): AddonInfo[] {
  moveToRemoved(addonsPath, [folderName]);
  return scanAddonsFolder(addonsPath);
}

export function deleteAddonAndExclusiveRefs(
  addonsPath: string,
  folderName: string
): { removedAddon: string; removedLibs: string[]; addons: AddonInfo[] } {
  const allAddons = scanAddonsFolder(addonsPath);
  const target = allAddons.find((a) => a.folderName === folderName);
  if (!target) {
    return { removedAddon: folderName, removedLibs: [], addons: allAddons };
  }

  // Collect all dependencies of the target (including sub-addon deps)
  const targetDeps = new Set<string>();
  for (const dep of target.dependsOn) targetDeps.add(dep.name);
  for (const dep of target.optionalDependsOn) targetDeps.add(dep.name);
  for (const sub of target.subAddons) {
    for (const dep of sub.dependsOn) targetDeps.add(dep.name);
    for (const dep of sub.optionalDependsOn) targetDeps.add(dep.name);
  }

  // Reference counts from all OTHER addons
  const otherRefCounts = new Map<string, number>();
  for (const addon of allAddons) {
    if (addon.folderName === folderName) continue;
    const allDeps = [
      ...addon.dependsOn,
      ...addon.optionalDependsOn,
      ...addon.subAddons.flatMap((s) => [...s.dependsOn, ...s.optionalDependsOn]),
    ];
    for (const dep of allDeps) {
      otherRefCounts.set(dep.name, (otherRefCounts.get(dep.name) || 0) + 1);
    }
  }

  const exclusiveLibs = allAddons
    .filter(
      (a) =>
        a.isLibrary &&
        (targetDeps.has(a.folderName) || targetDeps.has(a.title)) &&
        !otherRefCounts.has(a.folderName) &&
        !otherRefCounts.has(a.title)
    )
    .map((a) => a.folderName);

  const toRemove = [folderName, ...exclusiveLibs];
  moveToRemoved(addonsPath, toRemove);

  const updatedAddons = scanAddonsFolder(addonsPath);
  return { removedAddon: folderName, removedLibs: exclusiveLibs, addons: updatedAddons };
}
