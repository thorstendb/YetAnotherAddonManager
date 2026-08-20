// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canEnterDir, MAX_WALK_DEPTH } from '../../electron/shared/fsWalk';
import { getDirSize } from '../../electron/snapshotManager';

/**
 * Regression cover for the walk guards.
 *
 * Every recursive walk in YAAM is synchronous and runs in the Electron main
 * process: a directory cycle wedges the process, IPC and all, and the UI
 * stays in "Scanning…" with no way out.  A copying walk additionally fills
 * the disk.  These tests pin the guard that prevents that.
 */
describe('fsWalk guards', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-walk-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('allows a normal directory once', () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir);
    const visited = new Set<string>();
    expect(canEnterDir(dir, 0, visited)).toBe(true);
  });

  it('refuses to enter the same directory twice', () => {
    const dir = path.join(tmp, 'twice');
    fs.mkdirSync(dir);
    const visited = new Set<string>();
    expect(canEnterDir(dir, 0, visited)).toBe(true);
    expect(canEnterDir(dir, 1, visited)).toBe(false);
  });

  it('detects a cycle reached through a different path (the junction case)', () => {
    // A Windows junction reports isDirectory() === true and
    // isSymbolicLink() === false, so identity must come from realpath —
    // skipping symlinks alone would not catch it.
    const real = path.join(tmp, 'target');
    const link = path.join(tmp, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, 'dir');

    const visited = new Set<string>();
    expect(canEnterDir(real, 0, visited)).toBe(true);
    // Different path string, same directory — must be refused.
    expect(canEnterDir(link, 1, visited)).toBe(false);
  });

  it('stops at the depth limit', () => {
    const dir = path.join(tmp, 'deep');
    fs.mkdirSync(dir, { recursive: true });
    expect(canEnterDir(dir, MAX_WALK_DEPTH, new Set())).toBe(true);
    expect(canEnterDir(dir, MAX_WALK_DEPTH + 1, new Set())).toBe(false);
  });

  it('refuses unreadable or missing paths instead of throwing', () => {
    expect(canEnterDir(path.join(tmp, 'does-not-exist'), 0, new Set())).toBe(false);
  });

  it('getDirSize terminates on a symlink cycle', () => {
    // self/loop -> self : an unguarded walk never returns here.
    const self = path.join(tmp, 'self');
    fs.mkdirSync(self);
    fs.writeFileSync(path.join(self, 'a.txt'), 'hello');
    fs.symlinkSync(self, path.join(self, 'loop'), 'dir');

    const size = getDirSize(self);
    expect(size).toBe(5); // counts a.txt once, does not follow the cycle
  });
});
