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
 * Parse a version string into numeric parts and optional pre-release tag.
 *
 * Supported formats (from real addons):
 *   1.2.3, 0.8.6         – standard semver
 *   2025.08.08            – date-based (YYYY.MM.DD)
 *   2025-12-01            – date-based with hyphens
 *   2.0 r41, 1.0 r7       – revision suffix
 *   3.0r4.6               – concatenated revision
 *   2.3.22 build 1442     – with build number
 *   v2.31                 – leading v prefix
 *   85, 104               – simple integer
 *   4.0.4.3.5             – extra-long
 *   1.0-alpha, 1.0-rc.2  – pre-release
 */
export function parseVersionParts(raw: string): {
  parts: number[];
  preRelease?: string;
  preReleaseNum: number;
} {
  let s = (raw || '').trim();

  // Strip leading 'v' or 'V'
  s = s.replace(/^v/i, '');

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
  // 'r' prefixes, 'build' keyword, etc.)
  const nums = s.match(/\d+/g);
  const parts = nums ? nums.map(Number) : [0];

  return { parts, preRelease, preReleaseNum };
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
 */
export function compareVersionStrings(a: string, b: string): number {
  const sa = (a || '').trim();
  const sb = (b || '').trim();
  if (sa === sb) return 0;
  // Empty version is always "oldest"
  if (!sa && !sb) return 0;
  if (!sa) return -1;
  if (!sb) return 1;

  const va = parseVersionParts(sa);
  const vb = parseVersionParts(sb);

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
    return va.preReleaseNum - vb.preReleaseNum;
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
  IMPORT_PROFILE: 'import-profile',
  BATCH_INSTALL_ADDONS: 'batch-install-addons',
  OPEN_EXTERNAL_URL: 'open-external-url',
  GET_APP_VERSION: 'get-app-version',
  EXPORT_PROGRESS: 'export-progress',
} as const;
