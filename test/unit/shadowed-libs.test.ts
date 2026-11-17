// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findBundledLibs } from '../../electron/addonScanner';

/**
 * Libraries an addon loads from its OWN manifest file list while the same
 * library is also installed standalone.
 *
 * Reported from the wild: ExecuteNow 0.2 (2018) ships LibAddonMenu-2.0 under
 * libs/ and lists its lua files in ExecuteNow.txt.  The copy registers through
 * LibStub with version -1 (an unsubstituted `_LAM2_VERSION_NUMBER`), while the
 * standalone r43 registers a plain global — so the current library cannot
 * initialize its handlers.  No second addon exists for a sub-addon scan to
 * find, which is why this had to be hand-searched.
 */
describe('findBundledLibs — copies loaded through the host file list', () => {
  let tmp: string;
  let addons: string;

  const manifest = (dir: string, name: string, headers: Record<string, string>, files: string[] = []) => {
    fs.mkdirSync(dir, { recursive: true });
    const head = Object.entries(headers).map(([k, v]) => `## ${k}: ${v}`).join('\n');
    fs.writeFileSync(path.join(dir, `${name}.txt`), `${head}\n\n${files.join('\n')}\n`);
  };

  /** The standalone, current LibAddonMenu-2.0 */
  const standaloneLam = () =>
    manifest(path.join(addons, 'LibAddonMenu-2.0'), 'LibAddonMenu-2.0', {
      Title: 'LibAddonMenu-2.0', Version: '2.0 r43', AddOnVersion: '43', IsLibrary: 'true',
    });

  /** ExecuteNow's shape: file list loads libs/LibAddonMenu-2.0/… */
  const executeNow = (opts: { strayManifest?: boolean; libStub?: boolean } = {}) => {
    const root = path.join(addons, 'ExecuteNow');
    manifest(root, 'ExecuteNow', {
      Title: 'ExecuteNow', Version: '0.2', APIVersion: '100023',
      OptionalDependsOn: 'LibAddonMenu-2.0',
    }, [
      '; see http://www.esoui.com/downloads/info7-LibAddonMenu.html',
      'libs\\LibStub\\LibStub.lua',
      'libs\\LibAddonMenu-2.0\\LibAddonMenu-2.0.lua',
      'libs\\LibAddonMenu-2.0\\controls\\panel.lua',
      'ExecuteNow.lua',
    ]);
    const libDir = path.join(root, 'libs', 'LibAddonMenu-2.0');
    fs.mkdirSync(path.join(libDir, 'controls'), { recursive: true });
    fs.writeFileSync(
      path.join(libDir, 'LibAddonMenu-2.0.lua'),
      opts.libStub === false
        ? 'local lam = {}\n'
        : 'local MAJOR, MINOR = "LibAddonMenu-2.0", _LAM2_VERSION_NUMBER or -1\n'
          + 'local lam, oldminor = LibStub:NewLibrary(MAJOR, MINOR)\n'
    );
    if (opts.strayManifest) {
      // The real archive leaves LAM's own manifest beside the folder, with
      // placeholders the author's build never substituted
      fs.writeFileSync(
        path.join(root, 'libs', 'LibAddonMenu-2.0.txt'),
        '## Title: LibAddonMenu-2.0\n## Version: 2.0 rVERSION_NUMBER\n## AddOnVersion: VERSION_NUMBER\n'
      );
    }
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-shadow-'));
    addons = path.join(tmp, 'AddOns');
    fs.mkdirSync(addons, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds the ExecuteNow case a sub-addon scan walks past', () => {
    standaloneLam();
    executeNow({ strayManifest: true });

    const [report, ...rest] = findBundledLibs(addons);
    expect(rest).toEqual([]);
    expect(report.name).toBe('LibAddonMenu-2.0');
    expect(report.standaloneVersion).toBe('2.0 r43');
    expect(report.embedded).toHaveLength(1);

    const copy = report.embedded[0];
    expect(copy.parent).toBe('ExecuteNow');
    expect(copy.relPath).toBe(path.join('ExecuteNow', 'libs', 'LibAddonMenu-2.0'));
    expect(copy.viaFileList).toBe(true);
    // The placeholder manifest yields no usable version
    expect(copy.versionUnknown).toBe(true);
    // …which must not be waved through as "same version"
    expect(report.versionMismatch).toBe(true);
    expect(report.standaloneOutdated).toBe(false);
  });

  it('flags the unsubstituted version placeholder as the confirmed-broken pattern', () => {
    standaloneLam();
    executeNow({ strayManifest: true });
    const report = findBundledLibs(addons)[0];
    expect(report.embedded[0].usesLibStub).toBe(true);
    expect(report.embedded[0].placeholderVersion).toBe(true);
    expect(report.brokenRegistration).toBe(true);
  });

  // ── Calibration against a real 147-addon install ──────────────────────────
  // The first version of this detector raised three findings there; checking
  // each by hand showed one false alarm and one wrong "version unreadable".

  /** A host bundling a library via its file list, with a given entry lua */
  const bundleWith = (host: string, lib: string, lua: string) => {
    const root = path.join(addons, host);
    manifest(root, host, { Title: host, Version: '1.0' }, [`lib\\${lib}\\${lib}.lua`, `${host}.lua`]);
    fs.mkdirSync(path.join(root, 'lib', lib), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', lib, `${lib}.lua`), lua);
  };

  it('never reports LibStub itself — multiple copies are what it exists for', () => {
    manifest(path.join(addons, 'LibStub'), 'LibStub', { Title: 'LibStub', Version: '1.0 r7', AddOnVersion: '7' });
    // LibStub.lua DEFINES NewLibrary; a loose pattern would also call that "uses LibStub"
    bundleWith('HideHousePreview', 'LibStub',
      'local LIBSTUB_MAJOR, LIBSTUB_MINOR = "LibStub", 4\nfunction LibStub:NewLibrary(major, minor)\nend\n');
    expect(findBundledLibs(addons)).toEqual([]);
  });

  it('reads the version from the LibStub registration instead of calling it unreadable', () => {
    standaloneLam();
    // HideHousePreview's real copy: a proper version, no placeholder
    bundleWith('HideHousePreview', 'LibAddonMenu-2.0',
      'local MAJOR, MINOR = "LibAddonMenu-2.0", 25\nlocal lam, oldminor = LibStub:NewLibrary(MAJOR, MINOR)\n');

    const report = findBundledLibs(addons)[0];
    const copy = report.embedded[0];
    expect(copy.versionUnknown).toBe(false);
    expect(copy.addonVersion).toBe(25);
    expect(copy.versionFromLibStub).toBe(true);
    expect(copy.placeholderVersion).toBe(false);
    // Two copies, differing — but a real version is not the broken pattern
    expect(report.versionMismatch).toBe(true);
    expect(report.brokenRegistration).toBe(false);
  });

  it('never claims the standalone is outdated from a LibStub minor', () => {
    // A date-style minor dwarfs `AddOnVersion: 19` without being newer.
    // Trusting the direction would raise the loudest alarm on a guess.
    manifest(path.join(addons, 'LibFoodDrinkBuff'), 'LibFoodDrinkBuff', {
      Title: 'LibFoodDrinkBuff', Version: '19', AddOnVersion: '19', IsLibrary: 'true',
    });
    bundleWith('RaidTools', 'LibFoodDrinkBuff', 'local lib = LibStub:NewLibrary(LIB_IDENTIFIER, 20200101)\n');

    const report = findBundledLibs(addons)[0];
    expect(report.versionMismatch).toBe(true);
    expect(report.standaloneOutdated).toBe(false);
  });

  it('treats an equal LibStub minor as the same version', () => {
    standaloneLam();
    bundleWith('SomeHost', 'LibAddonMenu-2.0', 'local lam = LibStub:NewLibrary("LibAddonMenu-2.0", 43)\n');
    const report = findBundledLibs(addons)[0];
    expect(report.versionMismatch).toBe(false);
  });

  it('still finds a bundle that ships no manifest at all', () => {
    standaloneLam();
    executeNow({ strayManifest: false });
    const report = findBundledLibs(addons)[0];
    expect(report.embedded[0].viaFileList).toBe(true);
    expect(report.embedded[0].versionUnknown).toBe(true);
  });

  it('says nothing when the bundled library is not installed standalone', () => {
    executeNow({ strayManifest: true });
    expect(findBundledLibs(addons)).toEqual([]);
  });

  it('does not flag a host loading files from its own folders', () => {
    manifest(path.join(addons, 'SoloAddon'), 'SoloAddon', { Title: 'Solo', Version: '1.0' }, [
      'modules\\Combat\\combat.lua',
      'SoloAddon.lua',
    ]);
    fs.mkdirSync(path.join(addons, 'SoloAddon', 'modules', 'Combat'), { recursive: true });
    expect(findBundledLibs(addons)).toEqual([]);
  });

  it('reports a sub-addon bundle and a file-list bundle of the same lib once', () => {
    standaloneLam();
    executeNow({ strayManifest: true });
    // A second host, bundling LAM the other way: as a real sub-addon
    manifest(path.join(addons, 'OtherAddon'), 'OtherAddon', { Title: 'Other', Version: '1.0' });
    manifest(path.join(addons, 'OtherAddon', 'Libs', 'LibAddonMenu-2.0'), 'LibAddonMenu-2.0', {
      Title: 'LibAddonMenu-2.0', Version: '2.0 r41', AddOnVersion: '41', IsLibrary: 'true',
    });

    const reports = findBundledLibs(addons);
    expect(reports).toHaveLength(1);
    expect(reports[0].embedded.map((e) => e.parent).sort()).toEqual(['ExecuteNow', 'OtherAddon']);
    // r41 < r43, so the standalone is current — but the versions still differ
    expect(reports[0].standaloneOutdated).toBe(false);
    expect(reports[0].versionMismatch).toBe(true);
  });
});
