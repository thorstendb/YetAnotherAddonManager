// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic, writeJsonAtomic } from '../../electron/shared/atomicWrite';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-atomic-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes new files and replaces existing ones', () => {
    const p = path.join(dir, 'AddOnSettings.txt');
    writeFileAtomic(p, 'first');
    expect(fs.readFileSync(p, 'utf-8')).toBe('first');
    writeFileAtomic(p, 'second');
    expect(fs.readFileSync(p, 'utf-8')).toBe('second');
  });

  it('leaves no temp file behind', () => {
    writeFileAtomic(path.join(dir, 'x.txt'), 'data');
    expect(fs.readdirSync(dir)).toEqual(['x.txt']);
  });

  it('replaces via rename — the target is never observed truncated', () => {
    const p = path.join(dir, 'big.txt');
    fs.writeFileSync(p, 'x'.repeat(200_000));
    const inodeBefore = fs.statSync(p).ino;
    writeFileAtomic(p, 'y'.repeat(200_000));
    // A fresh inode proves the file was swapped in, not truncated and refilled
    // in place — that in-place window is what produces cloud conflict copies.
    expect(fs.statSync(p).ino).not.toBe(inodeBefore);
    expect(fs.readFileSync(p, 'utf-8').startsWith('yyy')).toBe(true);
  });

  it('scatters nothing outside the target directory', () => {
    // The temp file must be created next to the target (a cross-filesystem
    // rename would not be atomic).  Observable consequence: writing into a
    // subdirectory leaves neither the parent nor the subdirectory polluted.
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    writeFileAtomic(path.join(sub, 'file.txt'), 'data');
    expect(fs.readdirSync(sub)).toEqual(['file.txt']);
    expect(fs.readdirSync(dir)).toEqual(['sub']);
  });

  it('writes Buffers unchanged (SavedVariables imports)', () => {
    const p = path.join(dir, 'bin.lua');
    const buf = Buffer.from([0x00, 0xff, 0x10, 0x20]);
    writeFileAtomic(p, buf);
    expect(fs.readFileSync(p).equals(buf)).toBe(true);
  });

  it('does not leave a temp file when the write fails', () => {
    const p = path.join(dir, 'nonexistent-dir', 'x.txt');
    expect(() => writeFileAtomic(p, 'data')).toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writeJsonAtomic round-trips with stable formatting', () => {
    const p = path.join(dir, 'db.json');
    writeJsonAtomic(p, { schemaVersion: 1, addons: { A: { esouid: '7' } } });
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).addons.A.esouid).toBe('7');
    expect(fs.readFileSync(p, 'utf-8')).toContain('\n  '); // pretty-printed
  });
});
