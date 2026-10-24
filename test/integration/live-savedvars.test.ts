// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSavedVars, removeEntries, SvNode } from '../../electron/svParse';
import { previewCleanupSettings } from '../../electron/settingsManager';
import { scanAddonsFolder } from '../../electron/addonScanner';
import { AddonInfo } from '../../electron/shared/types';

/**
 * READ-ONLY smoke test against the real SavedVariables of a live installation:
 * every file the game (or a tool) wrote must parse, an empty cut must be the
 * identity, and cuts anywhere in the tree must leave a parseable file.
 * Skipped automatically when the live folder is missing — it never writes.
 */
const LIVE = path.join(os.homedir(), 'Documents', 'Elder Scrolls Online', 'live');
const SV_DIR = path.join(LIVE, 'SavedVariables');
const haveLive = fs.existsSync(SV_DIR);

const svFiles = haveLive ? fs.readdirSync(SV_DIR).filter((f) => f.endsWith('.lua')) : [];
const entryNames = (list: AddonInfo[]): string[] => list.flatMap((a) => [a.folderName, ...entryNames(a.subAddons)]);

describe.skipIf(!haveLive)('live SavedVariables', () => {
  it('parses every file; removing nothing is the identity', () => {
    const failures: string[] = [];
    for (const file of svFiles) {
      const buf = fs.readFileSync(path.join(SV_DIR, file));
      try {
        parseSavedVars(buf);
        expect(removeEntries(buf, []).output.equals(buf)).toBe(true);
      } catch (err) {
        failures.push(`${file}: ${err instanceof Error ? err.message : err}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('stays parseable after removing entries at every depth', () => {
    for (const file of svFiles) {
      const buf = fs.readFileSync(path.join(SV_DIR, file));
      const levels: SvNode[][] = [parseSavedVars(buf)];
      while (levels[levels.length - 1].length > 0 && levels.length < 6) {
        levels.push(levels[levels.length - 1].flatMap((n) => n.children ?? []));
      }
      for (const level of levels.slice(1)) {
        // Every other entry: exercises first, middle and last positions
        const cut = level.filter((_n, i) => i % 2 === 0);
        expect(() => removeEntries(buf, cut), file).not.toThrow();
      }
    }
  });

  it('finds ballast only in files of installed addons and never in MM sales data', () => {
    const addonsPath = path.join(LIVE, 'AddOns');
    const preview = previewCleanupSettings(addonsPath, entryNames(scanAddonsFolder(addonsPath)));
    for (const f of preview.ballast) {
      expect(f.files.every((file) => !/^(GS\d\dData|ZO_.*)\.lua$/i.test(file) && !preview.orphanedSavedVars.includes(file))).toBe(true);
      expect(f.bytes).toBeGreaterThan(0);
    }
  });
});
