import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { previewFolderHygiene, applyFolderHygiene } from '../../electron/addonScanner';

/**
 * Reproduces the real-world mess found in a live AddOns folder (2026-07):
 *  - ArchiveHelper extracted straight into the AddOns root (game never loads it)
 *  - a stale 2024 HodorReflexes root manifest shadowed by the proper folder
 *  - macOS Finder " 2" duplicates at root and inside addon folders
 */
let tmpRoot: string;
let addonsPath: string;

function write(rel: string, content = ''): void {
  const p = path.join(addonsPath, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-hygiene-'));
  addonsPath = path.join(tmpRoot, 'live', 'AddOns');
  fs.mkdirSync(addonsPath, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('previewFolderHygiene', () => {
  it('detects a broken install extracted into the AddOns root', () => {
    write('ArchiveHelper.txt', [
      '## Title: Archive Helper',
      '## Version: 1.3.5',
      '## AddOnVersion: 1305',
      '',
      'ArchiveHelper.lua',
      'ui/ui.lua',
      'data/abilities.lua',
      'languages/en.lua',
    ].join('\n'));
    write('ArchiveHelper.lua');
    write('ui/ui.lua');
    write('data/abilities.lua');
    write('languages/en.lua');
    write('README.md', '# readme');

    const p = previewFolderHygiene(addonsPath);
    expect(p.strayManifests).toHaveLength(1);
    const s = p.strayManifests[0];
    expect(s.addonName).toBe('ArchiveHelper');
    expect(s.folderExists).toBe(false);
    expect(s.version).toBe('1.3.5');
    // Claims the referenced root folders AND the same-basename sibling
    expect(s.relatedFiles).toEqual(expect.arrayContaining(['ArchiveHelper.lua', 'ui', 'data', 'languages']));
    // README is claimed by nothing
    expect(p.unclaimedRootFiles).toContain('README.md');
  });

  it('flags a stale root manifest when the proper folder is newer', () => {
    write('HodorReflexes.txt', [
      '## Title: HodorReflexes',
      '## Version: 2024.03.10',
      '## AddOnVersion: 20240310',
      '',
      'HodorReflexes.lua',
    ].join('\n'));
    write('HodorReflexes.lua');
    write('HodorReflexes/HodorReflexes.addon', [
      '## Title: HodorReflexes',
      '## Version: 2026.05.17',
      '## AddOnVersion: 20260517',
    ].join('\n'));

    const p = previewFolderHygiene(addonsPath);
    expect(p.strayManifests).toHaveLength(1);
    expect(p.strayManifests[0].folderExists).toBe(true);
    expect(p.strayManifests[0].rootIsStale).toBe(true);
    expect(p.strayManifests[0].folderVersion).toBe('2026.05.17');
  });

  it('detects Finder duplicates at root and nested levels', () => {
    write('HodorReflexes/HodorReflexes.txt', '## Title: HR\n## Version: 1.0');
    fs.mkdirSync(path.join(addonsPath, 'HodorReflexes', 'core'), { recursive: true });
    fs.mkdirSync(path.join(addonsPath, 'HodorReflexes', 'core 2'), { recursive: true });
    fs.mkdirSync(path.join(addonsPath, 'HodorReflexes 2'), { recursive: true });
    write('CombatMetronome/CombatMetronome.addon', '## Title: CM\n## Version: 1.7');
    write('CombatMetronome/CombatMetronome 3.addon', '## Title: CM\n## Version: 1.6');

    const p = previewFolderHygiene(addonsPath);
    const rels = p.duplicates.map((d) => d.relPath).sort();
    expect(rels).toEqual([
      'CombatMetronome/CombatMetronome 3.addon',
      'HodorReflexes 2',
      path.join('HodorReflexes', 'core 2'),
    ].sort());
  });

  it('does not flag " 2" names without an existing original', () => {
    fs.mkdirSync(path.join(addonsPath, 'SoloAddon 2'), { recursive: true });
    const p = previewFolderHygiene(addonsPath);
    expect(p.duplicates).toHaveLength(0);
  });

  it('ignores Minion tracking data and dotfiles', () => {
    write('miniondata.json', '[]');
    write('.DS_Store', 'junk');
    const p = previewFolderHygiene(addonsPath);
    expect(p.unclaimedRootFiles).toHaveLength(0);
  });
});

describe('applyFolderHygiene', () => {
  it('repairs a broken install by moving files into a proper folder', () => {
    write('ArchiveHelper.txt', [
      '## Title: Archive Helper',
      '## Version: 1.3.5',
      '',
      'ArchiveHelper.lua',
      'ui/ui.lua',
    ].join('\n'));
    write('ArchiveHelper.lua');
    write('ui/ui.lua');

    const res = applyFolderHygiene(addonsPath, { repairs: ['ArchiveHelper.txt'], removals: [] });
    expect(res.errors).toEqual([]);
    expect(res.repaired).toEqual(['ArchiveHelper']);
    expect(fs.existsSync(path.join(addonsPath, 'ArchiveHelper', 'ArchiveHelper.txt'))).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'ArchiveHelper', 'ArchiveHelper.lua'))).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'ArchiveHelper', 'ui', 'ui.lua'))).toBe(true);
    expect(fs.existsSync(path.join(addonsPath, 'ArchiveHelper.txt'))).toBe(false);
    expect(fs.existsSync(path.join(addonsPath, 'ui'))).toBe(false);
  });

  it('moves removals into Removed/_hygiene (never deletes)', () => {
    write('HodorReflexes/HodorReflexes.txt', '## Title: HR\n## Version: 2.0');
    fs.mkdirSync(path.join(addonsPath, 'HodorReflexes', 'core'), { recursive: true });
    write('HodorReflexes/core 2/x.lua');

    const res = applyFolderHygiene(addonsPath, { repairs: [], removals: ['HodorReflexes/core 2'] });
    expect(res.errors).toEqual([]);
    expect(res.removed).toEqual(['HodorReflexes/core 2']);
    expect(fs.existsSync(path.join(addonsPath, 'HodorReflexes', 'core 2'))).toBe(false);
    // Preserved under Removed/_hygiene/<stamp>/
    const hygieneRoot = path.join(tmpRoot, 'live', 'Removed', '_hygiene');
    const stamps = fs.readdirSync(hygieneRoot);
    expect(stamps).toHaveLength(1);
    expect(fs.existsSync(path.join(hygieneRoot, stamps[0], 'HodorReflexes', 'core 2', 'x.lua'))).toBe(true);
  });

  it('refuses path escapes in removals', () => {
    write('victim.txt', 'outside');
    const res = applyFolderHygiene(addonsPath, { repairs: [], removals: ['../victim-escape'] });
    expect(res.removed).toEqual([]);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('does not repair when a proper folder already exists', () => {
    write('Foo.txt', '## Title: Foo\n## Version: 1.0');
    write('Foo/Foo.txt', '## Title: Foo\n## Version: 2.0');
    const res = applyFolderHygiene(addonsPath, { repairs: ['Foo.txt'], removals: [] });
    expect(res.repaired).toEqual([]);
    expect(res.errors.length).toBe(1);
    expect(fs.existsSync(path.join(addonsPath, 'Foo.txt'))).toBe(true);
  });
});
