// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { extractAndRegister, adoptCachedRelease } from '../../electron/addonFiles';
import { scanAddonsFolder } from '../../electron/addonScanner';
import { loadDatabase, saveDatabase, writeMarkerFile } from '../../electron/yaamDatabase';
import { CatalogAddon, releaseZipName } from '../../electron/shared/types';

const cat = (over: Partial<CatalogAddon> & { id: string; name: string }): CatalogAddon => ({
  categoryId: '1', author: 'x', version: '1.0', date: 1000,
  infoUrl: '', totalDownloads: 0, monthlyDownloads: 0, favorites: 0,
  compatibility: [], directories: [over.name], thumbnails: [], images: [],
  donationLink: '', ...over,
});

const RELEASE = {
  'Stats/Stats.txt': '## Title: S\n## AddOnVersion: 1157000\n',
  'Stats/main.lua': '-- main\n',
  'Stats/lang/en.lua': '-- strings\n',
};
const stats = cat({ id: '4032', name: 'Impressive Stats', version: '1.5.7' });

let tmp: string;
let addons: string;
let downloads: string;

const makeZip = (files: Record<string, string>, name: string): string => {
  const zip = new AdmZip();
  for (const [n, c] of Object.entries(files)) zip.addFile(n, Buffer.from(c));
  const p = path.join(tmp, name);
  zip.writeZip(p);
  return p;
};
const install = () => extractAndRegister(makeZip(RELEASE, 'stats.zip'), addons, stats);
const file = (rel: string) => path.join(addons, 'Stats', ...rel.split('/'));
/** Put the release into YAAM's download cache, as an earlier install would have */
const cacheRelease = () => {
  fs.mkdirSync(downloads, { recursive: true });
  fs.copyFileSync(makeZip(RELEASE, 'cache.zip'), path.join(downloads, releaseZipName(stats)));
};
/** Copy the release into AddOns the way another manager does — no marker */
const extractForeign = () => {
  for (const [n, c] of Object.entries(RELEASE)) {
    fs.mkdirSync(path.dirname(path.join(addons, n)), { recursive: true });
    fs.writeFileSync(path.join(addons, n), c);
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-local-'));
  addons = path.join(tmp, 'AddOns');
  downloads = path.join(tmp, 'Downloads');
  fs.mkdirSync(addons, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * Real cases: CraftStore_Events.lua and BindAll.lua carried the user's own
 * fixes at the catalog version — an update would have overwritten them
 * without a word.
 */
describe('local changes since the install', () => {
  it('records file stamps on install and reports nothing while untouched', () => {
    install();
    const [a] = scanAddonsFolder(addons);
    expect(Object.keys(a.yaamMeta?.fileStamps ?? {}).sort()).toEqual(['Stats.txt', 'lang/en.lua', 'main.lua']);
    expect(a.modifiedFiles).toBeUndefined();
  });

  it('reports an edited file, and only that one', () => {
    install();
    fs.appendFileSync(file('main.lua'), '-- my own fix\n');
    expect(scanAddonsFolder(addons)[0].modifiedFiles).toEqual(['main.lua']);
  });

  it('catches an edit that keeps the size', () => {
    install();
    fs.writeFileSync(file('main.lua'), '-- MAIN\n');
    expect(scanAddonsFolder(addons)[0].modifiedFiles).toEqual(['main.lua']);
  });

  it('does not report a file whose mtime moved but whose content is unchanged', () => {
    install();
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file('main.lua'), later, later);
    expect(scanAddonsFolder(addons)[0].modifiedFiles).toBeUndefined();
  });

  it('does not report files a tracked language patch replaced', () => {
    install();
    const patch = makeZip({ 'Stats/lang/en.lua': '-- patched strings\n' }, 'patch.zip');
    extractAndRegister(patch, addons, cat({ id: '99', name: 'Stats LangPatch', version: '2.0' }), { overlayFor: 'Stats' });
    expect(scanAddonsFolder(addons)[0].modifiedFiles).toBeUndefined();
  });

  it('starts over after an update: the new release is the reference', () => {
    install();
    fs.appendFileSync(file('main.lua'), '-- my own fix\n');
    install();
    expect(scanAddonsFolder(addons)[0].modifiedFiles).toBeUndefined();
  });
});

describe('lost marker', () => {
  it('is restored when the manifest still matches the install and no file is missing', () => {
    install();
    fs.unlinkSync(file('.yaam.json'));
    const [a] = scanAddonsFolder(addons);
    expect(a.yaamMeta?.catalogVersion).toBe('1.5.7');
    expect(fs.existsSync(file('.yaam.json'))).toBe(true);
  });

  it('still clears the tracked version when the folder holds something else', () => {
    install();
    fs.unlinkSync(file('.yaam.json'));
    fs.writeFileSync(file('Stats.txt'), '## Title: S\n## AddOnVersion: 1156000\n');
    expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('');
  });
});

describe('adoptCachedRelease', () => {
  const anchorRequest = (notBefore = 0) => ({
    folderName: 'Stats', zipName: releaseZipName(stats), notBefore, mode: 'anchor' as const,
    baseline: { folderName: 'Stats', esouid: stats.id, url: '', name: stats.name, author: 'x', catalogVersion: stats.version, catalogDate: 1000, localVersion: '1157000' },
  });

  it('anchors an untracked folder that is byte-identical to the cached release (ImpressiveStats)', () => {
    extractForeign();
    cacheRelease();
    expect(adoptCachedRelease(addons, [anchorRequest()])).toEqual([{ folderName: 'Stats', outcome: 'anchored', modified: undefined }]);
    const [a] = scanAddonsFolder(addons);
    expect(a.yaamMeta?.catalogVersion).toBe('1.5.7');
    expect(a.yaamMeta?.installedFiles?.sort()).toEqual(['Stats.txt', 'lang/en.lua', 'main.lua']);
    expect(a.modifiedFiles).toBeUndefined();
  });

  it('refuses to anchor a folder that differs from the release', () => {
    extractForeign();
    fs.appendFileSync(file('main.lua'), '-- other build\n');
    cacheRelease();
    expect(adoptCachedRelease(addons, [anchorRequest()])[0]).toMatchObject({ outcome: 'differs', modified: 1 });
    expect(scanAddonsFolder(addons)[0].yaamMeta).toBeUndefined();
  });

  it('distrusts a cached ZIP downloaded before the current upload', () => {
    extractForeign();
    cacheRelease();
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(adoptCachedRelease(addons, [anchorRequest(future)])[0].outcome).toBe('stale-cache');
  });

  it('reports a missing cache entry', () => {
    extractForeign();
    expect(adoptCachedRelease(addons, [anchorRequest()])[0].outcome).toBe('no-cache');
  });

  it('stamps a tracked folder installed before stamps existed — and exposes its local edits', () => {
    install();
    // Simulate an install from before file stamps
    const db = loadDatabase(addons);
    delete db.addons.Stats.fileStamps;
    saveDatabase(db, addons);
    writeMarkerFile(addons, 'Stats', db.addons.Stats);
    fs.appendFileSync(file('main.lua'), '-- my own fix\n');
    expect(scanAddonsFolder(addons)[0].modifiedFiles).toBeUndefined(); // invisible without stamps

    cacheRelease();
    const [r] = adoptCachedRelease(addons, [{ folderName: 'Stats', zipName: releaseZipName(stats), notBefore: 0, mode: 'stamp' }]);
    expect(r).toMatchObject({ outcome: 'stamped', modified: 1 });
    expect(scanAddonsFolder(addons)[0].modifiedFiles).toEqual(['main.lua']);
  });

  it('counts files that are gone as missing, not as local changes (HideHousePreview)', () => {
    install();
    const db = loadDatabase(addons);
    delete db.addons.Stats.fileStamps;
    saveDatabase(db, addons);
    writeMarkerFile(addons, 'Stats', db.addons.Stats);
    fs.unlinkSync(file('lang/en.lua'));

    cacheRelease();
    const [r] = adoptCachedRelease(addons, [{ folderName: 'Stats', zipName: releaseZipName(stats), notBefore: 0, mode: 'stamp' }]);
    expect(r).toMatchObject({ outcome: 'stamped', modified: 0, missing: 1 });
    const [a] = scanAddonsFolder(addons);
    expect(a.modifiedFiles).toBeUndefined();
    expect(a.missingFiles).toEqual(['lang/en.lua']);
  });
});
