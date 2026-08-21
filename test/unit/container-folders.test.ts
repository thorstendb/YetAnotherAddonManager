// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanAddonsFolder } from '../../electron/addonScanner';
import { previewCleanupSettings } from '../../electron/settingsManager';

/**
 * Folders that hold addons instead of being one.  Reported from the wild:
 * Arkadius' Trade Tools and HarvestMapData showed as "not installed" after
 * installing them, and their SavedVariables were then offered for deletion.
 *
 * Both ship without a <Folder>/<Folder>.txt manifest:
 *   ArkadiusTradeTools/ArkadiusTradeTools/ArkadiusTradeTools.txt   (1 level)
 *   HarvestMapData/Modules/HarvestMapAD/HarvestMapAD.txt           (2 levels)
 */
describe('container folders without their own manifest', () => {
  let tmp: string;
  let addons: string;

  const writeManifest = (dir: string, name: string, headers: Record<string, string>) => {
    fs.mkdirSync(dir, { recursive: true });
    const body = Object.entries(headers).map(([k, v]) => `## ${k}: ${v}`).join('\n');
    fs.writeFileSync(path.join(dir, `${name}.txt`), `${body}\n`);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-container-'));
    addons = path.join(tmp, 'AddOns');
    fs.mkdirSync(addons, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds the Arkadius shape and lets the same-named child define the row', () => {
    const root = path.join(addons, 'ArkadiusTradeTools');
    writeManifest(path.join(root, 'ArkadiusTradeTools'), 'ArkadiusTradeTools', {
      Title: "Arkadius' Trade Tools", Version: '2.0.0', SavedVariables: 'ArkadiusTradeTools',
    });
    writeManifest(path.join(root, 'ArkadiusTradeToolsSales'), 'ArkadiusTradeToolsSales', {
      Title: 'ATT Sales', Version: '2.0.0', SavedVariables: 'ArkadiusTradeToolsSalesData',
    });

    const found = scanAddonsFolder(addons);
    expect(found.map((a) => a.folderName)).toEqual(['ArkadiusTradeTools']);

    const att = found[0];
    expect(att.isContainer).toBe(true);
    // Title and version come from the child carrying the folder's own name —
    // without it the row would have no version and update detection is blind
    expect(att.title).toBe("Arkadius' Trade Tools");
    expect(att.version).toBe('2.0.0');
    expect(att.subAddons.map((s) => s.folderName).sort())
      .toEqual(['ArkadiusTradeTools', 'ArkadiusTradeToolsSales']);
  });

  it('finds addons nested two levels down (HarvestMapData shape)', () => {
    const root = path.join(addons, 'HarvestMapData');
    for (const zone of ['HarvestMapAD', 'HarvestMapDC', 'HarvestMapEP']) {
      writeManifest(path.join(root, 'Modules', zone), zone, { Title: zone, Version: '3.15.3' });
    }

    const found = scanAddonsFolder(addons);
    expect(found.map((a) => a.folderName)).toEqual(['HarvestMapData']);
    expect(found[0].subAddons.map((s) => s.folderName).sort())
      .toEqual(['HarvestMapAD', 'HarvestMapDC', 'HarvestMapEP']);
    // No same-named child here, so the row stays version-less — YAAM tracking
    // carries update detection for this one
    expect(found[0].version).toBe('');
  });

  it('keeps a plain data folder out of the addon list', () => {
    fs.mkdirSync(path.join(addons, 'SomeDataFolder', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(addons, 'SomeDataFolder', 'data.lua'), '-- no manifest\n');
    expect(scanAddonsFolder(addons)).toEqual([]);
  });

  it('no longer offers the SavedVariables of a container for cleanup', () => {
    const root = path.join(addons, 'ArkadiusTradeTools');
    writeManifest(path.join(root, 'ArkadiusTradeTools'), 'ArkadiusTradeTools', {
      Title: 'ATT', Version: '2.0.0', SavedVariables: 'ArkadiusTradeTools',
    });
    writeManifest(path.join(root, 'ArkadiusTradeToolsSales'), 'ArkadiusTradeToolsSales', {
      Title: 'ATT Sales', Version: '2.0.0', SavedVariables: 'ArkadiusTradeToolsSalesData',
    });
    const svDir = path.join(addons, '..', 'SavedVariables');
    fs.mkdirSync(svDir, { recursive: true });
    fs.writeFileSync(path.join(svDir, 'ArkadiusTradeTools.lua'), '-- sales history\n');
    fs.writeFileSync(path.join(svDir, 'ArkadiusTradeToolsSalesData.lua'), '-- sales data\n');
    fs.writeFileSync(path.join(svDir, 'LongGoneAddon.lua'), '-- really orphaned\n');

    // Exactly what App.tsx hands to the cleanup: folders plus their sub-addons
    const existing = scanAddonsFolder(addons)
      .flatMap((a) => [a.folderName, ...a.subAddons.map((s) => s.folderName)]);

    const { orphanedSavedVars } = previewCleanupSettings(addons, existing);
    expect(orphanedSavedVars).toEqual(['LongGoneAddon.lua']);
  });
});
