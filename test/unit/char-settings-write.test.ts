// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { batchSetAddonSettings, parseAddonSettings } from '../../electron/settingsManager';

/**
 * Cover for writing per-character enable/disable state into AddOnSettings.txt.
 *
 * The file is the game's, not ours: every addon the client found has its own
 * line per character section, and a change we fail to write is a change the
 * user believes they made.
 */
describe('batchSetAddonSettings', () => {
  let tmp: string;
  let addons: string;
  let settingsFile: string;

  const SETTINGS = [
    '#Version 1',
    '#AddOnsEnabled 1',
    '#Default',
    'HarvestMap 1',
    'HarvestMapAD 0',
    '#EU Megaserver-Alandhur',
    'HarvestMap 0',
    'HarvestMapAD 0',
    '#EU Megaserver-Zweiter',
    'HarvestMap 0',
    '',
  ].join('\r\n');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-charset-'));
    addons = path.join(tmp, 'AddOns');
    fs.mkdirSync(addons, { recursive: true });
    settingsFile = path.join(tmp, 'AddOnSettings.txt');
    fs.writeFileSync(settingsFile, SETTINGS);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const read = () => parseAddonSettings(addons);

  it('flips an existing line in the right section only', () => {
    const res = batchSetAddonSettings(addons, [
      { character: 'EU Megaserver-Alandhur', addonName: 'HarvestMap', enabled: true },
    ]);
    expect(res.applied).toBe(1);
    expect(res.skipped).toEqual([]);

    const parsed = read();
    expect(parsed.characters['EU Megaserver-Alandhur']['HarvestMap']).toBe(true);
    expect(parsed.characters['EU Megaserver-Zweiter']['HarvestMap']).toBe(false);
  });

  it('inserts a line for an addon the section does not list yet', () => {
    const res = batchSetAddonSettings(addons, [
      { character: 'EU Megaserver-Zweiter', addonName: 'HarvestMapAD', enabled: true },
    ]);
    expect(res.applied).toBe(1);
    expect(read().characters['EU Megaserver-Zweiter']['HarvestMapAD']).toBe(true);
  });

  it('writes a parent and its modules in one batch (the "enable" case)', () => {
    const character = 'EU Megaserver-Alandhur';
    const res = batchSetAddonSettings(addons, [
      { character, addonName: 'HarvestMap', enabled: true },
      { character, addonName: 'HarvestMapAD', enabled: true },
    ]);
    expect(res.applied).toBe(2);

    const parsed = read();
    // Both must land — a parent enabled without its modules stays off in game
    expect(parsed.characters[character]['HarvestMap']).toBe(true);
    expect(parsed.characters[character]['HarvestMapAD']).toBe(true);
  });

  it('reports a change it could not write instead of counting it as applied', () => {
    const res = batchSetAddonSettings(addons, [
      { character: 'EU Megaserver-GibtEsNicht', addonName: 'HarvestMap', enabled: true },
    ]);
    expect(res.applied).toBe(0);
    expect(res.skipped).toEqual(['EU Megaserver-GibtEsNicht/HarvestMap']);
  });

  it('leaves the #Default section addressable', () => {
    const res = batchSetAddonSettings(addons, [
      { character: '#Default', addonName: 'HarvestMapAD', enabled: true },
    ]);
    expect(res.applied).toBe(1);
    expect(read().defaults['HarvestMapAD']).toBe(true);
  });
});
