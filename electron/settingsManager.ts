// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { AddonSettingsData, SavedVarsInfo } from './shared/types';
import { writeFileAtomic } from './shared/atomicWrite';

/**
 * Resolve the "live" directory from an AddOns path.
 * AddOns path is typically: .../Elder Scrolls Online/live/AddOns
 * We need the parent of AddOns.
 */
function getLiveDir(addonsPath: string): string {
  return path.dirname(addonsPath);
}

function getSettingsPath(addonsPath: string): string {
  return path.join(getLiveDir(addonsPath), 'AddOnSettings.txt');
}

function getSavedVarsDir(addonsPath: string): string {
  return path.join(getLiveDir(addonsPath), 'SavedVariables');
}

function getBackupDir(addonsPath: string, subDir: string): string {
  const dir = path.join(getLiveDir(addonsPath), 'YAAM', 'Backup', subDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a timestamped backup of a file.
 * Saves into the centralized Backup/ folder structure.
 */
function backupFile(filePath: string, backupDir: string): string {
  if (!fs.existsSync(filePath)) return '';
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupPath = path.join(backupDir, `${base}_backup_${ts}${ext}`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Parse AddOnSettings.txt
 *
 * Format:
 *   #Version 101048
 *   #AcknowledgedOutOfDateAddonsVersion 101048
 *   #AddOnsEnabled 1
 *   #Default
 *   AddonName 0
 *   AddonName2 1
 *   #EU Megaserver-CharacterName
 *   AddonName 1
 *   ...
 */
export function parseAddonSettings(addonsPath: string): AddonSettingsData {
  const settingsPath = getSettingsPath(addonsPath);
  const result: AddonSettingsData = {
    version: 0,
    acknowledgedOutOfDateVersion: 0,
    addOnsEnabled: true,
    characters: {},
    defaults: {},
  };

  if (!fs.existsSync(settingsPath)) {
    return result;
  }

  const content = fs.readFileSync(settingsPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      // Section header or metadata
      const versionMatch = trimmed.match(/^#Version\s+(\d+)$/);
      if (versionMatch) {
        result.version = parseInt(versionMatch[1], 10);
        continue;
      }
      const ackMatch = trimmed.match(/^#AcknowledgedOutOfDateAddonsVersion\s+(\d+)$/);
      if (ackMatch) {
        result.acknowledgedOutOfDateVersion = parseInt(ackMatch[1], 10);
        continue;
      }
      const enabledMatch = trimmed.match(/^#AddOnsEnabled\s+(\d+)$/);
      if (enabledMatch) {
        result.addOnsEnabled = enabledMatch[1] === '1';
        continue;
      }
      if (trimmed === '#Default') {
        currentSection = '#Default';
        continue;
      }
      // Character section: #ServerName-CharacterName
      const charName = trimmed.substring(1); // remove #
      currentSection = charName;
      if (!result.characters[charName]) {
        result.characters[charName] = {};
      }
      continue;
    }

    // Data line: "AddonName 0" or "AddonName 1"
    const dataMatch = trimmed.match(/^(\S+)\s+(\d+)$/);
    if (dataMatch && currentSection) {
      const addonName = dataMatch[1];
      const enabled = dataMatch[2] === '1';

      if (currentSection === '#Default') {
        result.defaults[addonName] = enabled;
      } else {
        if (!result.characters[currentSection]) {
          result.characters[currentSection] = {};
        }
        result.characters[currentSection][addonName] = enabled;
      }
    }
  }

  // Supplement character list from SavedVariables $LastCharacterName entries.
  // AddOnSettings.txt may only contain chars that changed addon settings, but
  // SavedVariables contain data for every character that has logged in.
  enrichCharactersFromSavedVars(addonsPath, result);

  return result;
}

/**
 * Scan SavedVariables .lua files for ["$LastCharacterName"] = "Name" entries
 * and add any missing characters to the settings data.
 */
function enrichCharactersFromSavedVars(addonsPath: string, settings: AddonSettingsData): void {
  const svDir = getSavedVarsDir(addonsPath);
  if (!fs.existsSync(svDir)) return;

  // Determine the server prefix from existing characters (e.g. "EU Megaserver")
  const existingKeys = Object.keys(settings.characters);
  let serverPrefix = '';
  for (const key of existingKeys) {
    const dashIdx = key.lastIndexOf('-');
    if (dashIdx > 0) {
      serverPrefix = key.substring(0, dashIdx);
      break;
    }
  }

  // Collect known character names (just the name part after the dash)
  const knownNames = new Set<string>();
  for (const key of existingKeys) {
    const dashIdx = key.lastIndexOf('-');
    if (dashIdx > 0) {
      knownNames.add(key.substring(dashIdx + 1));
    }
  }

  // Scan SavedVariables files for $LastCharacterName (stop early when possible)
  const charNameRe = /\["\$LastCharacterName"\]\s*=\s*"([^"]+)"/g;
  const discoveredNames = new Set<string>();

  const files = fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'));
  let staleCount = 0;
  for (const file of files) {
    const sizeBefore = discoveredNames.size;
    const filePath = path.join(svDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    charNameRe.lastIndex = 0;
    while ((match = charNameRe.exec(content)) !== null) {
      discoveredNames.add(match[1]);
    }
    // Stop early if no new names found in 5 consecutive files
    staleCount = discoveredNames.size > sizeBefore ? 0 : staleCount + 1;
    if (staleCount >= 5 && discoveredNames.size > 0) break;
  }

  // Add missing characters
  for (const name of discoveredNames) {
    if (knownNames.has(name)) continue;
    // If we couldn't determine server prefix, try to build one from the SV data
    if (!serverPrefix) {
      // Fall back: look for server info in SV keys like ["EU Megaserver"]
      // Without a prefix we cannot construct the proper key, so skip
      continue;
    }
    const key = `${serverPrefix}-${name}`;
    if (!settings.characters[key]) {
      settings.characters[key] = {};
    }
  }
}

/**
 * Update a single addon's enabled state for a specific character.
 * Creates a backup before modifying.
 */
export function setAddonSetting(
  addonsPath: string,
  character: string,
  addonName: string,
  enabled: boolean
): { backupPath: string } {
  const settingsPath = getSettingsPath(addonsPath);
  if (!fs.existsSync(settingsPath)) {
    throw new Error('AddOnSettings.txt not found');
  }

  const backupPath = backupFile(settingsPath, getBackupDir(addonsPath, 'AddOnSettings'));

  const content = fs.readFileSync(settingsPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const newLines: string[] = [];
  let currentSection: string | null = null;
  let found = false;

  const sectionHeader = character === '#Default' ? '#Default' : `#${character}`;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#')) {
      // Check if we're leaving the target section without finding the addon
      if (currentSection === sectionHeader && !found) {
        // Insert the addon entry before the new section header
        newLines.push(`${addonName} ${enabled ? '1' : '0'}`);
        found = true;
      }

      if (trimmed === '#Default') {
        currentSection = '#Default';
      } else if (trimmed.startsWith('#Version') || trimmed.startsWith('#Acknowledged') || trimmed.startsWith('#AddOnsEnabled')) {
        // metadata line, don't change current section
      } else {
        currentSection = `#${trimmed.substring(1)}`;
      }
      newLines.push(line);
      continue;
    }

    const dataMatch = trimmed.match(/^(\S+)\s+(\d+)$/);
    if (dataMatch && currentSection === sectionHeader && dataMatch[1] === addonName) {
      newLines.push(`${addonName} ${enabled ? '1' : '0'}`);
      found = true;
    } else {
      newLines.push(line);
    }
  }

  // If we reached end of file while still in the target section
  if (!found && currentSection === sectionHeader) {
    newLines.push(`${addonName} ${enabled ? '1' : '0'}`);
  }

  writeFileAtomic(settingsPath, newLines.join('\r\n'));
  return { backupPath };
}

/**
 * Batch-update multiple addon settings in a single read-modify-write cycle.
 * Creates exactly ONE backup before any changes.
 * Each entry is { character, addonName, enabled }.
 *
 * After writing, verifies the result by reading the file back and comparing
 * byte-length to guard against truncation / write failures.
 */
export function batchSetAddonSettings(
  addonsPath: string,
  changes: { character: string; addonName: string; enabled: boolean }[]
): { backupPath: string; applied: number; skipped: string[]; error?: string } {
  const settingsPath = getSettingsPath(addonsPath);
  if (!fs.existsSync(settingsPath)) {
    throw new Error('AddOnSettings.txt not found');
  }
  if (changes.length === 0) return { backupPath: '', applied: 0, skipped: [] };

  const backupPath = backupFile(settingsPath, getBackupDir(addonsPath, 'AddOnSettings'));

  let content = fs.readFileSync(settingsPath, 'utf-8');
  let lines = content.split(/\r?\n/);

  let applied = 0;
  // Changes whose character section does not exist in the file — counting them
  // as applied would report a success the game never sees
  const skipped: string[] = [];

  for (const { character, addonName, enabled } of changes) {
    const sectionHeader = character === '#Default' ? '#Default' : `#${character}`;
    const newLines: string[] = [];
    let currentSection: string | null = null;
    let found = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('#')) {
        if (currentSection === sectionHeader && !found) {
          newLines.push(`${addonName} ${enabled ? '1' : '0'}`);
          found = true;
        }

        if (trimmed === '#Default') {
          currentSection = '#Default';
        } else if (trimmed.startsWith('#Version') || trimmed.startsWith('#Acknowledged') || trimmed.startsWith('#AddOnsEnabled')) {
          // metadata line
        } else {
          currentSection = `#${trimmed.substring(1)}`;
        }
        newLines.push(line);
        continue;
      }

      const dataMatch = trimmed.match(/^(\S+)\s+(\d+)$/);
      if (dataMatch && currentSection === sectionHeader && dataMatch[1] === addonName) {
        newLines.push(`${addonName} ${enabled ? '1' : '0'}`);
        found = true;
      } else {
        newLines.push(line);
      }
    }

    if (!found && currentSection === sectionHeader) {
      // Target section is the last one in the file — append at the end
      newLines.push(`${addonName} ${enabled ? '1' : '0'}`);
      found = true;
    }

    lines = newLines;
    if (found) applied++;
    else skipped.push(`${character}/${addonName}`);
  }

  const output = lines.join('\r\n');
  writeFileAtomic(settingsPath, output);

  // Verify: re-read and check the written content matches
  const verification = fs.readFileSync(settingsPath, 'utf-8');
  if (verification.length !== output.length) {
    // Restore from backup
    fs.copyFileSync(backupPath, settingsPath);
    return { backupPath, applied: 0, skipped, error: 'Write verification failed – backup restored' };
  }

  return { backupPath, applied, skipped };
}

/**
 * Scan SavedVariables directory to find which addons have saved data.
 * Returns a mapping from addon folder name to list of .lua files.
 *
 * SavedVariables files are named after the ## SavedVariables value
 * in the addon manifest, e.g. "PersonalAssistant_SavedVariables.lua".
 *
 * We use the addon folder names AND their declared SavedVariables
 * to build precise matches rather than loose prefix matching,
 * which prevents misattribution (e.g. "PersonalAssistantBanking_SavedVariables"
 * should NOT match parent "PersonalAssistant").
 */
export function getSavedVarsInfo(addonsPath: string, addonFolderNames: string[]): SavedVarsInfo {
  const svDir = getSavedVarsDir(addonsPath);
  const result: SavedVarsInfo = { addonFiles: {} };

  if (!fs.existsSync(svDir)) return result;

  const files = fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'));

  // Build a set of known addon names for matching
  const nameSet = new Set(addonFolderNames);

  // Pre-sort addon names by length descending (longest match first)
  // so "PersonalAssistantBanking" matches before "PersonalAssistant".
  const sortedNames = [...addonFolderNames].sort((a, b) => b.length - a.length);

  for (const file of files) {
    const baseName = file.replace(/\.lua$/, '');

    // Skip ZO_ prefixed files (built-in game variables)
    if (baseName.startsWith('ZO_')) continue;

    // Try exact match first (file base name matches addon folder name)
    if (nameSet.has(baseName)) {
      if (!result.addonFiles[baseName]) result.addonFiles[baseName] = [];
      result.addonFiles[baseName].push(file);
      continue;
    }

    // Try prefix match (longest match first to avoid misattribution)
    let matched = false;
    for (const name of sortedNames) {
      if (baseName.startsWith(name)) {
        if (!result.addonFiles[name]) result.addonFiles[name] = [];
        result.addonFiles[name].push(file);
        matched = true;
        break;
      }
    }

    // If no prefix match, the file may belong to a sub-addon not in
    // the top-level folder list. We leave it unmatched rather than
    // incorrectly attributing it.
    if (!matched) {
      // Store under a special key for orphaned files
      // (frontend can display these separately)
    }
  }

  return result;
}

/**
 * Delete saved variable files for a specific addon.
 * Creates a backup before removing.
 */
export function deleteSavedVars(
  addonsPath: string,
  addonName: string
): { deleted: string[]; backupDir: string } {
  const svDir = getSavedVarsDir(addonsPath);
  const deleted: string[] = [];

  if (!fs.existsSync(svDir)) return { deleted, backupDir: '' };

  // Create backup directory
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupDir = path.join(getBackupDir(addonsPath, 'SavedVariables'), `_backup_${ts}`);

  const files = fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'));

  for (const file of files) {
    const baseName = file.replace(/\.lua$/, '');
    // Exact match or underscore-separated prefix (e.g. "Addon_SavedVars")
    // avoids matching "AddonBanking" when deleting "Addon"
    if (baseName === addonName || baseName.startsWith(addonName + '_')) {
      // Create backup dir only if we actually have files to back up
      if (deleted.length === 0) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      const src = path.join(svDir, file);
      const dest = path.join(backupDir, file);
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      deleted.push(file);
    }
  }

  return { deleted, backupDir: deleted.length > 0 ? backupDir : '' };
}

/**
 * Remove entries from AddOnSettings.txt for addons that no longer exist.
 */
export function previewCleanupSettings(
  addonsPath: string,
  existingAddonNames: string[]
): { orphanedSettings: string[]; orphanedSavedVars: string[] } {
  const existingSet = new Set(existingAddonNames);
  const settingsPath = getSettingsPath(addonsPath);
  const orphanedSettings: string[] = [];
  const orphanedSavedVars: string[] = [];

  // Preview orphaned settings
  if (fs.existsSync(settingsPath)) {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const seen = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      const dataMatch = trimmed.match(/^(\S+)\s+\d+$/);
      if (dataMatch) {
        const addonName = dataMatch[1];
        if (!existingSet.has(addonName) && !addonName.startsWith('ZO_') && !seen.has(addonName)) {
          seen.add(addonName);
          orphanedSettings.push(addonName);
        }
      }
    }
  }

  // Preview orphaned SavedVariables
  const svDir = getSavedVarsDir(addonsPath);
  if (fs.existsSync(svDir)) {
    const files = fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'));
    const sortedNames = [...existingAddonNames].sort((a, b) => b.length - a.length);
    for (const file of files) {
      const baseName = file.replace(/\.lua$/, '');
      const hasMatch = baseName.startsWith('ZO_') ||
        existingSet.has(baseName) ||
        sortedNames.some((name) => baseName.startsWith(name));
      if (!hasMatch) {
        orphanedSavedVars.push(file);
      }
    }
  }

  return { orphanedSettings: orphanedSettings.sort(), orphanedSavedVars: orphanedSavedVars.sort() };
}

export function cleanupSettingsSelected(
  addonsPath: string,
  existingAddonNames: string[],
  settingsToRemove: string[],
  savedVarsToRemove: string[]
): { removedFromSettings: string[]; removedSavedVars: string[]; backupPath: string; svBackupDir: string } {
  const settingsPath = getSettingsPath(addonsPath);
  const removedFromSettings: string[] = [];
  const removedSavedVars: string[] = [];
  let backupPath = '';
  let svBackupDir = '';
  const settingsSet = new Set(settingsToRemove);
  const svSet = new Set(savedVarsToRemove);

  // Cleanup AddOnSettings.txt — only remove selected entries
  if (settingsSet.size > 0 && fs.existsSync(settingsPath)) {
    backupPath = backupFile(settingsPath, getBackupDir(addonsPath, 'AddOnSettings'));
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const newLines: string[] = [];
    const removedSet = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') {
        newLines.push(line);
        continue;
      }
      const dataMatch = trimmed.match(/^(\S+)\s+\d+$/);
      if (dataMatch) {
        const addonName = dataMatch[1];
        if (settingsSet.has(addonName)) {
          if (!removedSet.has(addonName)) {
            removedSet.add(addonName);
            removedFromSettings.push(addonName);
          }
        } else {
          newLines.push(line);
        }
      } else {
        newLines.push(line);
      }
    }
    writeFileAtomic(settingsPath, newLines.join('\r\n'));
  }

  // Cleanup selected SavedVariables
  if (svSet.size > 0) {
    const svDir = getSavedVarsDir(addonsPath);
    if (fs.existsSync(svDir)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const bkDir = path.join(getBackupDir(addonsPath, 'SavedVariables'), `_cleanup_backup_${ts}`);
      let backupCreated = false;

      for (const file of svSet) {
        const src = path.join(svDir, file);
        if (fs.existsSync(src)) {
          if (!backupCreated) {
            fs.mkdirSync(bkDir, { recursive: true });
            backupCreated = true;
          }
          fs.copyFileSync(src, path.join(bkDir, file));
          fs.unlinkSync(src);
          removedSavedVars.push(file);
        }
      }
      if (backupCreated) svBackupDir = bkDir;
    }
  }

  return { removedFromSettings, removedSavedVars, backupPath, svBackupDir };
}

/**
 * Also remove SavedVariables files for non-existent addons.
 * Creates a backup before modifying.
 */
export function cleanupSettings(
  addonsPath: string,
  existingAddonNames: string[]
): { removedFromSettings: string[]; removedSavedVars: string[]; backupPath: string; svBackupDir: string } {
  const existingSet = new Set(existingAddonNames);
  const settingsPath = getSettingsPath(addonsPath);
  const removedFromSettings: string[] = [];
  const removedSavedVars: string[] = [];
  let backupPath = '';
  let svBackupDir = '';

  // Cleanup AddOnSettings.txt
  if (fs.existsSync(settingsPath)) {
    backupPath = backupFile(settingsPath, getBackupDir(addonsPath, 'AddOnSettings'));

    const content = fs.readFileSync(settingsPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const newLines: string[] = [];
    const removedSet = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('#') || trimmed === '') {
        newLines.push(line);
        continue;
      }

      const dataMatch = trimmed.match(/^(\S+)\s+\d+$/);
      if (dataMatch) {
        const addonName = dataMatch[1];
        if (existingSet.has(addonName) || addonName.startsWith('ZO_')) {
          newLines.push(line);
        } else {
          if (!removedSet.has(addonName)) {
            removedSet.add(addonName);
            removedFromSettings.push(addonName);
          }
          // Skip this line (remove it)
        }
      } else {
        newLines.push(line);
      }
    }

    writeFileAtomic(settingsPath, newLines.join('\r\n'));
  }

  // Cleanup orphaned SavedVariables
  // IMPORTANT: Match files against both addon folder names AND
  // their declared SavedVariable names to avoid destroying user settings
  // for sub-addons like PersonalAssistantBanking, CombatMetricsFightData, etc.
  const svDir = getSavedVarsDir(addonsPath);
  if (fs.existsSync(svDir)) {
    const files = fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'));
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const backupDir = path.join(getBackupDir(addonsPath, 'SavedVariables'), `_cleanup_backup_${ts}`);
    let backupCreated = false;

    // Sort by length descending for proper prefix matching
    const sortedNames = [...existingAddonNames].sort((a, b) => b.length - a.length);

    for (const file of files) {
      const baseName = file.replace(/\.lua$/, '');
      // Check if any existing addon matches this file
    // Always keep ZO_ prefixed files (built-in game variables)
      const hasMatch = baseName.startsWith('ZO_') ||
        existingSet.has(baseName) ||
        sortedNames.some((name) => baseName.startsWith(name));
      if (!hasMatch) {
        if (!backupCreated) {
          fs.mkdirSync(backupDir, { recursive: true });
          backupCreated = true;
        }
        const src = path.join(svDir, file);
        const dest = path.join(backupDir, file);
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
        removedSavedVars.push(file);
      }
    }
    if (backupCreated) svBackupDir = backupDir;
  }

  return { removedFromSettings, removedSavedVars, backupPath, svBackupDir };
}

/**
 * Undo a previous cleanupSettings operation by restoring backups.
 * - Restores AddOnSettings.txt from the backup file
 * - Moves SavedVariables .lua files back from the backup directory
 */
export function undoCleanupSettings(
  addonsPath: string,
  settingsBackupPath: string,
  svBackupDir: string
): { restoredSettings: boolean; restoredSavedVars: string[]; error?: string } {
  const restoredSavedVars: string[] = [];
  let restoredSettings = false;

  try {
    // Restore AddOnSettings.txt
    if (settingsBackupPath && fs.existsSync(settingsBackupPath)) {
      const settingsPath = getSettingsPath(addonsPath);
      fs.copyFileSync(settingsBackupPath, settingsPath);
      restoredSettings = true;
    }

    // Restore SavedVariables files
    if (svBackupDir && fs.existsSync(svBackupDir)) {
      const svDir = getSavedVarsDir(addonsPath);
      const files = fs.readdirSync(svBackupDir).filter((f) => f.endsWith('.lua'));
      for (const file of files) {
        const src = path.join(svBackupDir, file);
        const dest = path.join(svDir, file);
        fs.copyFileSync(src, dest);
        restoredSavedVars.push(file);
      }
      // Remove backup dir after successful restore
      fs.rmSync(svBackupDir, { recursive: true, force: true });
    }

    return { restoredSettings, restoredSavedVars };
  } catch (err: unknown) {
    return { restoredSettings, restoredSavedVars, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A single SavedVariables backup entry */
export interface SvBackupEntry {
  /** Original .lua filename */
  fileName: string;
  /** Backup subdirectory name (e.g. "_backup_2024-03-09_14-25-33") */
  backupDirName: string;
  /** Full path to the backed-up file */
  backupFilePath: string;
  /** Type of backup: manual delete or cleanup */
  type: 'backup' | 'cleanup';
  /** ISO timestamp parsed from directory name */
  timestamp: string;
}

/**
 * List all SavedVariables backup files across all backup subdirectories.
 */
export function listSavedVarsBackups(addonsPath: string): SvBackupEntry[] {
  const backupRoot = getBackupDir(addonsPath, 'SavedVariables');
  if (!fs.existsSync(backupRoot)) return [];

  const entries: SvBackupEntry[] = [];
  const dirs = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const dir of dirs) {
    // Parse type and timestamp from dir name: "_backup_YYYY-MM-DD_HH-mm-ss" or "_cleanup_backup_..."
    const isCleanup = dir.name.startsWith('_cleanup_backup_');
    const tsMatch = dir.name.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})$/);
    const timestamp = tsMatch
      ? tsMatch[1].replace('_', 'T').replace(/-/g, (m, offset: number) => offset > 4 && offset < 10 ? '-' : offset > 12 ? ':' : m) 
      : dir.name;

    // Parse "YYYY-MM-DD_HH-mm-ss" → ISO
    let isoTimestamp = dir.name;
    if (tsMatch) {
      const parts = tsMatch[1].split('_');
      isoTimestamp = parts[0] + 'T' + parts[1].replace(/-/g, ':');
    }

    const dirPath = path.join(backupRoot, dir.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.lua'));

    for (const file of files) {
      entries.push({
        fileName: file,
        backupDirName: dir.name,
        backupFilePath: path.join(dirPath, file),
        type: isCleanup ? 'cleanup' : 'backup',
        timestamp: isoTimestamp,
      });
    }
  }

  // Sort newest first
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Restore a single SavedVariables .lua file from a backup back to the SavedVariables directory.
 * Does NOT delete the backup file (preserves it for future use).
 */
export function restoreSavedVarsFile(
  addonsPath: string,
  backupFilePath: string
): { restored: boolean; fileName: string; error?: string } {
  try {
    if (!fs.existsSync(backupFilePath)) {
      return { restored: false, fileName: '', error: 'Backup file not found' };
    }

    const fileName = path.basename(backupFilePath);
    const svDir = getSavedVarsDir(addonsPath);
    fs.mkdirSync(svDir, { recursive: true });

    const dest = path.join(svDir, fileName);
    fs.copyFileSync(backupFilePath, dest);

    return { restored: true, fileName };
  } catch (err: unknown) {
    return { restored: false, fileName: path.basename(backupFilePath), error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Import / Export ───

/** Shape of the export JSON file */
export interface ExportData {
  /** Format version for future compatibility */
  formatVersion: 1;
  /** ISO timestamp when export was created */
  exportedAt: string;
  /** Addons: folderName → catalog ID (if known) */
  addons: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[];
  /** Full content of AddOnSettings.txt */
  addonSettings: string | null;
  /** Game settings: UserSettings.txt content */
  userSettings: string | null;

  /** SavedVariables: filename → base64-encoded content */
  savedVariables: Record<string, string>;
  /** Non-catalog addon folders bundled as base64-encoded zip per folder */
  bundledAddons?: Record<string, string>;
}

/**
 * Export all addon references, settings, and saved variables
 * into a single self-contained JSON object.
 * @param bundleFolders  Folder names of non-catalog addons to zip and embed in the export.
 */
export function exportProfile(
  addonsPath: string,
  addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
  bundleFolders?: string[],
  onProgress?: (phase: string, percent: number) => void,
  runtimeFilesMap?: Record<string, string[]>
): ExportData {
  const liveDir = getLiveDir(addonsPath);

  onProgress?.('Reading settings…', 10);

  // AddOnSettings.txt
  const settingsPath = getSettingsPath(addonsPath);
  let addonSettings = fs.existsSync(settingsPath)
    ? fs.readFileSync(settingsPath, 'utf-8')
    : null;

  // Clean up orphaned entries: remove lines referencing addons not in the export list.
  // This keeps the exported AddOnSettings.txt consistent with the addons being exported.
  if (addonSettings) {
    const exportedNames = new Set(addonList.map((a) => a.folderName));
    const lines = addonSettings.split(/\r?\n/);
    const filtered: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') {
        filtered.push(line);
        continue;
      }
      const m = trimmed.match(/^(\S+)\s+\d+$/);
      if (m) {
        const name = m[1];
        if (exportedNames.has(name) || name.startsWith('ZO_')) {
          filtered.push(line);
        }
      } else {
        filtered.push(line);
      }
    }
    addonSettings = filtered.join('\r\n');
  }

  // UserSettings.txt (game graphics/audio/keybinds etc.)
  const userSettingsPath = path.join(liveDir, 'UserSettings.txt');
  const userSettings = fs.existsSync(userSettingsPath)
    ? fs.readFileSync(userSettingsPath, 'utf-8')
    : null;

  onProgress?.('Reading SavedVariables…', 20);

  // SavedVariables – each .lua file base64-encoded
  const savedVariables: Record<string, string> = {};
  const svDir = getSavedVarsDir(addonsPath);
  if (fs.existsSync(svDir)) {
    const files = fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const content = fs.readFileSync(path.join(svDir, file));
      savedVariables[file] = content.toString('base64');
      onProgress?.(`Reading SavedVariables… (${i + 1}/${files.length})`, 20 + Math.round(((i + 1) / files.length) * 50));
    }
  }

  // Bundle non-catalog addon folders as base64-encoded zips
  const bundledAddons: Record<string, string> = {};
  if (bundleFolders && bundleFolders.length > 0) {
    for (let i = 0; i < bundleFolders.length; i++) {
      const folder = bundleFolders[i];
      const folderPath = path.join(addonsPath, folder);
      onProgress?.(`Bundling ${folder}… (${i + 1}/${bundleFolders.length})`, 70 + Math.round(((i + 1) / bundleFolders.length) * 20));
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue;
      // Validate folder name to prevent path traversal
      const resolvedExport = path.resolve(addonsPath, folder);
      if (!resolvedExport.startsWith(addonsPath + path.sep) || folder.includes('..')) continue;
      try {
        const zip = new AdmZip();
        zip.addLocalFolder(folderPath, folder);
        const zipBuffer = zip.toBuffer();
        bundledAddons[folder] = zipBuffer.toString('base64');
      } catch {
        // Skip folders that can't be zipped
      }
    }
  }

  onProgress?.('Finalizing…', 95);

  // Bundle runtime-created files (addon data, caches) as base64 per-folder
  const runtimeData: Record<string, Record<string, string>> = {};
  if (runtimeFilesMap) {
    for (const [folder, files] of Object.entries(runtimeFilesMap)) {
      const folderPath = path.join(addonsPath, folder);
      const resolvedPath = path.resolve(addonsPath, folder);
      if (!resolvedPath.startsWith(addonsPath + path.sep) || folder.includes('..')) continue;
      const folderData: Record<string, string> = {};
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        const resolvedFile = path.resolve(folderPath, file);
        if (!resolvedFile.startsWith(folderPath + path.sep) || file.includes('..')) continue;
        try {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            folderData[file] = fs.readFileSync(filePath).toString('base64');
          }
        } catch { /* skip unreadable */ }
      }
      if (Object.keys(folderData).length > 0) {
        runtimeData[folder] = folderData;
      }
    }
  }

  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    addons: addonList,
    addonSettings,
    userSettings,
    savedVariables,
    ...(Object.keys(bundledAddons).length > 0 ? { bundledAddons } : {}),
    ...(Object.keys(runtimeData).length > 0 ? { runtimeData } : {}),
  };
}

/**
 * Import a profile: restore settings files and return the list of addons to install.
 * Does NOT install addons — the caller is responsible for that to provide progress events.
 * Creates backups of all files before overwriting.
 */
export function importProfile(
  addonsPath: string,
  data: ExportData
): { addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; restoredBundles: string[]; errors: string[] } {
  const liveDir = getLiveDir(addonsPath);
  const restoredSettings: string[] = [];
  const restoredBundles: string[] = [];
  const errors: string[] = [];

  // Restore AddOnSettings.txt
  if (data.addonSettings) {
    try {
      const settingsPath = getSettingsPath(addonsPath);
      // Preserve the current game API version and acknowledged version
      // so the game's "Allow out of date addons" dialog works correctly.
      let currentVersion = 0;
      let currentAckVersion = 0;
      if (fs.existsSync(settingsPath)) {
        backupFile(settingsPath, getBackupDir(addonsPath, 'AddOnSettings'));
        const existing = fs.readFileSync(settingsPath, 'utf-8');
        const vMatch = existing.match(/^#Version\s+(\d+)$/m);
        const aMatch = existing.match(/^#AcknowledgedOutOfDateAddonsVersion\s+(\d+)$/m);
        if (vMatch) currentVersion = parseInt(vMatch[1], 10);
        if (aMatch) currentAckVersion = parseInt(aMatch[1], 10);
      }

      let settingsContent = data.addonSettings;

      // Always preserve the target machine's API version and acknowledged version.
      // These values are determined by the installed game, not by the addon profile.
      if (currentVersion > 0) {
        settingsContent = settingsContent
          .replace(/^#Version\s+\d+$/m, `#Version ${currentVersion}`)
          .replace(/^#AcknowledgedOutOfDateAddonsVersion\s+\d+$/m, `#AcknowledgedOutOfDateAddonsVersion ${Math.max(currentVersion, currentAckVersion)}`);
      }

      // Ensure the master addon toggle is enabled
      settingsContent = settingsContent.replace(/^#AddOnsEnabled\s+0$/m, '#AddOnsEnabled 1');

      writeFileAtomic(settingsPath, settingsContent);
      restoredSettings.push('AddOnSettings.txt');
    } catch (err: unknown) {
      errors.push(`AddOnSettings.txt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Restore UserSettings.txt
  if (data.userSettings) {
    try {
      const userSettingsPath = path.join(liveDir, 'UserSettings.txt');
      if (fs.existsSync(userSettingsPath)) {
        backupFile(userSettingsPath, getBackupDir(addonsPath, 'UserSettings'));
      }
      writeFileAtomic(userSettingsPath, data.userSettings);
      restoredSettings.push('UserSettings.txt');
    } catch (err: unknown) {
      errors.push(`UserSettings.txt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Restore SavedVariables
  const svDir = getSavedVarsDir(addonsPath);
  fs.mkdirSync(svDir, { recursive: true });
  if (data.savedVariables) {
    // Backup existing SV files first
    const existingSvFiles = fs.existsSync(svDir)
      ? fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'))
      : [];
    if (existingSvFiles.length > 0) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const svBackupDir = path.join(getBackupDir(addonsPath, 'SavedVariables'), `_import_backup_${ts}`);
      fs.mkdirSync(svBackupDir, { recursive: true });
      for (const file of existingSvFiles) {
        try {
          fs.copyFileSync(path.join(svDir, file), path.join(svBackupDir, file));
        } catch (err) {
          errors.push(`Backup ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    for (const [fileName, base64Content] of Object.entries(data.savedVariables)) {
      // Validate filename to prevent path traversal
      const resolvedSv = path.resolve(svDir, fileName);
      if (!resolvedSv.startsWith(svDir + path.sep) || fileName.includes('..')) {
        errors.push(`Skipped unsafe filename: ${fileName}`);
        continue;
      }
      try {
        const buffer = Buffer.from(base64Content, 'base64');
        writeFileAtomic(path.join(svDir, fileName), buffer);
        restoredSettings.push(`SavedVariables/${fileName}`);
      } catch (err: unknown) {
        errors.push(`SavedVariables/${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Restore bundled (non-catalog) addons from base64-encoded zips
  if (data.bundledAddons) {
    for (const [folderName, base64Zip] of Object.entries(data.bundledAddons)) {
      // Validate folder name to prevent path traversal
      const resolvedBundle = path.resolve(addonsPath, folderName);
      if (!resolvedBundle.startsWith(addonsPath + path.sep) || folderName.includes('..')) {
        errors.push(`Skipped unsafe bundled addon folder: ${folderName}`);
        continue;
      }
      try {
        const zipBuffer = Buffer.from(base64Zip, 'base64');
        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(addonsPath, true);
        restoredBundles.push(folderName);
      } catch (err: unknown) {
        errors.push(`Bundled addon ${folderName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Restore runtime-created files (addon data, caches) from base64
  if (data.runtimeData) {
    for (const [folderName, files] of Object.entries(data.runtimeData as Record<string, Record<string, string>>)) {
      const folderPath = path.join(addonsPath, folderName);
      const resolvedFolder = path.resolve(addonsPath, folderName);
      if (!resolvedFolder.startsWith(addonsPath + path.sep) || folderName.includes('..')) continue;
      for (const [relFile, base64Content] of Object.entries(files)) {
        const destPath = path.join(folderPath, relFile);
        const resolvedDest = path.resolve(folderPath, relFile);
        if (!resolvedDest.startsWith(folderPath + path.sep) || relFile.includes('..')) continue;
        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          writeFileAtomic(destPath, Buffer.from(base64Content, 'base64'));
        } catch (err: unknown) {
          errors.push(`Runtime data ${folderName}/${relFile}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      restoredSettings.push(`Runtime data: ${folderName} (${Object.keys(files).length} file(s))`);
    }
  }

  // Determine which addons need to be installed
  const existingDirs = new Set(
    fs.readdirSync(addonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  );

  const addonsToInstall = data.addons.filter((a) => !existingDirs.has(a.folderName));

  return { addonsToInstall, restoredSettings, restoredBundles, errors };
}

/**
 * Export profile as a ZIP archive.
 * Contains profile.json + AddOns/<folder>/... + SavedVariables/*.lua
 * This is a full portable archive of all addon folders and saved data.
 */
export function exportProfileAsZip(
  addonsPath: string,
  addonList: { folderName: string; catalogId?: string; version: string; isLibrary: boolean }[],
  _bundleFolders?: string[],
  options?: { includeAddonSettings?: boolean; includeSavedVars?: boolean; includeUserSettings?: boolean; excludeRuntimeFiles?: Record<string, string[]> },
  onProgress?: (phase: string, percent: number) => void
): Buffer {
  const liveDir = getLiveDir(addonsPath);
  const zip = new AdmZip();

  onProgress?.('Reading settings…', 5);

  // AddOnSettings.txt
  const settingsPath = getSettingsPath(addonsPath);
  let addonSettings: string | null = null;
  if (options?.includeAddonSettings !== false && fs.existsSync(settingsPath)) {
    addonSettings = fs.readFileSync(settingsPath, 'utf-8');
    // Clean up orphaned entries
    const exportedNames = new Set(addonList.map((a) => a.folderName));
    const lines = addonSettings.split(/\r?\n/);
    const filtered: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') { filtered.push(line); continue; }
      const m = trimmed.match(/^(\S+)\s+\d+$/);
      if (m) {
        if (exportedNames.has(m[1]) || m[1].startsWith('ZO_')) filtered.push(line);
      } else {
        filtered.push(line);
      }
    }
    addonSettings = filtered.join('\r\n');
  }

  // UserSettings.txt
  const userSettingsPath = path.join(liveDir, 'UserSettings.txt');
  const userSettings = (options?.includeUserSettings !== false && fs.existsSync(userSettingsPath))
    ? fs.readFileSync(userSettingsPath, 'utf-8')
    : null;

  // Build profile.json (metadata only)
  const profile = {
    formatVersion: 3,
    exportedAt: new Date().toISOString(),
    addons: addonList,
    addonSettings,
    userSettings,
  };
  zip.addFile('profile.json', Buffer.from(JSON.stringify(profile, null, 2), 'utf-8'));

  // AddOn folders — archive ALL addon folders directly
  const totalFolders = addonList.length;
  for (let i = 0; i < totalFolders; i++) {
    const folder = addonList[i].folderName;
    const folderPath = path.join(addonsPath, folder);
    onProgress?.(`Adding AddOns… ${folder} (${i + 1}/${totalFolders})`, 10 + Math.round(((i + 1) / totalFolders) * 55));
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue;
    const resolvedExport = path.resolve(addonsPath, folder);
    if (!resolvedExport.startsWith(addonsPath + path.sep) || folder.includes('..')) continue;
    try {
      zip.addLocalFolder(folderPath, `AddOns/${folder}`);
      // Remove runtime-created files if user opted out
      if (options?.excludeRuntimeFiles?.[folder]) {
        for (const rf of options.excludeRuntimeFiles[folder]) {
          const entryName = `AddOns/${folder}/${rf}`.replace(/\\/g, '/');
          try { zip.deleteFile(entryName); } catch { /* entry may not exist */ }
        }
      }
    } catch { /* skip */ }
  }

  // SavedVariables
  if (options?.includeSavedVars !== false) {
    const svDir = getSavedVarsDir(addonsPath);
    if (fs.existsSync(svDir)) {
      const files = fs.readdirSync(svDir).filter((f) => f.endsWith('.lua'));
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        zip.addLocalFile(path.join(svDir, file), 'SavedVariables');
        onProgress?.(`Adding SavedVariables… (${i + 1}/${files.length})`, 70 + Math.round(((i + 1) / files.length) * 25));
      }
    }
  }

  onProgress?.('Compressing…', 98);
  return zip.toBuffer();
}

/**
 * Preview a ZIP profile: read profile.json and list contents.
 */
export function previewProfileZip(zipPath: string): {
  totalAddons: number; totalLibraries: number; bundledCount: number;
  hasSettings: boolean; hasUserSettings: boolean; savedVarsCount: number;
  savedVarFiles: string[]; exportedAt: string; isFullArchive: boolean;
  addonList: { folderName: string; isLibrary: boolean }[];
} {
  const zip = new AdmZip(zipPath);
  const profileEntry = zip.getEntry('profile.json');
  if (!profileEntry) throw new Error('Invalid ZIP profile: missing profile.json');
  const profile = JSON.parse(zip.readAsText(profileEntry));
  if (!profile.addons) throw new Error('Invalid profile format');

  const svEntries = zip.getEntries().filter(e => e.entryName.startsWith('SavedVariables/') && e.entryName.endsWith('.lua'));

  // v3+: AddOns/ contains all folders; v2: BundledAddons/ only has non-catalog
  const addonFolders = new Set(
    zip.getEntries()
      .filter(e => e.entryName.startsWith('AddOns/'))
      .map(e => e.entryName.split('/')[1])
      .filter(Boolean)
  );
  const bundledFolders = new Set(
    zip.getEntries()
      .filter(e => e.entryName.startsWith('BundledAddons/'))
      .map(e => e.entryName.split('/')[1])
      .filter(Boolean)
  );
  const isFullArchive = addonFolders.size > 0;
  const archivedCount = addonFolders.size + bundledFolders.size;

  return {
    totalAddons: profile.addons.filter((a: { isLibrary: boolean }) => !a.isLibrary).length,
    totalLibraries: profile.addons.filter((a: { isLibrary: boolean }) => a.isLibrary).length,
    bundledCount: archivedCount,
    hasSettings: !!profile.addonSettings,
    hasUserSettings: !!profile.userSettings,
    savedVarsCount: svEntries.length,
    savedVarFiles: svEntries.map(e => path.basename(e.entryName)).sort(),
    exportedAt: profile.exportedAt || '',
    isFullArchive,
    addonList: (profile.addons || []).map((a: { folderName: string; isLibrary: boolean }) => ({
      folderName: a.folderName,
      isLibrary: a.isLibrary,
    })),
  };
}

/**
 * Import a ZIP profile: extract settings, SavedVariables, and bundled addons.
 */
export function importProfileFromZip(
  addonsPath: string,
  zipPath: string,
  options?: { importAddonSettings?: boolean; importUserSettings?: boolean; savedVarFilter?: Record<string, boolean>; addonFilter?: Record<string, boolean> }
): { addonsToInstall: { folderName: string; catalogId?: string; isLibrary: boolean }[]; restoredSettings: string[]; restoredBundles: string[]; errors: string[] } {
  const liveDir = getLiveDir(addonsPath);
  const restoredSettings: string[] = [];
  const restoredBundles: string[] = [];
  const errors: string[] = [];

  const zip = new AdmZip(zipPath);
  const profileEntry = zip.getEntry('profile.json');
  if (!profileEntry) throw new Error('Invalid ZIP profile: missing profile.json');
  const profile = JSON.parse(zip.readAsText(profileEntry));

  // Restore AddOnSettings.txt
  if (options?.importAddonSettings !== false && profile.addonSettings) {
    try {
      const settingsPath = getSettingsPath(addonsPath);
      let currentVersion = 0;
      let currentAckVersion = 0;
      if (fs.existsSync(settingsPath)) {
        backupFile(settingsPath, getBackupDir(addonsPath, 'AddOnSettings'));
        const existing = fs.readFileSync(settingsPath, 'utf-8');
        const vMatch = existing.match(/^#Version\s+(\d+)$/m);
        const aMatch = existing.match(/^#AcknowledgedOutOfDateAddonsVersion\s+(\d+)$/m);
        if (vMatch) currentVersion = parseInt(vMatch[1], 10);
        if (aMatch) currentAckVersion = parseInt(aMatch[1], 10);
      }
      let settingsContent = profile.addonSettings;
      if (currentVersion > 0) {
        settingsContent = settingsContent
          .replace(/^#Version\s+\d+$/m, `#Version ${currentVersion}`)
          .replace(/^#AcknowledgedOutOfDateAddonsVersion\s+\d+$/m, `#AcknowledgedOutOfDateAddonsVersion ${Math.max(currentVersion, currentAckVersion)}`);
      }
      settingsContent = settingsContent.replace(/^#AddOnsEnabled\s+0$/m, '#AddOnsEnabled 1');
      writeFileAtomic(settingsPath, settingsContent);
      restoredSettings.push('AddOnSettings.txt');
    } catch (err: unknown) {
      errors.push(`AddOnSettings.txt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Restore UserSettings.txt
  if (options?.importUserSettings !== false && profile.userSettings) {
    try {
      const userSettingsPath = path.join(liveDir, 'UserSettings.txt');
      if (fs.existsSync(userSettingsPath)) {
        backupFile(userSettingsPath, getBackupDir(addonsPath, 'UserSettings'));
      }
      writeFileAtomic(userSettingsPath, profile.userSettings);
      restoredSettings.push('UserSettings.txt');
    } catch (err: unknown) {
      errors.push(`UserSettings.txt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Restore SavedVariables from ZIP
  const svDir = getSavedVarsDir(addonsPath);
  fs.mkdirSync(svDir, { recursive: true });
  const svEntries = zip.getEntries().filter(e => e.entryName.startsWith('SavedVariables/') && e.entryName.endsWith('.lua'));
  if (svEntries.length > 0) {
    // Backup existing SV files
    const existingSvFiles = fs.existsSync(svDir) ? fs.readdirSync(svDir).filter(f => f.endsWith('.lua')) : [];
    if (existingSvFiles.length > 0) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const svBackupDir = path.join(getBackupDir(addonsPath, 'SavedVariables'), `_import_backup_${ts}`);
      fs.mkdirSync(svBackupDir, { recursive: true });
      for (const file of existingSvFiles) {
        try { fs.copyFileSync(path.join(svDir, file), path.join(svBackupDir, file)); } catch { /* ok */ }
      }
    }

    for (const entry of svEntries) {
      const fileName = path.basename(entry.entryName);
      if (options?.savedVarFilter && options.savedVarFilter[fileName] === false) continue;
      const resolvedSv = path.resolve(svDir, fileName);
      if (!resolvedSv.startsWith(svDir + path.sep) || fileName.includes('..')) {
        errors.push(`Skipped unsafe filename: ${fileName}`);
        continue;
      }
      try {
        zip.extractEntryTo(entry, svDir, false, true);
        restoredSettings.push(`SavedVariables/${fileName}`);
      } catch (err: unknown) {
        errors.push(`SavedVariables/${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Restore addon folders from ZIP (v3: AddOns/, v2 compat: BundledAddons/)
  const restoredFromZip = new Set<string>();
  for (const prefix of ['AddOns/', 'BundledAddons/']) {
    const folderNames = new Set(
      zip.getEntries()
        .filter(e => e.entryName.startsWith(prefix) && e.entryName.split('/').length > 2)
        .map(e => e.entryName.split('/')[1])
        .filter(Boolean)
    );
    for (const folderName of folderNames) {
      if (restoredFromZip.has(folderName)) continue; // AddOns/ takes priority over BundledAddons/
      if (options?.addonFilter && options.addonFilter[folderName] === false) continue; // User deselected this addon
      const resolvedBundle = path.resolve(addonsPath, folderName);
      if (!resolvedBundle.startsWith(addonsPath + path.sep) || folderName.includes('..')) {
        errors.push(`Skipped unsafe addon folder: ${folderName}`);
        continue;
      }
      try {
        const entryPrefix = `${prefix}${folderName}/`;
        const entries = zip.getEntries().filter(e => e.entryName.startsWith(entryPrefix));
        for (const entry of entries) {
          const relativePath = entry.entryName.slice(prefix.length);
          const destPath = path.join(addonsPath, relativePath);
          if (entry.isDirectory) {
            fs.mkdirSync(destPath, { recursive: true });
          } else {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            writeFileAtomic(destPath, entry.getData());
          }
        }
        restoredFromZip.add(folderName);
        restoredBundles.push(folderName);
      } catch (err: unknown) {
        errors.push(`Addon ${folderName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Determine which addons need to be installed
  const existingDirs = new Set(
    fs.readdirSync(addonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  );
  const addonsToInstall = (profile.addons || []).filter((a: { folderName: string }) =>
    !existingDirs.has(a.folderName) && (!options?.addonFilter || options.addonFilter[a.folderName] !== false)
  );

  return { addonsToInstall, restoredSettings, restoredBundles, errors };
}
