// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Shared types for YAAM - Yet Another Addon Manager
 */

/** A segment of colored text from game markup */
export interface ColorSegment {
  text: string;
  color?: string; // hex color e.g. "#ff0096"
}

export interface AddonInfo {
  /** Folder name on disk – PRIMARY IDENTIFIER for dependencies and settings */
  folderName: string;
  /** Title from manifest (raw, with color codes stripped) */
  title: string;
  /** Title with color segments for rich display */
  titleSegments: ColorSegment[];
  /** Author(s) */
  author: string;
  /** Author with color segments */
  authorSegments: ColorSegment[];
  /** Version string (display) */
  version: string;
  /** Numeric addon version (used for DependsOn >= checks) */
  addonVersion: number;
  /** API version */
  apiVersion: string;
  /** Description */
  description: string;
  /** Description with color segments */
  descriptionSegments: ColorSegment[];
  /** Whether this is a library */
  isLibrary: boolean;
  /** Required dependencies: name -> optional minimum version */
  dependsOn: DependencyRef[];
  /** Optional dependencies */
  optionalDependsOn: DependencyRef[];
  /** Saved variable names declared in this addon's manifest */
  savedVariables: string[];
  /** Contributors */
  contributors: string;
  /** Contributors with color segments */
  contributorsSegments: ColorSegment[];
  /** File list from manifest */
  files: string[];
  /** Full path to addon folder */
  path: string;
  /** Catalog download URL (best effort) */
  downloadUrl: string;
  /** ESOUI catalog UID extracted from downloadUrl (e.g. "1346") */
  catalogId: string;

  // ─── Sub-addon & hierarchy fields ───

  /** Sub-addons embedded inside this addon's folder (recursive) */
  subAddons: AddonInfo[];
  /** If this IS a sub-addon, the top-level parent addon's folder name */
  parentAddon?: string;
  /** Manifest file type ('txt' or 'addon') */
  manifestType: 'txt' | 'addon';
  /** Folder without a manifest of its own that holds the real addons in
   *  subAddons (ArkadiusTradeTools/ArkadiusTradeTools/…, HarvestMapData/Modules/…) */
  isContainer?: boolean;
  /** PC-specific dependencies (already merged into dependsOn on PC) */
  pcDependsOn: DependencyRef[];
  /**
   * ALL SavedVariable names owned by this addon tree (self + all sub-addons).
   * Used for accurate cleanup to avoid destroying user settings.
   */
  allSavedVariableNames: string[];
  /** YAAM database entry for this addon (if present) */
  yaamMeta?: YaamAddonEntry;
  /** YAAM marker file data read from .yaam.json in the addon folder */
  yaamMarker?: YaamMarker;
  /** Files found in the addon folder that were NOT part of the original install (runtime-created) */
  runtimeFiles?: string[];
  /** Manifest file mtime (epoch seconds).  Extraction rewrites it, so it
   *  approximates the install time — a stateless update hint:
   *  catalog published later than this → likely newer than what's on disk. */
  manifestMtime?: number;
}

/**
 * An overlay (language patch / fix pack) installed INTO another addon's folder.
 * Overlays have their own catalog identity and version history, independent of
 * the folder's main addon — one folder can hold 1 original + N overlays.
 */
export interface YaamOverlayEntry {
  /** ESOUI catalog UID of the overlay entry */
  esouid: string;
  /** Catalog name at time of install/update */
  catalogName: string;
  /** Catalog version of the overlay at time of install/update */
  catalogVersion: string;
  /** Catalog date (epoch seconds) at time of install/update */
  catalogDate?: number;
  /** ISO timestamp of first install via YAAM */
  installedAt: string;
  /** ISO timestamp of last update via YAAM */
  updatedAt: string;
  /** Relative file paths from the overlay's ZIP (for conflict detection) */
  installedFiles?: string[];
  /** Set when a later install of the main addon overwrote overlay files —
   *  the overlay should be re-applied (re-installed) to restore the patch. */
  needsReapply?: boolean;
}

/** Per-addon metadata stored in the central YAAM database (yaam-addons.json). */
export interface YaamAddonEntry {
  /** ESOUI catalog UID (e.g. "1346") */
  esouid: string;
  /** ESOUI info URL */
  url: string;
  /** Catalog name at time of install/update */
  catalogName: string;
  /** Author from catalog */
  catalogAuthor: string;
  /** Version string from the ESOUI catalog record */
  catalogVersion: string;
  /** Catalog date (epoch seconds) at time of install/update — detects re-publishes */
  catalogDate?: number;
  /** Version string from the addon's local manifest (## Version) */
  localVersion: string;
  /** ISO timestamp of first install via YAAM */
  installedAt: string;
  /** ISO timestamp of last update via YAAM */
  updatedAt: string;
  /** Relative file paths from the original ZIP (install manifest for detecting runtime-created files) */
  installedFiles?: string[];
  /** Overlays (language patches, fixes) layered into this addon's folder */
  overlays?: YaamOverlayEntry[];
}

/**
 * Per-addon marker file (.yaam.json) stored directly in each addon folder.
 * Provides resilient tracking: survives DB loss, is portable across machines,
 * and enables instant identification of YAAM-managed addons without DB lookup.
 */
export interface YaamMarker {
  /** ESOUI catalog UID (e.g. "1346") — the golden key */
  esouid: string;
  /** ESOUI catalog version string at time of install/update */
  catalogVersion: string;
  /** Catalog date (epoch seconds) at time of install/update */
  catalogDate?: number;
  /** Catalog name at time of install/update */
  catalogName: string;
  /** Manifest version scanned right after extraction — anchor for detecting
   *  external file changes.  If the current manifest version still equals this,
   *  the files on disk are exactly what YAAM installed and catalogVersion is
   *  authoritative (even when the author never bumps the manifest header). */
  localVersion?: string;
  /** ISO timestamp of first install via YAAM */
  installedAt: string;
  /** ISO timestamp of last update via YAAM */
  updatedAt: string;
  /** Overlays (language patches, fixes) layered into this addon's folder */
  overlays?: YaamOverlayEntry[];
  /** Relative file paths from the original ZIP.  Lives in the marker so the
   *  central DB is FULLY reconstructable from the folders alone — deleting
   *  yaam-addons.json is lossless. */
  installedFiles?: string[];
}

export interface DependencyRef {
  name: string;
  minVersion?: number;
}

// ─── Version comparison utilities ───

/** Pre-release ordering: lower number = earlier in the release cycle */
const VERSION_PRE_RELEASE_ORDER: Record<string, number> = {
  dev: 0, alpha: 1, pre: 2, beta: 3, rc: 4,
};

/**
 * Split a compact 8-digit datestamp (YYYYMMDD, e.g. "20240310") into
 * [YYYY, MM, DD].  Authors freely switch between "2024.03.10" and "20240310"
 * (HodorReflexes even uses both at once: Version 2024.03.10 / AddOnVersion
 * 20240310).  Returns null when the value is not a plausible datestamp.
 */
function splitDatestamp(n: number): number[] | null {
  if (n < 19900101 || n > 20991231) return null;
  const y = Math.floor(n / 10000);
  const m = Math.floor((n % 10000) / 100);
  const d = n % 100;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return [y, m, d];
}

/**
 * Normalize date-based version parts to [YYYY, MM, DD] order so that
 * ISO (2026-03-30), US (03/30/2026), and EU (30.03.2026) compare correctly.
 *
 * Only triggers for exactly 3 numeric segments where one value is ≥ 2000
 * (a plausible year), so normal versions like "1.2.3" are left untouched.
 */
function normalizeDateParts(parts: number[]): number[] {
  if (parts.length !== 3) return parts;
  const [a, b, c] = parts;

  // ISO: YYYY-MM-DD (first segment is the year)
  if (a >= 2000 && b >= 1 && b <= 12 && c >= 1 && c <= 31) {
    return parts; // already [YYYY, MM, DD]
  }

  // Trailing year: ?-?-YYYY
  if (c >= 2000) {
    // EU: DD-MM-YYYY — day > 12 rules out US interpretation
    if (a > 12 && a <= 31 && b >= 1 && b <= 12) {
      return [c, b, a];
    }
    // US: MM-DD-YYYY (also the fallback for ambiguous cases like 05/06/2026)
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      return [c, a, b];
    }
  }

  return parts; // not a recognisable date — leave as-is
}

/**
 * Parse a version string into numeric parts and optional pre-release tag.
 *
 * Supported formats (from real addons):
 *   1.2.3, 0.8.6         – standard semver
 *   2025.08.08            – date-based (YYYY.MM.DD)
 *   2025-12-01            – date-based with hyphens (ISO)
 *   03/30/2025            – date-based US (MM/DD/YYYY)
 *   30.03.2025            – date-based EU (DD.MM.YYYY)
 *   2.0 r41, 1.0 r7       – revision suffix
 *   3.0r4.6               – concatenated revision
 *   2.3.22 build 1442     – with build number
 *   v2.31                 – leading v prefix
 *   85, 104               – simple integer
 *   20240310              – compact datestamp (≡ 2024.03.10)
 *   3.16.7b, 2.1.5b       – hotfix letter suffix (3.16.7 < 3.16.7a < 3.16.7b)
 *   4.0.5.6.1             – extra-long (arbitrary number of segments)
 *   1.0-alpha, 1.0-rc.2  – pre-release
 *   2026-03-04 (20260304) – with parenthesized build metadata
 *   1.2.3 (2026-01-01)   – version with parenthesized date sub-version
 */
export function parseVersionParts(raw: string): {
  parts: number[];
  subParts: number[];
  isDate: boolean;
  preRelease?: string;
  preReleaseNum: number;
  suffix?: string;
  suffixParts: number[];
  /** Hotfix letter directly after the last digit: 0 = none, a=1, b=2, … */
  letterRank: number;
} {
  let s = (raw || '').trim();

  // Strip leading 'v' or 'V'
  s = s.replace(/^v/i, '');

  // Extract parenthesized sub-version, e.g. "2026-03-04 (20260304)" or "1.2.3 (2026-01-01)"
  let subParts: number[] = [];
  const parenMatch = s.match(/\s*\(([^)]*)\)/);
  if (parenMatch) {
    const inner = parenMatch[1].replace(/^v/i, '').replace(/\b(?:build|rev)\b/gi, '');
    const subNums = inner.match(/\d+/g);
    if (subNums) {
      subParts = normalizeDateParts(subNums.map(Number));
    }
    s = s.replace(parenMatch[0], '');
  }

  // Detect and extract pre-release markers
  let preRelease: string | undefined;
  let preReleaseNum = 0;
  const preMatch = s.match(/[.\-_\s]?(alpha|beta|dev|rc|pre)[.\-_\s]?(\d+)?/i);
  if (preMatch) {
    preRelease = preMatch[1].toLowerCase();
    preReleaseNum = preMatch[2] ? parseInt(preMatch[2], 10) : 0;
    s = s.replace(preMatch[0], '');
  }

  // Detect and extract a hotfix letter suffix: a single letter directly after
  // the last digit at the end of the string ("3.16.7b", "1.4.2a").  ESO
  // convention: this is a re-release AFTER the plain version, so
  // 3.16.7 < 3.16.7a < 3.16.7b.  Multi-letter tails ("36.23PL", "1.02-custom")
  // are language/author tags with no orderable meaning and stay ignored.
  let letterRank = 0;
  const letterMatch = s.match(/(\d)([a-z])$/i);
  if (letterMatch) {
    letterRank = letterMatch[2].toLowerCase().charCodeAt(0) - 96; // a=1 … z=26
    s = s.slice(0, -1);
  }

  // Detect and extract suffix keywords (r, build, rev) that split the version
  // into a base part and a suffix part.
  //   "2.0 r41"        → base "2.0",  suffix "r",     suffixRaw "41"
  //   "3.0r5.0"        → base "3.0",  suffix "r",     suffixRaw "5.0"
  //   "2.3.22 build 1442" → base "2.3.22", suffix "build", suffixRaw "1442"
  //   "2.r1"           → base "2",    suffix "r",     suffixRaw "1"
  let suffix: string | undefined;
  let suffixParts: number[] = [];
  const suffixMatch = s.match(/(?:^|[\s._\d-])(r|build|rev)[\s._-]?(\d[\d.\s]*)/i);
  if (suffixMatch) {
    suffix = suffixMatch[1].toLowerCase();
    // Extract numeric segments from the suffix portion
    const sfxNums = suffixMatch[2].match(/\d+/g);
    if (sfxNums) {
      suffixParts = sfxNums.map(Number);
    }
    // Remove the suffix portion from s so that base parts are clean
    const suffixStart = suffixMatch.index! + (suffixMatch[0].length - suffixMatch[0].trimStart().length);
    // Find where the suffix keyword starts (might have a leading separator)
    const fullMatchIdx = s.indexOf(suffixMatch[0]);
    // Keep everything before the suffix keyword; some leading chars may be separators
    // We need to find the actual keyword position
    const keywordIdx = s.toLowerCase().indexOf(suffix, fullMatchIdx);
    s = s.substring(0, keywordIdx).replace(/[\s._-]+$/, '');
  }

  // Extract all numeric groups from the base part
  const nums = s.match(/\d+/g);
  let parts = nums ? nums.map(Number) : [0];

  // A single 8-digit group is a compact datestamp (20240310 ≡ 2024.03.10)
  if (parts.length === 1) {
    const stamp = splitDatestamp(parts[0]);
    if (stamp) parts = stamp;
  }

  // Normalise date-based versions so ISO / US / EU all compare correctly
  parts = normalizeDateParts(parts);
  // Detect whether this version looks like a date (3 segments with a plausible year)
  const isDate = parts.length === 3 && parts[0] >= 2000 && parts[1] >= 1 && parts[1] <= 12 && parts[2] >= 1 && parts[2] <= 31;

  return { parts, subParts, isDate, preRelease, preReleaseNum, suffix, suffixParts, letterRank };
}

/**
 * Test whether two version strings denote the SAME release despite different
 * formatting schemes. Authors freely reformat between releases and platforms:
 *   "U50.0.0"  ≡ "50.0.0"     (UI-update prefix)
 *   "1.0 r47"  ≡ "1.0.47"     (revision suffix vs. dot segment)
 *   "1.03"     ≡ "1.0.3"      (zero-padding vs. extra segment)
 *   "112"      ≡ "1.12"       (AddOnVersion integer vs. dotted)
 *   "1.0 rev3" ≡ "1.0 r3"     (equivalent suffix keywords)
 *
 * Strategy: strip decoration (prefixes, separators, keywords) and compare the
 * remaining digit sequences. Deliberately strict: the FULL digit sequence must
 * match, so "2.0" vs "2.0 r41" and "2.0 r41" vs "2.0 r42" stay different and
 * are ordered by compareVersionStrings as before.
 * Only an EQUALITY test — ordering still goes through compareVersionStrings.
 */
export function versionsDigitEqual(a: string, b: string): boolean {
  const sa = (a || '').trim();
  const sb = (b || '').trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;

  const va = parseVersionParts(sa);
  const vb = parseVersionParts(sb);
  // Different pre-release tags are never the same release (1.0-beta ≠ 1.0).
  if (va.preRelease !== vb.preRelease || va.preReleaseNum !== vb.preReleaseNum) return false;
  // A hotfix letter marks a NEW release: "3.16.7" ≠ "3.16.7b" even though the
  // digit sequences are identical.
  if (va.letterRank !== vb.letterRank) return false;
  // Date-based versions compare reliably as parts, not as digit concatenation
  // (that would equate "2026.1.10" with "2026.11.0").  When BOTH sides are
  // dates, equal [Y,M,D] parts mean the same release regardless of formatting
  // ("20260620" ≡ "2026.06.20" ≡ "2026-06-20") — but parenthesized build
  // metadata must match too ("2026-03-04 (20260304)" ≠ "2026-03-04 (20260305)").
  // A date on only one side is a scheme change — never equal here.
  if (va.isDate || vb.isDate) {
    return va.isDate && vb.isDate
      && va.parts.length === vb.parts.length
      && va.parts.every((p, i) => p === vb.parts[i])
      && va.subParts.length === vb.subParts.length
      && va.subParts.every((p, i) => p === vb.subParts[i]);
  }

  const rawDigits = (s: string): string => (s.match(/\d+/g) || []).join('');
  const da = rawDigits(sa);
  const db = rawDigits(sb);
  return da !== '' && da === db;
}

/**
 * Convert a Unix timestamp (seconds) to a date-based version string YYYY.MM.DD.
 * Useful as a fallback "version" when an addon has no Version header
 * but the catalog provides a last-updated date.
 */
export function dateToVersion(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

/**
 * Compare two version strings.
 * Returns <0 if a < b, 0 if equal, >0 if a > b.
 *
 * Empty or missing version strings are treated as "oldest" (less than anything).
 *
 * A pre-release version is always less than the corresponding release:
 *   1.0-alpha < 1.0-beta < 1.0-rc < 1.0
 *
 * When the versioning schemes are incompatible (one is date-based, the other
 * is not), the caller can supply an optional catalog upload date as a reliable
 * fallback. Without it, the raw numeric comparison still applies (best effort).
 */
export function compareVersionStrings(a: string, b: string, catalogDateEpoch?: number): number {
  const sa = (a || '').trim();
  const sb = (b || '').trim();
  if (sa === sb) return 0;
  // Empty version is always "oldest"
  if (!sa && !sb) return 0;
  if (!sa) return -1;
  if (!sb) return 1;

  // Same release in a different formatting scheme (U-prefix, r-suffix vs. dot
  // segment, zero-padding, …) — settle as equal before any ordering heuristics.
  if (versionsDigitEqual(sa, sb)) return 0;

  const va = parseVersionParts(sa);
  const vb = parseVersionParts(sb);

  // ── Version scheme mismatch detection ──
  // When the local version and catalog version use fundamentally different
  // numbering schemes, raw numeric comparison is meaningless.
  // In all mismatch cases the catalog upload date is the reliable anchor:
  //   • a = local version, b = catalog version
  //   • catalogDateEpoch = catalog upload timestamp (seconds)
  //
  // Scheme categories:
  //   date    – isDate=true (YYYY.MM.DD / YYYY-MM-DD / …)
  //   semver  – 3+ numeric parts, not date-like  (1.2.3, 4.0.5.6.1)
  //   short   – 1-2 numeric parts  (49, 2.31, 316.5)
  //
  // A mismatch is any transition between these categories.

  if (catalogDateEpoch) {
    const aIsShort = !va.isDate && va.parts.length <= 2;
    const bIsShort = !vb.isDate && vb.parts.length <= 2;
    const aIsSemver = !va.isDate && va.parts.length >= 3;
    const bIsSemver = !vb.isDate && vb.parts.length >= 3;

    // date ↔ non-date
    if (va.isDate !== vb.isDate) {
      const catalogDateParts = parseVersionParts(dateToVersion(catalogDateEpoch)).parts;
      if (va.isDate) {
        // local is date-based, catalog switched to semver/short
        // → compare local date against catalog upload date
        for (let i = 0; i < 3; i++) {
          const na = va.parts[i] ?? 0;
          const nb = catalogDateParts[i] ?? 0;
          if (na !== nb) return na - nb;
        }
        return 0;
      } else {
        // local is semver/short, catalog switched to date-based
        // → compare catalog upload date against local date proxy
        //   (upload date is the reliable anchor)
        return -1;
      }
    }

    // short (1-2 parts) ↔ semver (3+ parts)
    // The segment count difference is the strongest signal of a scheme change.
    // Examples: "49" vs "3.16.5", "316.5" vs "3.16.5", "31605" vs "3.16.5"
    // Exception: pre-release tags reduce segment count naturally
    //   ("1.2-beta" parses as [1,2] + preRelease="beta") — NOT a scheme change.
    if ((aIsShort && bIsSemver) || (aIsSemver && bIsShort)) {
      const shorter = aIsShort ? va : vb;
      const longer = aIsShort ? vb : va;
      // If the shorter side has a pre-release tag AND its numeric parts are
      // a prefix of the longer side, this is a normal version comparison,
      // not a scheme change.  e.g. "1.2-beta" vs "1.2.3"
      const isPreReleasePrefix = shorter.preRelease && shorter.parts.length < longer.parts.length
        && shorter.parts.every((p, i) => p === longer.parts[i]);
      if (!isPreReleasePrefix) {
        // Scheme mismatch: numeric comparison is meaningless.
        // Use catalog upload date vs local date-proxy as tiebreaker.
        // If no catalog date is available, assume equal (avoid false positives).
        if (!catalogDateEpoch) return 0;
        const catalogDateParts = parseVersionParts(dateToVersion(catalogDateEpoch)).parts;
        // local date-based version? compare directly
        if (va.isDate) {
          for (let i = 0; i < 3; i++) {
            const na = va.parts[i] ?? 0;
            const nb = catalogDateParts[i] ?? 0;
            if (na !== nb) return na - nb;
          }
          return 0;
        }
        // Otherwise we can't reliably compare — return 0 to avoid false positives.
        // The YAAM database version check catches real updates.
        return 0;
      }
    }
  }

  // Compare base numeric parts
  const maxLen = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const na = va.parts[i] ?? 0;
    const nb = vb.parts[i] ?? 0;
    if (na !== nb) return na - nb;
  }

  // If numeric parts are equal, pre-release < release
  if (va.preRelease && !vb.preRelease) return -1;
  if (!va.preRelease && vb.preRelease) return 1;

  // Both have pre-release tags – compare type then number
  if (va.preRelease && vb.preRelease) {
    const orderA = VERSION_PRE_RELEASE_ORDER[va.preRelease] ?? 99;
    const orderB = VERSION_PRE_RELEASE_ORDER[vb.preRelease] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    const preDiff = va.preReleaseNum - vb.preReleaseNum;
    if (preDiff !== 0) return preDiff;
  }

  // ── Suffix comparison (r, build, rev) ──
  // Suffix parts are compared only when both versions share the same suffix
  // keyword, or one has no suffix (no suffix < has suffix).
  // Different suffix keywords mean incompatible numbering → use catalog.
  if (va.suffix || vb.suffix) {
    if (va.suffix && vb.suffix && va.suffix !== vb.suffix) {
      // Different suffix types → can't compare reliably
      if (catalogDateEpoch) return -1; // catalog is authoritative
      return 0;
    }
    // Same suffix or one side has no suffix (no suffix = suffixParts [])
    // No suffix < has suffix (e.g. "2.0" < "2.0 r41")
    if (!va.suffix && vb.suffix) return -1;
    if (va.suffix && !vb.suffix) return 1;

    // Both have the same suffix → compare suffixParts
    const sfxMax = Math.max(va.suffixParts.length, vb.suffixParts.length);
    for (let i = 0; i < sfxMax; i++) {
      const sa2 = va.suffixParts[i] ?? 0;
      const sb2 = vb.suffixParts[i] ?? 0;
      if (sa2 !== sb2) return sa2 - sb2;
    }
  }

  // Tiebreaker: compare parenthesized sub-version parts (e.g. build numbers, dates)
  if (va.subParts.length > 0 || vb.subParts.length > 0) {
    const subMax = Math.max(va.subParts.length, vb.subParts.length);
    for (let i = 0; i < subMax; i++) {
      const sa2 = va.subParts[i] ?? 0;
      const sb2 = vb.subParts[i] ?? 0;
      if (sa2 !== sb2) return sa2 - sb2;
    }
  }

  // Tiebreaker: hotfix letter suffix (3.16.7 < 3.16.7a < 3.16.7b)
  if (va.letterRank !== vb.letterRank) return va.letterRank - vb.letterRank;

  return 0;
}

export interface AppConfig {
  addonPath: string;
  logHeight?: number;
  panelWidths?: number[];
  /** Whether the user has accepted the welcome/disclaimer dialog */
  welcomeAccepted?: boolean;
  /** UI font scale percentage (default 100) */
  fontScale?: number;
  /** UI font family (CSS value) */
  fontFamily?: string;
  /** Skip cleanup confirmation dialogs */
  skipCleanupConfirm?: boolean;
  /** Install all pending updates right after the start-up scan, without asking */
  autoUpdateOnStart?: boolean;
  /** Saved window bounds for restore on next launch */
  windowBounds?: { x: number; y: number; width: number; height: number; isMaximized?: boolean };
}

/** Character → enabled map used for per-addon enable/disable display */
export interface CharacterSettings {
  [character: string]: boolean;
}

/** Per-character addon enable/disable settings from AddOnSettings.txt */
export interface AddonSettingsData {
  /** Global metadata */
  version: number;
  acknowledgedOutOfDateVersion: number;
  addOnsEnabled: boolean;
  /** character name -> (addonFolderName -> enabled) */
  characters: Record<string, Record<string, boolean>>;
  /** Default settings (addonFolderName -> enabled) */
  defaults: Record<string, boolean>;
}

/** Information about SavedVariables files */
export interface SavedVarsInfo {
  /** addonFolderName -> list of .lua files in SavedVariables/ */
  addonFiles: Record<string, string[]>;
}

/** A single addon from the online catalog */
export interface CatalogAddon {
  id: string;
  categoryId: string;
  name: string;
  author: string;
  version: string;
  date: number;
  infoUrl: string;
  totalDownloads: number;
  monthlyDownloads: number;
  favorites: number;
  compatibility: { version: string; name: string }[];
  directories: string[];
  thumbnails: string[];
  images: string[];
  donationLink: string;
}

/** A category from the ESOUI API */
export interface CatalogCategory {
  id: string;
  name: string;
  fileCount: number;
  parentIds: string[];
}

/** Known addon category IDs and names */
export const ADDON_CATEGORIES: Record<string, string> = {
  '': 'All Categories',
  '17': 'Graphic UI Mods',
  '18': 'Character Advancement',
  '19': 'Action Bar Mods',
  '20': 'Bags, Bank & Inventory',
  '21': 'UI Mods',
  '22': 'Buff, Debuff & Spell',
  '24': 'Map & Minimap',
  '25': 'Combat Mods',
  '26': 'Info & Codex',
  '27': 'Miscellaneous',
  '33': 'Plug-Ins & Patches',
  '40': 'Tradeskill Mods',
  '45': 'Raid Mods',
  '53': 'Libraries',
  '55': 'Chat Mods',
  '56': 'Templar',
  '57': 'Dragon Knight',
  '58': 'Sorcerer',
  '94': 'Auction House & Vendors',
  '95': 'Group, Guild & Friends',
  '96': 'PvP',
  '97': 'Mail',
  '98': 'Tooltip',
  '109': 'Info, Plug-in Bars',
  '112': 'Casting Bars, Cooldowns',
  '114': 'Roleplay & Immersion',
  '147': 'Media & Fonts',
  '149': 'DPS',
  '150': 'Healers',
  '151': 'Tank',
  '152': 'Nightblade',
  '155': 'Beta-version AddOns',
  '159': 'Utility Mods',
  '160': 'Housing',
  '162': 'Game Controller',
  '163': 'Unofficial Game Translations',
  '165': 'Necromancer',
  '166': 'Arcanist',
};

/** Get the CDN icon URL for a category */
export function getCategoryIconUrl(categoryId: string): string {
  return `https://cdn-eso.mmoui.com/images/icons/m${categoryId}.jpg`;
}

/** IPC channel names */
export const IPC_CHANNELS = {
  GET_CONFIG: 'get-config',
  SET_ADDON_PATH: 'set-addon-path',
  SCAN_ADDONS: 'scan-addons',
  DETECT_CLOUD_SYNC: 'detect-cloud-sync',
  SELECT_FOLDER: 'select-folder',
  CLEANUP_UNUSED: 'cleanup-unused',
  DELETE_ADDON: 'delete-addon',
  DELETE_ADDON_AND_REFS: 'delete-addon-and-refs',
  FETCH_ADDON_CATALOG: 'fetch-addon-catalog',
  INSTALL_ADDON: 'install-addon',
  GET_ADDON_SETTINGS: 'get-addon-settings',
  SET_ADDON_SETTING: 'set-addon-setting',
  GET_SAVED_VARS_INFO: 'get-saved-vars-info',
  DELETE_SAVED_VARS: 'delete-saved-vars',
  CLEANUP_SETTINGS: 'cleanup-settings',
  CLEANUP_DOWNLOADS: 'cleanup-downloads',
  SAVE_UI_SETTINGS: 'save-ui-settings',
  ACCEPT_WELCOME: 'accept-welcome',

  INSTALL_PROGRESS: 'install-progress',
  UNDO_CLEANUP_SETTINGS: 'undo-cleanup-settings',
  QUIT_APP: 'quit-app',
  CHECK_UNSAVED: 'check-unsaved',
  BATCH_SET_ADDON_SETTINGS: 'batch-set-addon-settings',
  SHOW_UNSAVED_DIALOG: 'show-unsaved-dialog',
  UNSAVED_DIALOG_RESPONSE: 'unsaved-dialog-response',
  UNSAVED_RESPONSE: 'unsaved-response',
  SAVE_AND_QUIT: 'save-and-quit',
  SAVE_SNAPSHOT: 'save-snapshot',
  LIST_SNAPSHOTS: 'list-snapshots',
  LIST_ADDON_BACKUPS: 'list-addon-backups',
  RESTORE_ADDON_BACKUP: 'restore-addon-backup',
  BACKUP_ADDON_FOLDER: 'backup-addon-folder',
  LIST_SV_BACKUPS: 'list-sv-backups',
  RESTORE_SV_FILE: 'restore-sv-file',
  OPEN_IN_EXPLORER: 'open-in-explorer',
  EXPORT_PROFILE: 'export-profile',
  EXPORT_PROFILE_ZIP: 'export-profile-zip',
  IMPORT_PROFILE: 'import-profile',
  PREVIEW_PROFILE_ZIP: 'preview-profile-zip',
  IMPORT_PROFILE_ZIP: 'import-profile-zip',
  BATCH_INSTALL_ADDONS: 'batch-install-addons',
  OPEN_EXTERNAL_URL: 'open-external-url',
  GET_APP_VERSION: 'get-app-version',
  EXPORT_PROGRESS: 'export-progress',
  GET_SYSTEM_FONTS: 'get-system-fonts',
  PREVIEW_CLEANUP_LIBS: 'preview-cleanup-libs',
  PREVIEW_CLEANUP_SETTINGS: 'preview-cleanup-settings',
  PREVIEW_CLEANUP_DOWNLOADS: 'preview-cleanup-downloads',
  CLEANUP_LIBS_SELECTED: 'cleanup-libs-selected',
  CLEANUP_SETTINGS_SELECTED: 'cleanup-settings-selected',
  CLEANUP_DOWNLOADS_SELECTED: 'cleanup-downloads-selected',
  DELETE_ADDON_BACKUPS: 'delete-addon-backups',
  FETCH_ADDON_DETAILS: 'fetch-addon-details',
  FETCH_CATEGORIES: 'fetch-categories',
  RECONCILE_YAAM_META: 'reconcile-yaam-meta',
  GET_YAAM_DB: 'get-yaam-db',
  CLEANUP_YAAM_MARKERS: 'cleanup-yaam-markers',
  UPDATE_CATALOG_SNAPSHOT: 'update-catalog-snapshot',
  COMMIT_CATALOG_SNAPSHOT: 'commit-catalog-snapshot',
  COMMIT_BASELINE: 'commit-baseline',
  PREVIEW_FOLDER_HYGIENE: 'preview-folder-hygiene',
  APPLY_FOLDER_HYGIENE: 'apply-folder-hygiene',
  UNDO_FOLDER_HYGIENE: 'undo-folder-hygiene',
  RESTORE_TRACKING_STATE: 'restore-tracking-state',
  LIST_REMOVED: 'list-removed',
  RESTORE_REMOVED: 'restore-removed',
  MOVE_DOWNLOADS_BACK: 'move-downloads-back',
} as const;
