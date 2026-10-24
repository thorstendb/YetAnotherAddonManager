// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Per-character dependency consistency of AddOnSettings.txt, and the folders
 * no character uses at all.
 *
 * The game skips an enabled addon with "missing dependency" when a REQUIRED
 * dependency is switched off for that character — although everything is
 * installed.  Typical cause: a parent addon disabled in game while its modules
 * stayed on (HarvestMap and its zone modules, VotansFisherman and
 * VotansFishermanExport).
 */
import { AddonInfo } from './types';

export interface CharDepConflict {
  /** Enabled game entry that cannot load */
  module: string;
  /** Its required dependency that is switched off */
  dep: string;
}

/**
 * Required dependencies of the given game entries, followed transitively.
 * `lookup` resolves an entry name to its manifest (top-level or sub-addon);
 * names it does not know (not installed) are skipped — the game has no entry
 * to switch on for them.
 */
export function requiredDepClosure(
  names: string[],
  lookup: (name: string) => AddonInfo | undefined
): string[] {
  const result = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    for (const dep of lookup(queue.shift()!)?.dependsOn ?? []) {
      if (dep.name.startsWith('ZO_') || result.has(dep.name) || !lookup(dep.name)) continue;
      result.add(dep.name);
      queue.push(dep.name);
    }
  }
  for (const n of names) result.delete(n);
  return [...result];
}

/**
 * Per top-level folder and character: enabled entries whose required
 * dependency is switched off.  `isEnabled` must apply the game's rules
 * (missing entry → #Default → enabled) and any pending, unsaved changes.
 */
export function findCharDepConflicts(
  addons: AddonInfo[],
  characters: string[],
  isEnabled: (character: string, name: string) => boolean,
  isInstalled: (name: string) => boolean
): Map<string, Record<string, CharDepConflict[]>> {
  const result = new Map<string, Record<string, CharDepConflict[]>>();
  for (const addon of addons) {
    // A container folder has no manifest of its own — only its children are game entries
    const modules = addon.isContainer ? addon.subAddons : [addon, ...addon.subAddons];
    for (const character of characters) {
      const conflicts: CharDepConflict[] = [];
      for (const mod of modules) {
        if (!isEnabled(character, mod.folderName)) continue;
        for (const dep of mod.dependsOn) {
          if (dep.name.startsWith('ZO_') || !isInstalled(dep.name)) continue;
          if (!isEnabled(character, dep.name)) conflicts.push({ module: mod.folderName, dep: dep.name });
        }
      }
      if (conflicts.length > 0) {
        const perChar = result.get(addon.folderName) ?? {};
        perChar[character] = conflicts;
        result.set(addon.folderName, perChar);
      }
    }
  }
  return result;
}

/**
 * Game entries that decide whether a top-level folder is in use: its own
 * manifest plus its modules.  Embedded libraries do not count — they are
 * usually also installed standalone and switched on everywhere, which would
 * keep every host addon "in use".  A container whose children are all
 * libraries falls back to all of them.
 */
function usageEntries(addon: AddonInfo): string[] {
  const modules = addon.subAddons.filter((s) => !s.isLibrary).map((s) => s.folderName);
  if (!addon.isContainer) return [addon.folderName, ...modules];
  return modules.length > 0 ? modules : addon.subAddons.map((s) => s.folderName);
}

/**
 * Top-level folders switched off for every character — the game never loads
 * them.  `isEnabled` must apply the game's rules (missing entry → #Default →
 * enabled).  A folder that provides a REQUIRED dependency of a folder in use
 * is kept, even when it is switched off everywhere: removing it would turn a
 * fixable "missing dependency" into a missing install.  Without any character
 * section nothing can be judged, so nothing is reported.
 */
export function findUnusedAddons(
  addons: AddonInfo[],
  characters: string[],
  isEnabled: (character: string, name: string) => boolean
): string[] {
  if (characters.length === 0) return [];
  const isUsed = (addon: AddonInfo) =>
    characters.some((c) => usageEntries(addon).some((name) => isEnabled(c, name)));
  const used = addons.filter(isUsed);
  const unused = addons.filter((a) => !isUsed(a));

  const required = new Set<string>();
  for (const addon of used) {
    for (const mod of [addon, ...addon.subAddons]) {
      for (const dep of mod.dependsOn) required.add(dep.name);
    }
  }
  // Names still provided by a folder that stays installed
  const keptProviders = new Set(used.flatMap((a) => [a.folderName, ...a.subAddons.map((s) => s.folderName)]));

  return unused
    .filter((a) => ![a, ...a.subAddons].some((m) => required.has(m.folderName) && !keptProviders.has(m.folderName)))
    .map((a) => a.folderName)
    .sort((a, b) => a.localeCompare(b));
}
