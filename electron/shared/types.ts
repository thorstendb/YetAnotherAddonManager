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
  /** PC-specific dependencies (already merged into dependsOn on PC) */
  pcDependsOn: DependencyRef[];
  /**
   * ALL SavedVariable names owned by this addon tree (self + all sub-addons).
   * Used for accurate cleanup to avoid destroying user settings.
   */
  allSavedVariableNames: string[];
  /** YAAM database entry for this addon (if present) */
  yaamMeta?: YaamAddonEntry;
  /** Files found in the addon folder that were NOT part of the original install (runtime-created) */
  runtimeFiles?: string[];
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
  /** Version string from the addon's local manifest (## Version) */
  localVersion: string;
  /** ISO timestamp of first install via YAAM */
  installedAt: string;
  /** ISO timestamp of last update via YAAM */
  updatedAt: string;
  /** Relative file paths from the original ZIP (install manifest for detecting runtime-created files) */
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

  // Extract all numeric groups (handles any separator: dots, hyphens, spaces,
  // slashes, 'r' prefixes, 'build' keyword, etc.)
  const nums = s.match(/\d+/g);
  let parts = nums ? nums.map(Number) : [0];

  // Normalise date-based versions so ISO / US / EU all compare correctly
  parts = normalizeDateParts(parts);
  // Detect whether this version looks like a date (3 segments with a plausible year)
  const isDate = parts.length === 3 && parts[0] >= 2000 && parts[1] >= 1 && parts[1] <= 12 && parts[2] >= 1 && parts[2] <= 31;

  return { parts, subParts, isDate, preRelease, preReleaseNum };
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

  // Compare numeric parts
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

  // Tiebreaker: compare parenthesized sub-version parts (e.g. build numbers, dates)
  if (va.subParts.length > 0 || vb.subParts.length > 0) {
    const subMax = Math.max(va.subParts.length, vb.subParts.length);
    for (let i = 0; i < subMax; i++) {
      const sa2 = va.subParts[i] ?? 0;
      const sb2 = vb.subParts[i] ?? 0;
      if (sa2 !== sb2) return sa2 - sb2;
    }
  }

  return 0;
}

export interface AppConfig {
  addonPath: string;
  logHeight?: number;
  panelWidths?: number[];
  /** Whether the user has accepted the welcome/disclaimer dialog */
  welcomeAccepted?: boolean;
  /** Catalog addon ID → UIVersion when last installed. Prevents false "update available" when
   *  the local manifest ## Version doesn't match the catalog UIVersion string. */
  installedCatalogVersions?: Record<string, string>;
  /** UI font size in pixels (default 14) */
  fontSize?: number;
  /** UI font family (CSS value) */
  fontFamily?: string;
  /** Skip cleanup confirmation dialogs */
  skipCleanupConfirm?: boolean;
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
  SAVE_INSTALLED_VERSIONS: 'save-installed-versions',
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
} as const;
