// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * End-to-end cover for the filesystem worker.
 *
 * The point of the worker is recoverability: YAAM's scan code is synchronous,
 * and a blocking syscall cannot be cancelled from JavaScript.  Inside a worker
 * it can at least be abandoned, so a stuck AddOns folder (OneDrive "Files
 * On-Demand", dead network share) produces an error instead of a permanent
 * "Scanning…".
 *
 * A FIFO is used to reproduce a blocking read faithfully: readFileSync() on
 * one never returns until somebody writes, exactly like a file the cloud
 * provider refuses to hydrate.
 */
const workerJs = path.resolve(__dirname, '../../dist-electron/fsWorker.js');
const isBuilt = fs.existsSync(workerJs);
const supportsFifo = process.platform !== 'win32';

describe.skipIf(!isBuilt)('fsWorker (requires `yarn build`)', () => {
  let tmp: string;
  let callFs: typeof import('../../electron/fsWorkerHost').callFs;
  let shutdownFsWorker: typeof import('../../electron/fsWorkerHost').shutdownFsWorker;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-fsworker-'));
    process.env.YAAM_FS_WORKER_PATH = workerJs;
    const host = await import('../../electron/fsWorkerHost');
    callFs = host.callFs;
    shutdownFsWorker = host.shutdownFsWorker;
  });

  afterAll(() => {
    shutdownFsWorker?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('scans a normal AddOns folder', async () => {
    const addons = path.join(tmp, 'ok', 'AddOns');
    fs.mkdirSync(path.join(addons, 'GoodAddon'), { recursive: true });
    fs.writeFileSync(path.join(addons, 'GoodAddon', 'GoodAddon.txt'), '## Title: Good\n## Version: 1.0\n');

    const result = await callFs('scanAddons', [addons]);
    expect(result.map((a) => a.folderName)).toEqual(['GoodAddon']);
  });

  it.skipIf(!supportsFifo)('aborts a scan blocked in a syscall, and recovers afterwards', async () => {
    const addons = path.join(tmp, 'stuck', 'AddOns');
    fs.mkdirSync(path.join(addons, 'StuckAddon'), { recursive: true });
    // A manifest that can be opened but never read to completion.
    execFileSync('mkfifo', [path.join(addons, 'StuckAddon', 'StuckAddon.txt')]);

    await expect(callFs('scanAddons', [addons], 2000)).rejects.toThrow(/did not finish within 2s/);

    // The worker was terminated — the next call must transparently get a new
    // one, otherwise a single bad folder would break YAAM until restart.
    const healthy = path.join(tmp, 'ok', 'AddOns');
    const result = await callFs('scanAddons', [healthy]);
    expect(result.map((a) => a.folderName)).toEqual(['GoodAddon']);
  }, 15_000);

  it('reports errors from the worker instead of hanging', async () => {
    await expect(callFs('scanAddons', [path.join(tmp, 'does-not-exist')]))
      .rejects.toThrow(/AddOns folder not found/);
  });
  it('runs read-only operations across the boundary', async () => {
    const addons = path.join(tmp, 'ok', 'AddOns');
    // Structured cloning has to survive these round trips, not just scanAddons.
    await expect(callFs('getAllEntries', [addons])).resolves.toBeDefined();
    await expect(callFs('listSnapshots', [addons])).resolves.toBeInstanceOf(Array);
    await expect(callFs('previewFolderHygiene', [addons])).resolves.toBeDefined();
  });

  it('installs an addon from a ZIP and records it (stage 3 path)', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const addons = path.join(tmp, 'install', 'AddOns');
    fs.mkdirSync(addons, { recursive: true });

    const zip = new AdmZip();
    zip.addFile('ZipAddon/ZipAddon.txt', Buffer.from('## Title: Zipped\n## Version: 2.5\n'));
    zip.addFile('ZipAddon/main.lua', Buffer.from('-- code\n'));
    const zipPath = path.join(tmp, 'ZipAddon.zip');
    zip.writeZip(zipPath);

    const catalogEntry = {
      id: '4711', categoryId: '1', name: 'ZipAddon', author: 'tester', version: '2.5',
      date: 0, infoUrl: 'https://www.esoui.com/downloads/info4711-ZipAddon.html',
      totalDownloads: 0, monthlyDownloads: 0, favorites: 0, compatibility: [],
      directories: ['ZipAddon'], thumbnails: [], images: [], donationLink: '',
    };

    const result = await callFs('extractAndRegister', [zipPath, addons, catalogEntry, undefined]);
    expect(result.installed).toEqual(['ZipAddon']);

    // Files on disk …
    expect(fs.existsSync(path.join(addons, 'ZipAddon', 'ZipAddon.txt'))).toBe(true);
    // … and identity recorded, so update detection works afterwards.
    const entries = await callFs('getAllEntries', [addons]);
    expect(entries['ZipAddon'].esouid).toBe('4711');
    expect(entries['ZipAddon'].catalogVersion).toBe('2.5');
  });

  it('reuses a cached ZIP only when the checksum matches', async () => {
    const addons = path.join(tmp, 'cache', 'AddOns');
    fs.mkdirSync(addons, { recursive: true });

    const fresh = await callFs('prepareDownload', [addons, 'Nothing-1.0.zip', 'deadbeef']);
    expect(fresh.cachedValid).toBe(false); // nothing cached yet

    fs.writeFileSync(fresh.zipPath, 'payload');
    const md5 = (await import('crypto')).createHash('md5').update('payload').digest('hex');
    expect((await callFs('prepareDownload', [addons, 'Nothing-1.0.zip', md5])).cachedValid).toBe(true);
    // Wrong checksum: must be rejected AND the stale file dropped.
    expect((await callFs('prepareDownload', [addons, 'Nothing-1.0.zip', 'deadbeef'])).cachedValid).toBe(false);
    expect(fs.existsSync(fresh.zipPath)).toBe(false);
  });
});
