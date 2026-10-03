// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { extractAndRegister } from '../../electron/addonFiles';
import { scanAddonsFolder, commitBaseline } from '../../electron/addonScanner';
import { updateCatalogSnapshot, commitCatalogSnapshot } from '../../electron/addonCatalogApi';
import { CatalogAddon } from '../../electron/shared/types';

const cat = (over: Partial<CatalogAddon> & { id: string; name: string }): CatalogAddon => ({
  categoryId: '1', author: 'x', version: '1.0', date: 1000,
  infoUrl: '', totalDownloads: 0, monthlyDownloads: 0, favorites: 0,
  compatibility: [], directories: [over.name], thumbnails: [], images: [],
  donationLink: '', ...over,
});

let tmp: string;
let addons: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-integrity-'));
  addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * Found on a real install: wykkydsAchievementTracker had lost
 * e/LAM/LibAddonMenu-2.0.{lua,txt} (another manager "deduplicated" the
 * embedded library).  Its version still read current, so nothing ever
 * offered to repair the folder.
 */
describe('install integrity (files missing vs. the install manifest)', () => {
  const install = () => {
    const zip = new AdmZip();
    zip.addFile('Tracker/Tracker.txt', Buffer.from('## Title: T\n## Version: 2.4\n'));
    zip.addFile('Tracker/addon.lua', Buffer.from('-- main\n'));
    zip.addFile('Tracker/e/LAM/LibAddonMenu-2.0.lua', Buffer.from('-- embedded lib\n'));
    zip.addFile('Tracker/e/LAM/controls/panel.lua', Buffer.from('-- control\n'));
    const p = path.join(tmp, 'tracker.zip');
    zip.writeZip(p);
    extractAndRegister(p, addons, cat({ id: '2028', name: 'Tracker', version: '2.4' }));
  };

  it('reports nothing for an intact install', () => {
    install();
    const [a] = scanAddonsFolder(addons);
    expect(a.missingFiles).toBeUndefined();
    expect(a.runtimeFiles).toBeUndefined();
  });

  it('reports files deleted after the install, and only those', () => {
    install();
    fs.unlinkSync(path.join(addons, 'Tracker', 'e', 'LAM', 'LibAddonMenu-2.0.lua'));
    fs.writeFileSync(path.join(addons, 'Tracker', 'cache.lua'), '-- written at runtime\n');
    const [a] = scanAddonsFolder(addons);
    expect(a.missingFiles).toEqual(['e/LAM/LibAddonMenu-2.0.lua']);
    expect(a.runtimeFiles).toEqual(['cache.lua']);
  });

  it('drops the old file list when a baseline anchors a release YAAM did not extract', () => {
    // Real case (MapPins): installed by YAAM, later updated outside YAAM to a
    // release that moved its textures into a subfolder, then anchored by a
    // baseline commit — the old list then reported 13 "missing" files.
    install();
    const dir = path.join(addons, 'Tracker');
    fs.rmSync(path.join(dir, 'e'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Tracker.txt'), '## Title: T\n## Version: 2.5\n');
    // Before the anchor moves, the manifest no longer matches it: modified
    // outside YAAM, so the stale list must not count as damage
    expect(scanAddonsFolder(addons)[0].missingFiles).toBeUndefined();

    commitBaseline(addons, [{ folderName: 'Tracker', esouid: '2028', url: '', name: 'Tracker', author: 'x', catalogVersion: '2.5', catalogDate: 2000, localVersion: '2.5' }]);
    const [a] = scanAddonsFolder(addons);
    expect(a.missingFiles).toBeUndefined();
    expect(a.yaamMeta?.installedFiles).toBeUndefined();
  });

  it('keeps the file list when a baseline re-anchors the release it already describes', () => {
    install();
    commitBaseline(addons, [{ folderName: 'Tracker', esouid: '2028', url: '', name: 'Tracker', author: 'x', catalogVersion: '2.4', catalogDate: 1000, localVersion: '2.4' }]);
    fs.unlinkSync(path.join(addons, 'Tracker', 'addon.lua'));
    expect(scanAddonsFolder(addons)[0].missingFiles).toEqual(['addon.lua']);
  });

  it('is cleared by reinstalling the release', () => {
    install();
    fs.unlinkSync(path.join(addons, 'Tracker', 'addon.lua'));
    expect(scanAddonsFolder(addons)[0].missingFiles).toEqual(['addon.lua']);
    install();
    expect(scanAddonsFolder(addons)[0].missingFiles).toBeUndefined();
  });
});

/**
 * Committing the whole catalog after one install erased the catalog-change
 * signal (Tier 0) of every OTHER pending update — the most reliable signal for
 * addons YAAM does not track.
 */
describe('catalog snapshot commit with held entries', () => {
  it('keeps held entries in the next diff and drops committed ones', () => {
    const v1 = [cat({ id: '1', name: 'A', version: '1.0' }), cat({ id: '2', name: 'B', version: '1.0' })];
    const v2 = [cat({ id: '1', name: 'A', version: '1.1', date: 2000 }), cat({ id: '2', name: 'B', version: '1.1', date: 2000 })];

    expect(updateCatalogSnapshot(addons, v1)).toBeNull(); // first run writes the baseline
    expect([...updateCatalogSnapshot(addons, v2)!.changed.keys()].sort()).toEqual(['1', '2']);

    // A was installed, B is still pending
    commitCatalogSnapshot(addons, v2, ['2']);
    const diff = updateCatalogSnapshot(addons, v2)!;
    expect([...diff.changed.keys()]).toEqual(['2']);
    expect(diff.changed.get('2')).toEqual({ oldVersion: '1.0', newVersion: '1.1' });
  });

  it('commits everything without held entries', () => {
    const v1 = [cat({ id: '1', name: 'A', version: '1.0' })];
    const v2 = [cat({ id: '1', name: 'A', version: '1.1', date: 2000 })];
    updateCatalogSnapshot(addons, v1);
    commitCatalogSnapshot(addons, v2);
    expect(updateCatalogSnapshot(addons, v2)!.changed.size).toBe(0);
  });
});
