// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { extractAndRegister } from '../../electron/addonFiles';
import { CatalogAddon } from '../../electron/shared/types';

/**
 * Cover for the differential/atomic install pipeline and its two cleanup
 * passes (cloud-conflict sweep, stale-file removal).
 *
 * Background: a cloud-synced AddOns folder (iCloud "Documents", OneDrive)
 * turns every unnecessary write into a chance for a conflict copy — a real
 * install accumulated 354 of them.  Measured on real ZIP pairs, ~75% of files
 * are unchanged between releases, so skipping them is the main defense.
 */
describe('extractAndRegister (differential)', () => {
  let tmp: string;
  let addons: string;

  const cat = (over: Partial<CatalogAddon> = {}): CatalogAddon => ({
    id: '42', categoryId: '1', name: 'TestAddon', author: 'x', version: '2.0',
    date: 0, infoUrl: '', totalDownloads: 0, monthlyDownloads: 0, favorites: 0,
    compatibility: [], directories: ['TestAddon'], thumbnails: [], images: [],
    donationLink: '', ...over,
  });

  const makeZip = (files: Record<string, string>): string => {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
    const p = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.zip`);
    zip.writeZip(p);
    return p;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-diff-'));
    addons = path.join(tmp, 'AddOns');
    fs.mkdirSync(addons, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('skips unchanged files and reports the count', () => {
    const zip1 = makeZip({
      'TestAddon/TestAddon.txt': '## Title: T\n## Version: 1.0\n',
      'TestAddon/stable.lua': '-- never changes\n',
    });
    extractAndRegister(zip1, addons, cat({ version: '1.0' }));
    const stableMtime = fs.statSync(path.join(addons, 'TestAddon', 'stable.lua')).mtimeMs;

    const zip2 = makeZip({
      'TestAddon/TestAddon.txt': '## Title: T\n## Version: 2.0\n',
      'TestAddon/stable.lua': '-- never changes\n',
    });
    const r = extractAndRegister(zip2, addons, cat());
    expect(r.unchanged).toBe(1); // stable.lua untouched
    // The untouched file keeps its mtime — proof it was not rewritten.
    expect(fs.statSync(path.join(addons, 'TestAddon', 'stable.lua')).mtimeMs).toBe(stableMtime);
    expect(fs.readFileSync(path.join(addons, 'TestAddon', 'TestAddon.txt'), 'utf-8')).toContain('2.0');
  });

  it('leaves no temp files behind', () => {
    const zip = makeZip({ 'TestAddon/TestAddon.txt': '## Title: T\n## Version: 1.0\n' });
    extractAndRegister(zip, addons, cat({ version: '1.0' }));
    const leftovers: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.includes('.yaamtmp')) leftovers.push(e.name);
      }
    };
    walk(addons);
    expect(leftovers).toEqual([]);
  });

  it('a crafted zip-slip archive cannot place files outside the AddOns folder', () => {
    // Raw ZIP built with Python's zipfile (adm-zip refuses to WRITE traversal
    // names, so a fixture is the only honest way to test the READ side).
    // Contains ../evil.txt and /abs/evil2.txt next to a normal entry.
    const ZIP_SLIP_B64 =
      'UEsDBBQAAAAAAGVsFF0hNNUFHAAAABwAAAAXAAAAVGVzdEFkZG9uL1Rlc3RBZGRvbi50eHQjIyBUaXRsZTogVAojIyBWZXJzaW9uOiAxLjAKUEsDBBQAAAAAAGVsFF1bDPiSBwAAAAcAAAALAAAALi4vZXZpbC50eHRlc2NhcGVkUEsDBBQAAAAAAGVsFF1bDPiSBwAAAAcAAAAOAAAAL2Ficy9ldmlsMi50eHRlc2NhcGVkUEsBAhQDFAAAAAAAZWwUXSE01QUcAAAAHAAAABcAAAAAAAAAAAAAAIABAAAAAFRlc3RBZGRvbi9UZXN0QWRkb24udHh0UEsBAhQDFAAAAAAAZWwUXVsM+JIHAAAABwAAAAsAAAAAAAAAAAAAAIABUQAAAC4uL2V2aWwudHh0UEsBAhQDFAAAAAAAZWwUXVsM+JIHAAAABwAAAA4AAAAAAAAAAAAAAIABgQAAAC9hYnMvZXZpbDIudHh0UEsFBgAAAAADAAMAugAAALQAAAAAAA==';
    const p = path.join(tmp, 'evil.zip');
    fs.writeFileSync(p, Buffer.from(ZIP_SLIP_B64, 'base64'));

    // Two acceptable outcomes: our validation throws, or adm-zip's read-side
    // sanitization neutralizes the names.  What must NEVER happen is a file
    // landing outside the AddOns folder.
    try { extractAndRegister(p, addons, null); } catch { /* rejected — fine */ }
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
    expect(fs.existsSync('/abs/evil2.txt')).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'AddOns', '..', 'evil.txt'))).toBe(false);
  });

  it('sweeps cloud conflict copies but keeps legitimately shipped " N" names', () => {
    // Pre-existing conflict copies from a previous sync collision …
    fs.mkdirSync(path.join(addons, 'TestAddon'), { recursive: true });
    fs.writeFileSync(path.join(addons, 'TestAddon', 'code.lua'), 'old');
    fs.writeFileSync(path.join(addons, 'TestAddon', 'code 2.lua'), 'conflict');
    fs.mkdirSync(path.join(addons, 'TestAddon 2'), { recursive: true });

    const zip = makeZip({
      'TestAddon/TestAddon.txt': '## Title: T\n## Version: 2.0\n',
      'TestAddon/code.lua': 'new',
      // This addon legitimately ships a " 2" name — must survive the sweep.
      'TestAddon/Icon 2.dds': 'texture',
      'TestAddon/Icon.dds': 'texture',
    });
    const r = extractAndRegister(zip, addons, cat());

    expect(r.conflictsSwept.sort()).toEqual(['TestAddon 2', 'TestAddon/code 2.lua']);
    expect(fs.existsSync(path.join(addons, 'TestAddon', 'code 2.lua'))).toBe(false);
    expect(fs.existsSync(path.join(addons, 'TestAddon 2'))).toBe(false);
    expect(fs.existsSync(path.join(addons, 'TestAddon', 'Icon 2.dds'))).toBe(true);

    // Moved, not deleted — restorable through the existing hygiene structure.
    const hygiene = path.join(tmp, 'Removed', '_hygiene');
    const stamps = fs.readdirSync(hygiene);
    expect(stamps).toHaveLength(1);
    const meta = JSON.parse(fs.readFileSync(path.join(hygiene, stamps[0], '_meta.json'), 'utf-8'));
    expect(meta.removals.sort()).toEqual(['TestAddon 2', 'TestAddon/code 2.lua']);
    expect(fs.existsSync(path.join(hygiene, stamps[0], 'TestAddon', 'code 2.lua'))).toBe(true);
  });

  it('removes files the new release no longer ships, protecting overlays and runtime files', () => {
    // v1 ships two modules; v2 drops one.
    const zip1 = makeZip({
      'TestAddon/TestAddon.txt': '## Title: T\n## Version: 1.0\n',
      'TestAddon/ModuleA.lua': 'a',
      'TestAddon/sub/ModuleB.lua': 'b',
    });
    extractAndRegister(zip1, addons, cat({ version: '1.0' }));
    // Runtime file appears between the versions (never in installedFiles).
    fs.writeFileSync(path.join(addons, 'TestAddon', 'user-notes.txt'), 'mine');

    const zip2 = makeZip({
      'TestAddon/TestAddon.txt': '## Title: T\n## Version: 2.0\n',
      'TestAddon/ModuleA.lua': 'a2',
    });
    const r = extractAndRegister(zip2, addons, cat());

    expect(r.staleRemoved).toEqual(['TestAddon/sub/ModuleB.lua']);
    expect(fs.existsSync(path.join(addons, 'TestAddon', 'sub'))).toBe(false); // empty dir pruned
    expect(fs.existsSync(path.join(addons, 'TestAddon', 'user-notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(addons, 'TestAddon', 'ModuleA.lua'))).toBe(true);
  });

  it('never removes stale files during an overlay install', () => {
    const zip1 = makeZip({
      'TestAddon/TestAddon.txt': '## Title: T\n## Version: 1.0\n',
      'TestAddon/Original.lua': 'orig',
    });
    extractAndRegister(zip1, addons, cat({ version: '1.0' }));

    // Overlay ships a different file set — must not trigger stale cleanup.
    const patch = makeZip({ 'TestAddon/lang.lua': 'patch' });
    const r = extractAndRegister(patch, addons, cat({ id: '99', name: 'LangPatch', version: '5.0' }), { overlayFor: 'TestAddon' });
    expect(r.staleRemoved).toEqual([]);
    expect(fs.existsSync(path.join(addons, 'TestAddon', 'Original.lua'))).toBe(true);
  });
});
