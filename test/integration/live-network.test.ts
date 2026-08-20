// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Live end-to-end test against the real ESOUI/MMOUI endpoints.
 *
 * Covers the whole install path across the process boundary — catalog fetch
 * and CDN download in the main process, checksum check, extraction and
 * database registration in the filesystem worker.  Nothing else exercises that
 * seam end to end.
 *
 * Opt-in via YAAM_LIVE_TEST=1: it needs network and downloads a real (small)
 * addon, which has no business running on every `yarn test`.
 */
const workerJs = path.resolve(__dirname, '../../dist-electron/fsWorker.js');
const enabled = process.env.YAAM_LIVE_TEST === '1' && fs.existsSync(workerJs);

/** LibAddonMenu-2.0 — small, stable, and a dependency of half the ecosystem. */
const LIB_ADDON_MENU_UID = '7';

describe.skipIf(!enabled)('live ESOUI endpoints (YAAM_LIVE_TEST=1)', () => {
  let tmp: string;
  let api: typeof import('../../electron/addonCatalogApi');
  let callFs: typeof import('../../electron/fsWorkerHost').callFs;
  let shutdownFsWorker: typeof import('../../electron/fsWorkerHost').shutdownFsWorker;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-live-'));
    process.env.YAAM_FS_WORKER_PATH = workerJs;
    api = await import('../../electron/addonCatalogApi');
    const host = await import('../../electron/fsWorkerHost');
    callFs = host.callFs;
    shutdownFsWorker = host.shutdownFsWorker;
  });

  afterAll(() => {
    shutdownFsWorker?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fetches the category list', async () => {
    const cats = await api.fetchCategories();
    expect(cats.length).toBeGreaterThan(10);
    expect(cats[0]).toHaveProperty('name');
  }, 60_000);

  it('fetches the addon catalog', async () => {
    const list = await api.fetchAddonCatalog(true);
    expect(list.length).toBeGreaterThan(1000);
    const lam = list.find((a) => a.id === LIB_ADDON_MENU_UID);
    expect(lam?.name).toBe('LibAddonMenu-2.0');
    // Guards the UIDate ms→s normalisation: a plausible epoch in seconds.
    expect(lam!.date).toBeGreaterThan(1_000_000_000);
    expect(lam!.date).toBeLessThan(4_000_000_000);
  }, 180_000);

  it('fetches addon details with a usable download URL and checksum', async () => {
    const d = await api.fetchAddonDetails(LIB_ADDON_MENU_UID);
    expect(d.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(d.downloadUrl).toMatch(/^https:\/\//);
  }, 60_000);

  it('downloads and installs a real addon, then reuses the cached ZIP', async () => {
    const addons = path.join(tmp, 'live', 'AddOns');
    fs.mkdirSync(addons, { recursive: true });

    const phases: string[] = [];
    const result = await api.installAddon(LIB_ADDON_MENU_UID, addons, (phase) => {
      if (phases[phases.length - 1] !== phase) phases.push(phase);
    });

    expect(result.installed).toContain('LibAddonMenu-2.0');
    expect(phases).toEqual(['resolving', 'downloading', 'extracting']);
    // ESO accepts either extension and LibAddonMenu ships .addon — asserting
    // on .txt alone would fail on a perfectly good install.
    const dir = path.join(addons, 'LibAddonMenu-2.0');
    const hasManifest = fs.existsSync(path.join(dir, 'LibAddonMenu-2.0.addon'))
      || fs.existsSync(path.join(dir, 'LibAddonMenu-2.0.txt'));
    expect(hasManifest).toBe(true);
    // The per-folder marker is what makes tracking survive a lost database.
    expect(fs.existsSync(path.join(dir, '.yaam.json'))).toBe(true);

    // Identity recorded by the worker — this is what update detection reads.
    const entries = await callFs('getAllEntries', [addons]);
    expect(entries['LibAddonMenu-2.0'].esouid).toBe(LIB_ADDON_MENU_UID);

    // Second install must reuse the verified ZIP instead of downloading again.
    const second: string[] = [];
    await api.installAddon(LIB_ADDON_MENU_UID, addons, (phase, percent) => {
      if (phase === 'downloading' && percent === 100) second.push('cache-hit');
    });
    expect(second).toContain('cache-hit');
  }, 180_000);
});
