// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectCloudProvider } from '../../electron/cloudDetect';

describe('detectCloudProvider', () => {
  let home: string;

  beforeAll(() => {
    // Fake home with an iCloud Desktop&Documents mirror and a Dropbox folder
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-home-'));
    fs.mkdirSync(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Library', 'CloudStorage', 'OneDrive-Personal', 'Games'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Dropbox', 'ESO'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Documents', 'Elder Scrolls Online', 'live', 'AddOns'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Games', 'ESO'), { recursive: true });
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  it('detects the iCloud Desktop & Documents mirror', () => {
    const p = path.join(home, 'Documents', 'Elder Scrolls Online', 'live', 'AddOns');
    expect(detectCloudProvider(p, home)).toBe('iCloud Drive (Desktop & Documents sync)');
  });

  it('detects direct Mobile Documents paths', () => {
    const p = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents');
    expect(detectCloudProvider(p, home)).toBe('iCloud Drive');
  });

  it('detects CloudStorage providers by mount name', () => {
    const p = path.join(home, 'Library', 'CloudStorage', 'OneDrive-Personal', 'Games');
    expect(detectCloudProvider(p, home)).toBe('OneDrive');
  });

  it('detects Dropbox', () => {
    expect(detectCloudProvider(path.join(home, 'Dropbox', 'ESO'), home)).toBe('Dropbox');
  });

  it('returns null for a plain local path', () => {
    expect(detectCloudProvider(path.join(home, 'Games', 'ESO'), home)).toBeNull();
  });

  it('does not flag Documents when no iCloud mirror exists', () => {
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-home2-'));
    const p = path.join(home2, 'Documents', 'x');
    fs.mkdirSync(p, { recursive: true });
    expect(detectCloudProvider(p, home2)).toBeNull();
    fs.rmSync(home2, { recursive: true, force: true });
  });
});
