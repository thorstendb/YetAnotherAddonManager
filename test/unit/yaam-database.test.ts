import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeMarkerFile, readMarkerFile, loadDatabase, saveDatabase, YaamAddonEntry } from '../../electron/yaamDatabase';
import { scanAddonsFolder } from '../../electron/addonScanner';

/**
 * Hardening invariants:
 *  1. The central DB (yaam-addons.json) is a DISPOSABLE CACHE — every tracking
 *     field survives in the per-folder .yaam.json markers and is restored by
 *     the next scan.  Deleting the DB is lossless.
 *  2. Stale DB entries (folder gone) are removed on scan, so a later addon
 *     reusing the folder name can never inherit a foreign identity.
 */
let tmpRoot: string;
let addonsPath: string;

function writeAddon(name: string, version = '1.0'): void {
  const dir = path.join(addonsPath, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.txt`), `## Title: ${name}\n## Version: ${version}\n\n${name}.lua\n`, 'utf-8');
}

function fullEntry(overrides: Partial<YaamAddonEntry> = {}): YaamAddonEntry {
  return {
    esouid: '1605',
    url: 'https://www.esoui.com/downloads/info1605-WritWorthy.html',
    catalogName: 'WritWorthy',
    catalogAuthor: 'ziggr',
    catalogVersion: '7.5.6',
    catalogDate: 1770000000,
    localVersion: '7.5.6',
    installedAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    installedFiles: ['WritWorthy.txt', 'WritWorthy.lua', 'Libs/LibFoo/LibFoo.lua'],
    overlays: [{
      esouid: '2855',
      catalogName: 'WritWorthy.LangPatch',
      catalogVersion: '2.1.5',
      catalogDate: 1771000000,
      installedAt: '2026-07-02T11:00:00.000Z',
      updatedAt: '2026-07-02T11:00:00.000Z',
      installedFiles: ['lang/ru.lua'],
      needsReapply: false,
    }],
    ...overrides,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-db-'));
  addonsPath = path.join(tmpRoot, 'live', 'AddOns');
  fs.mkdirSync(addonsPath, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('marker round-trip (hardening 1)', () => {
  it('persists every tracking field including installedFiles and overlays', () => {
    writeAddon('WritWorthy', '7.5.6');
    const entry = fullEntry();
    writeMarkerFile(addonsPath, 'WritWorthy', entry);

    const marker = readMarkerFile(addonsPath, 'WritWorthy');
    expect(marker).not.toBeNull();
    expect(marker!.esouid).toBe('1605');
    expect(marker!.catalogVersion).toBe('7.5.6');
    expect(marker!.catalogDate).toBe(1770000000);
    expect(marker!.localVersion).toBe('7.5.6');
    expect(marker!.installedFiles).toEqual(['WritWorthy.txt', 'WritWorthy.lua', 'Libs/LibFoo/LibFoo.lua']);
    expect(marker!.overlays).toHaveLength(1);
    expect(marker!.overlays![0].esouid).toBe('2855');
  });

  it('reconstructs the DB entry from the marker after DB loss (lossless delete)', () => {
    writeAddon('WritWorthy', '7.5.6');
    writeMarkerFile(addonsPath, 'WritWorthy', fullEntry());
    // No yaam-addons.json exists — simulate a deleted/lost central DB

    const addons = scanAddonsFolder(addonsPath);
    const ww = addons.find((a) => a.folderName === 'WritWorthy');
    expect(ww?.yaamMeta?.esouid).toBe('1605');
    expect(ww?.yaamMeta?.catalogVersion).toBe('7.5.6');
    expect(ww?.yaamMeta?.installedFiles).toEqual(['WritWorthy.txt', 'WritWorthy.lua', 'Libs/LibFoo/LibFoo.lua']);
    expect(ww?.yaamMeta?.overlays?.[0]?.esouid).toBe('2855');
    // runtimeFiles detection works right away from the restored install
    // manifest — and YAAM's own .yaam.json marker is not reported as one
    expect(ww?.runtimeFiles).toBeUndefined();
    // And the rebuilt central DB was persisted
    const db = loadDatabase(addonsPath);
    expect(db.addons['WritWorthy']?.installedFiles).toHaveLength(3);
    expect(db.addons['WritWorthy']?.overlays).toHaveLength(1);
  });

  it('upgrades pre-existing markers without installedFiles once the DB has them', () => {
    writeAddon('OldTimer', '2.0');
    // Old-style marker: no installedFiles field
    const old = fullEntry({ esouid: '99', catalogName: 'OldTimer', catalogVersion: '2.0', localVersion: '2.0', installedFiles: undefined, overlays: undefined });
    writeMarkerFile(addonsPath, 'OldTimer', old);
    // Central DB knows the installedFiles (recorded at install time)
    const db = loadDatabase(addonsPath);
    db.addons['OldTimer'] = { ...old, installedFiles: ['OldTimer.txt', 'OldTimer.lua'] };
    saveDatabase(db, addonsPath);

    scanAddonsFolder(addonsPath);

    const marker = readMarkerFile(addonsPath, 'OldTimer');
    expect(marker!.installedFiles).toEqual(['OldTimer.txt', 'OldTimer.lua']);
  });
});

describe('stale-entry cleanup (hardening 2)', () => {
  it('removes DB entries whose folder is gone', () => {
    writeAddon('Alive', '1.0');
    const db = loadDatabase(addonsPath);
    db.addons['Alive'] = fullEntry({ esouid: '1', catalogName: 'Alive', overlays: undefined });
    db.addons['Ghost'] = fullEntry({ esouid: '2', catalogName: 'Ghost', overlays: undefined });
    saveDatabase(db, addonsPath);

    scanAddonsFolder(addonsPath);

    const after = loadDatabase(addonsPath);
    expect(after.addons['Alive']).toBeDefined();
    expect(after.addons['Ghost']).toBeUndefined();
  });

  it('keeps entries for folders that exist but have no parseable manifest', () => {
    writeAddon('Alive', '1.0');
    fs.mkdirSync(path.join(addonsPath, 'BrokenButPresent'), { recursive: true });
    const db = loadDatabase(addonsPath);
    db.addons['BrokenButPresent'] = fullEntry({ esouid: '3', catalogName: 'Broken', overlays: undefined });
    saveDatabase(db, addonsPath);

    scanAddonsFolder(addonsPath);

    expect(loadDatabase(addonsPath).addons['BrokenButPresent']).toBeDefined();
  });

  it('never wipes the DB when the scan finds no addons (wrong/empty folder)', () => {
    // Note: no addon folders created at all
    const db = loadDatabase(addonsPath);
    db.addons['Precious'] = fullEntry({ esouid: '4', catalogName: 'Precious', overlays: undefined });
    saveDatabase(db, addonsPath);

    scanAddonsFolder(addonsPath);

    expect(loadDatabase(addonsPath).addons['Precious']).toBeDefined();
  });

  it('a restored folder (with marker) gets its entry back after cleanup — lossless round trip', () => {
    // 1. Addon tracked, then folder removed → entry cleaned up
    writeAddon('Roamer', '1.2');
    writeMarkerFile(addonsPath, 'Roamer', fullEntry({ esouid: '5', catalogName: 'Roamer', catalogVersion: '1.2', localVersion: '1.2', overlays: undefined }));
    writeAddon('Anchor', '1.0'); // keeps the scan non-empty
    scanAddonsFolder(addonsPath); // marker → DB
    expect(loadDatabase(addonsPath).addons['Roamer']).toBeDefined();

    const stash = path.join(tmpRoot, 'stash');
    fs.renameSync(path.join(addonsPath, 'Roamer'), stash);
    scanAddonsFolder(addonsPath);
    expect(loadDatabase(addonsPath).addons['Roamer']).toBeUndefined();

    // 2. Folder comes back (marker inside) → entry reconstructed
    fs.renameSync(stash, path.join(addonsPath, 'Roamer'));
    scanAddonsFolder(addonsPath);
    const restored = loadDatabase(addonsPath).addons['Roamer'];
    expect(restored?.esouid).toBe('5');
    expect(restored?.catalogVersion).toBe('1.2');
  });
});
