// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { AddonInfo, DependencyRef, ColorSegment, YaamAddonEntry } from './shared/types';
import { loadDatabase, saveDatabase, YaamDatabase } from './yaamDatabase';

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
function extractDownloadUrl(content: string, _folderName: string): string {
  const urlMatch = content.match(/https?:\/\/(?:www\.)?esoui\.com\/downloads\/info\d+-[^\s"'<>]+\.html/i);
  if (urlMatch) return urlMatch[0];
  return '';
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

  const rawTitle = headers['Title'] || folderName;
  const { plain: title, segments: titleSegments } = parseColorCodes(rawTitle);
  const rawAuthor = headers['Author'] || '';
  const { plain: author, segments: authorSegments } = parseColorCodes(rawAuthor);
  const rawDescription = headers['Description'] || '';
  const { plain: description, segments: descriptionSegments } = parseColorCodes(rawDescription);
  const rawContributors = headers['Contributors'] || '';
  const { plain: contributors, segments: contributorsSegments } = parseColorCodes(rawContributors);
  const downloadUrl = extractDownloadUrl(content, folderName);
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
  };
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
): void {
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
    const addonManifest = path.join(subDir, `${subName}.addon`);
    const txtManifest = path.join(subDir, `${subName}.txt`);
    let manifestPath: string | null = null;

    if (fs.existsSync(addonManifest)) manifestPath = addonManifest;
    else if (fs.existsSync(txtManifest)) manifestPath = txtManifest;

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
    collectSubAddons(subDir, selfName, topParent, results);
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
    const addonManifest = path.join(folderPath, `${folderName}.addon`);
    const txtManifest = path.join(folderPath, `${folderName}.txt`);

    let manifestPath: string | null = null;
    if (fs.existsSync(addonManifest)) manifestPath = addonManifest;
    else if (fs.existsSync(txtManifest)) manifestPath = txtManifest;

    if (manifestPath) {
      try {
        addons.push(parseManifest(manifestPath, folderName, undefined, addonsPath));
      } catch (err) {
        console.error(`Failed to parse manifest for ${folderName}:`, err);
      }
    }
  }

  // Inject yaamMeta from the central database + detect runtime-created files
  const db = loadDatabase(addonsPath);
  for (const addon of addons) {
    const entry = db.addons[addon.folderName];
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

  return addons;
}

/**
 * Walk an addon folder recursively and return all file paths relative to the addon root.
 */
function walkAddonFolder(folderPath: string, prefix = ''): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...walkAddonFolder(path.join(folderPath, entry.name), relPath));
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
  return actualFiles.filter(f => !installedSet.has(f));
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
    const addonManifest = path.join(folderPath, `${folderName}.addon`);
    const txtManifest = path.join(folderPath, `${folderName}.txt`);
    let manifestPath: string | null = null;
    if (fs.existsSync(addonManifest)) manifestPath = addonManifest;
    else if (fs.existsSync(txtManifest)) manifestPath = txtManifest;
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
      if (existing.esouid !== m.esouid) changes.push(`id: ${existing.esouid}→${m.esouid}`);
      if (existing.catalogName !== m.name) changes.push(`name: ${existing.catalogName}→${m.name}`);
      if (existing.localVersion !== m.localVersion) changes.push(`localVer: ${existing.localVersion}→${m.localVersion}`);

      db.addons[m.folderName] = {
        esouid: m.esouid,
        url: m.url,
        catalogName: m.name,
        catalogAuthor: m.author,
        catalogVersion: existing.catalogVersion,  // preserve install-time value
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
      changed = true;
      result.updated++;
      result.details.push(`Updated ${m.folderName}: ${changes.join(', ')}`);
    }
  }

  if (changed) saveDatabase(db, addonsPath);
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
