// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Is a catalog entry installed?
 *
 * Not as obvious as it looks.  Authors regularly pack two independent addons
 * into one archive — ESOUI #2221 "Price Tooltip" ships both PriceTooltip/ and
 * PriceTooltipNote/, and PriceTooltipNote has a catalog entry of its own
 * (#3201).  After installing #2221 the folder PriceTooltipNote exists, but
 * nothing of #3201 was ever downloaded: what lies there is the copy the other
 * author bundled, at whatever version they packed.
 *
 * So folder presence alone must not mark an entry as installed.  The decisive
 * question is WHERE the folder sits:
 *   - directly in AddOns/          → installed, this entry owns the folder
 *   - only inside another addon    → bundled, someone else owns it
 *
 * Treating the bundled case as installed misreports the version, offers a
 * delete button for a path that does not exist at top level, and hides the
 * entry from a "not installed" filter.
 */

export type InstallState = 'installed' | 'bundled' | 'absent';

/**
 * @param directories  the catalog entry's UIDir list; [0] is its main folder
 * @param topLevelDirs folders that sit in AddOns/ itself
 * @param presentDirs  every known folder, sub-addon folders included
 */
export function classifyInstallState(
  directories: readonly string[],
  topLevelDirs: ReadonlySet<string>,
  presentDirs: ReadonlySet<string>
): InstallState {
  if (directories.length === 0) return 'absent';
  if (topLevelDirs.has(directories[0])) return 'installed';
  // A secondary dir (shared library) or a bundled copy of the whole addon
  if (directories.some((dir) => presentDirs.has(dir))) return 'bundled';
  return 'absent';
}
