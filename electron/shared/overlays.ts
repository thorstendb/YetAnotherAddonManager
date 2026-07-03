// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Overlay classification for the "LangPatch problem".
 *
 * Many ESOUI entries deliberately write into ANOTHER addon's folder: language
 * patches, translation packs, API hotfixes.  The catalog models this as
 * multiple entries claiming the same UIDir (161 dirs have >1 primary claimant).
 * Version numbers of original and patch are INDEPENDENT (AsylumNotifier 1.2.0
 * vs. its LangPatch 2.1.5), and patches usually replace the original's
 * manifest, hijacking title and version.
 *
 * This module decides, per directory, which catalog entry is the ORIGINAL
 * (the folder's main identity) and which entries are OVERLAYS layered on top.
 */
import { CatalogAddon } from './types';

/** ESOUI categories that hold folder-sharing patches:
 *  33 = "Plug-Ins & Patches", 163 = "Unofficial Game Translations" */
export const OVERLAY_CATEGORY_IDS = new Set(['33', '163']);

/** Name patterns marking translation/patch releases across the languages seen
 *  in the live catalog (LangPatch, "JP Patch for …", Traducción, Traduzione,
 *  русификатор, "lang.CN JP RU", "Fr Localization", …). */
const OVERLAY_NAME_RE = new RegExp(
  [
    'lang[\\s.]*patch',
    '\\bpatch\\s+for\\b',
    '\\bjp[\\s_-]?fix',
    '\\b(ru|jp|cn|kr|pl|fr|es|it|de|br|ua)\\s+(patch|lang|localization)',
    'translat', 'traduc', 'traduz', 'übersetz', 'localiz', 'локализ', 'русифи',
    '\\blang\\.\\s*(cn|jp|ru|kr|de|fr)',
  ].join('|'),
  'i'
);

/** Heuristic: does this catalog entry look like a patch/translation overlay? */
export function isOverlayStyleEntry(ca: Pick<CatalogAddon, 'categoryId' | 'name'>): boolean {
  return OVERLAY_CATEGORY_IDS.has(ca.categoryId) || OVERLAY_NAME_RE.test(ca.name);
}

export interface DirOwnership {
  /** The folder's main identity: best non-overlay entry claiming it as primary dir */
  original?: CatalogAddon;
  /** Overlay-style entries targeting this folder (they write INTO it) */
  overlays: CatalogAddon[];
}

/**
 * Classify every catalog directory: who owns it, and which overlay entries
 * write into it.  Non-overlay co-claimants (forks like "RaidNotifier Updated")
 * are NOT listed here — they stay in the replacement-candidate flow.
 */
export function classifyDirOwnership(catalog: CatalogAddon[]): Map<string, DirOwnership> {
  const byDir = new Map<string, { primary: CatalogAddon[]; secondary: CatalogAddon[] }>();
  for (const ca of catalog) {
    for (let i = 0; i < ca.directories.length; i++) {
      const d = ca.directories[i];
      let rec = byDir.get(d);
      if (!rec) {
        rec = { primary: [], secondary: [] };
        byDir.set(d, rec);
      }
      (i === 0 ? rec.primary : rec.secondary).push(ca);
    }
  }

  const result = new Map<string, DirOwnership>();
  for (const [dir, rec] of byDir) {
    const primaryNonOverlay = rec.primary.filter((ca) => !isOverlayStyleEntry(ca));
    // Most-downloaded non-overlay primary claimant wins the folder
    const original = primaryNonOverlay.slice().sort((a, b) => b.totalDownloads - a.totalDownloads)[0];
    const overlays = [...rec.primary, ...rec.secondary].filter(
      (ca) => ca !== original && isOverlayStyleEntry(ca)
    );
    if (overlays.length > 0) {
      result.set(dir, { original, overlays });
    }
  }
  return result;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Manifest-hijack evidence: language patches replace <Folder>.txt, so the
 * installed manifest carries the PATCH's title (e.g. "AsylumNotifier.LangPatch").
 * Returns the overlay whose catalog name matches the local manifest title.
 */
export function findHijackedManifestOverlay(
  localTitle: string,
  overlays: CatalogAddon[]
): CatalogAddon | undefined {
  const t = norm(localTitle);
  if (!t) return undefined;
  return overlays.find((ov) => norm(ov.name) === t);
}
