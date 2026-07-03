import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { backupTrackingState, restoreTrackingState, cleanupMarkerFiles, writeMarkerFile, readMarkerFile, loadDatabase, saveDatabase, YaamAddonEntry } from '../../electron/yaamDatabase';
import { commitBaseline, applyFolderHygiene, undoFolderHygiene, listRemovedEntries, restoreRemovedEntry, deleteAddon } from '../../electron/addonScanner';

/**
 * "Every action undoable" invariants:
 *  - baseline commit / marker cleanup are reversible via tracking-state backups
 *  - folder hygiene is reversible via its undo info
 *  - everything in Removed/ is listable and restorable (global Go-Back path)
 */
let tmpRoot: string;
let addonsPath: string;

function writeAddon(name: string, version = '1.0'): void {
  const dir = path.join(addonsPath, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.txt`), `## Title: ${name}\n## Version: ${version}\n\n${name}.lua\n`, 'utf-8');
}

function entryFor(name: string, ver: string): YaamAddonEntry {
  return {
    esouid: '42', url: '', catalogName: name, catalogAuthor: '',
    catalogVersion: ver, localVersion: ver,
    installedAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-undo-'));
  addonsPath = path.join(tmpRoot, 'live', 'AddOns');
  fs.mkdirSync(addonsPath, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('tracking-state backup / restore', () => {
  it('round-trips DB and markers (baseline commit is undoable)', () => {
    writeAddon('Foo', '1.0');
    writeMarkerFile(addonsPath, 'Foo', entryFor('Foo', '1.0'));
    const db = loadDatabase(addonsPath);
    db.addons['Foo'] = entryFor('Foo', '1.0');
    saveDatabase(db, addonsPath);

    // Baseline overwrites the anchors — with a tracking backup
    const res = commitBaseline(addonsPath, [{
      folderName: 'Foo', esouid: '42', url: '', name: 'Foo', author: '',
      catalogVersion: '2.0', catalogDate: 1780000000, localVersion: '1.0',
    }]);
    expect(res.trackingBackupDir).not.toBe('');
    expect(loadDatabase(addonsPath).addons['Foo'].catalogVersion).toBe('2.0');
    expect(readMarkerFile(addonsPath, 'Foo')!.catalogVersion).toBe('2.0');

    // Undo restores the pre-baseline state exactly
    const undo = restoreTrackingState(addonsPath, res.trackingBackupDir);
    expect(undo.restored).toBe(true);
    expect(loadDatabase(addonsPath).addons['Foo'].catalogVersion).toBe('1.0');
    expect(readMarkerFile(addonsPath, 'Foo')!.catalogVersion).toBe('1.0');
  });

  it('marker cleanup is undoable (markers come back, DB anchors restored)', () => {
    writeAddon('Bar', '3.1');
    writeMarkerFile(addonsPath, 'Bar', entryFor('Bar', '3.1'));
    const db = loadDatabase(addonsPath);
    db.addons['Bar'] = entryFor('Bar', '3.1');
    saveDatabase(db, addonsPath);

    const res = cleanupMarkerFiles(addonsPath);
    expect(res.count).toBe(1);
    expect(res.backupDir).not.toBe('');
    expect(readMarkerFile(addonsPath, 'Bar')).toBeNull();
    expect(loadDatabase(addonsPath).addons['Bar'].catalogVersion).toBe('');

    const undo = restoreTrackingState(addonsPath, res.backupDir);
    expect(undo.restored).toBe(true);
    expect(readMarkerFile(addonsPath, 'Bar')!.catalogVersion).toBe('3.1');
    expect(loadDatabase(addonsPath).addons['Bar'].catalogVersion).toBe('3.1');
  });

  it('removes markers created after the backup on restore (full state swap)', () => {
    writeAddon('Old', '1.0');
    const backupDir = backupTrackingState(addonsPath);
    // Marker appears AFTER the backup
    writeAddon('New', '1.0');
    writeMarkerFile(addonsPath, 'New', entryFor('New', '1.0'));

    restoreTrackingState(addonsPath, backupDir);
    expect(readMarkerFile(addonsPath, 'New')).toBeNull();
  });
});

describe('folder hygiene undo', () => {
  it('reverses repairs and removals completely', () => {
    // Broken install in the root + a Finder duplicate
    fs.writeFileSync(path.join(addonsPath, 'Stray.txt'), '## Title: Stray\n## Version: 1.0\n\nStray.lua\nui/ui.lua\n', 'utf-8');
    fs.writeFileSync(path.join(addonsPath, 'Stray.lua'), '', 'utf-8');
    fs.mkdirSync(path.join(addonsPath, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(addonsPath, 'ui', 'ui.lua'), '', 'utf-8');
    writeAddon('Host', '1.0');
    fs.mkdirSync(path.join(addonsPath, 'Host', 'core'), { recursive: true });
    fs.mkdirSync(path.join(addonsPath, 'Host', 'core 2'), { recursive: true });

    const res = applyFolderHygiene(addonsPath, { repairs: ['Stray.txt'], removals: ['Host/core 2'] });
    expect(res.repaired).toEqual(['Stray']);
    expect(res.removed).toEqual(['Host/core 2']);
    expect(fs.existsSync(path.join(addonsPath, 'Stray', 'Stray.txt'))).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'Host', 'core 2'))).toBe(false);

    const undo = undoFolderHygiene(addonsPath, res.undo);
    expect(undo.errors).toEqual([]);
    // Repair reversed: files back in the root, created folder gone
    expect(fs.existsSync(path.join(addonsPath, 'Stray.txt'))).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'ui', 'ui.lua'))).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'Stray'))).toBe(false);
    // Removal reversed: duplicate back in place
    expect(fs.existsSync(path.join(addonsPath, 'Host', 'core 2'))).toBe(true);
  });
});

describe('Removed/ listing and restore (global Go-Back path)', () => {
  it('lists deleted addons and restores them', () => {
    writeAddon('Doomed', '2.0');
    writeAddon('Anchor', '1.0');
    deleteAddon(addonsPath, 'Doomed');
    expect(fs.existsSync(path.join(addonsPath, 'Doomed'))).toBe(false);

    const entries = listRemovedEntries(addonsPath);
    const doomed = entries.find((e) => e.relPath === 'Doomed');
    expect(doomed).toBeDefined();
    expect(doomed!.isDirectory).toBe(true);
    expect(doomed!.fromHygiene).toBe(false);

    const res = restoreRemovedEntry(addonsPath, 'Doomed');
    expect(res.restored).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'Doomed', 'Doomed.txt'))).toBe(true);
  });

  it('lists hygiene captures with their original path and restores them there', () => {
    writeAddon('Host', '1.0');
    fs.mkdirSync(path.join(addonsPath, 'Host', 'lang 2'), { recursive: true });
    fs.writeFileSync(path.join(addonsPath, 'Host', 'lang 2', 'x.lua'), '', 'utf-8');
    const res = applyFolderHygiene(addonsPath, { repairs: [], removals: ['Host/lang 2'] });
    expect(res.removed).toEqual(['Host/lang 2']);

    const entries = listRemovedEntries(addonsPath);
    const captured = entries.find((e) => e.fromHygiene);
    expect(captured).toBeDefined();

    const restore = restoreRemovedEntry(addonsPath, captured!.relPath);
    expect(restore.restored).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'Host', 'lang 2', 'x.lua'))).toBe(true);
  });

  it('refuses to overwrite an existing target', () => {
    writeAddon('Twin', '1.0');
    deleteAddon(addonsPath, 'Twin');
    writeAddon('Twin', '2.0'); // reinstalled meanwhile
    const res = restoreRemovedEntry(addonsPath, 'Twin');
    expect(res.restored).toBe(false);
    expect(res.error).toContain('already exists');
  });
});
