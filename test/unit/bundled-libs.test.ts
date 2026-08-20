// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findBundledLibs } from '../../electron/addonScanner';

/**
 * Cover for the bundled-library scanner.
 *
 * Measured against a real 144-addon install: 7 folders appear both standalone
 * and embedded, and exactly one of them (HarvestMap/Modules/HarvestMap) is the
 * author's own module layout rather than a conflict.  Both shapes are pinned
 * here so the scanner keeps telling them apart.
 */
describe('findBundledLibs', () => {
  let tmp: string;
  let addons: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-bundled-'));
    addons = path.join(tmp, 'AddOns');
    fs.mkdirSync(addons, { recursive: true });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** Write <dir>/<name>/<name>.txt with the given headers. */
  function addon(relDir: string, name: string, headers: Record<string, string>) {
    const dir = path.join(addons, relDir);
    fs.mkdirSync(dir, { recursive: true });
    const lines = Object.entries(headers).map(([k, v]) => `## ${k}: ${v}`);
    fs.writeFileSync(path.join(dir, `${name}.txt`), lines.join('\n') + '\n');
  }

  it('reports nothing when a library exists only standalone', () => {
    addon('LibFoo', 'LibFoo', { Title: 'LibFoo', Version: '1.0', AddOnVersion: '100', IsLibrary: 'true' });
    addon('SomeAddon', 'SomeAddon', { Title: 'Some', Version: '2.0' });
    expect(findBundledLibs(addons)).toEqual([]);
  });

  it('reports a library that is standalone and embedded elsewhere', () => {
    addon('LibFoo', 'LibFoo', { Title: 'LibFoo', Version: '1.0', AddOnVersion: '100', IsLibrary: 'true' });
    addon('Host', 'Host', { Title: 'Host', Version: '3.0' });
    addon('Host/libs/LibFoo', 'LibFoo', { Title: 'LibFoo', Version: '1.0', AddOnVersion: '100', IsLibrary: 'true' });

    const [r] = findBundledLibs(addons);
    expect(r.name).toBe('LibFoo');
    expect(r.embedded).toHaveLength(1);
    expect(r.embedded[0].parent).toBe('Host');
    expect(r.embedded[0].relPath).toBe(path.join('Host', 'libs', 'LibFoo'));
    expect(r.standaloneOutdated).toBe(false); // same version — informational
  });

  it('flags the damaging case: standalone older than the embedded copy', () => {
    addon('LibFoo', 'LibFoo', { Title: 'LibFoo', Version: '1.0.1', AddOnVersion: '101', IsLibrary: 'true' });
    addon('Host', 'Host', { Title: 'Host', Version: '3.0' });
    addon('Host/libs/LibFoo', 'LibFoo', { Title: 'LibFoo', Version: '1.0.2', AddOnVersion: '102', IsLibrary: 'true' });

    const [r] = findBundledLibs(addons);
    expect(r.standaloneOutdated).toBe(true);
    expect(r.standaloneAddonVersion).toBe(101);
    expect(r.embedded[0].addonVersion).toBe(102);
  });

  it('does not flag an author\'s own module layout (the HarvestMap shape)', () => {
    // HarvestMap/Modules/HarvestMap is deliberate structure, not bundling.
    addon('HarvestMap', 'HarvestMap', { Title: 'HarvestMap', Version: '3.15', AddOnVersion: '315999' });
    addon('HarvestMap/Modules/HarvestMap', 'HarvestMap', { Title: 'HarvestMap', Version: '3.16.12', AddOnVersion: '316012' });
    expect(findBundledLibs(addons)).toEqual([]);
  });

  it('collects every host when several addons embed the same library', () => {
    // Observed in the wild: LibExtendedJournal sits in three addons at once.
    addon('LibShared', 'LibShared', { Title: 'LibShared', Version: '2.5.3', AddOnVersion: '205030', IsLibrary: 'true' });
    for (const host of ['AddonA', 'AddonB', 'AddonC']) {
      addon(host, host, { Title: host, Version: '1.0' });
      addon(`${host}/LibShared`, 'LibShared', { Title: 'LibShared', Version: '2.5.3', AddOnVersion: '205030', IsLibrary: 'true' });
    }
    const [r] = findBundledLibs(addons);
    expect(r.embedded.map((e) => e.parent).sort()).toEqual(['AddonA', 'AddonB', 'AddonC']);
  });

  it('sorts the damaging cases first', () => {
    addon('LibOk', 'LibOk', { Title: 'LibOk', Version: '1.0', AddOnVersion: '100', IsLibrary: 'true' });
    addon('LibBad', 'LibBad', { Title: 'LibBad', Version: '1.0', AddOnVersion: '100', IsLibrary: 'true' });
    addon('Host', 'Host', { Title: 'Host', Version: '1.0' });
    addon('Host/LibOk', 'LibOk', { Title: 'LibOk', Version: '1.0', AddOnVersion: '100', IsLibrary: 'true' });
    addon('Host/LibBad', 'LibBad', { Title: 'LibBad', Version: '9.9', AddOnVersion: '999', IsLibrary: 'true' });

    const names = findBundledLibs(addons).map((r) => r.name);
    expect(names[0]).toBe('LibBad');
  });

  it('falls back to the version string when AddOnVersion is missing', () => {
    addon('LibNoNum', 'LibNoNum', { Title: 'LibNoNum', Version: '1.0.1', IsLibrary: 'true' });
    addon('Host', 'Host', { Title: 'Host', Version: '1.0' });
    addon('Host/LibNoNum', 'LibNoNum', { Title: 'LibNoNum', Version: '1.0.2', IsLibrary: 'true' });
    expect(findBundledLibs(addons)[0].standaloneOutdated).toBe(true);
  });
});
