// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { parseMinionConfig } from '../../electron/minionData';
import { extractAndRegister, adoptCachedRelease } from '../../electron/addonFiles';
import { scanAddonsFolder, reconcileYaamMetadata } from '../../electron/addonScanner';
import { cleanupMarkerFiles, loadDatabase, readMarkerFile, saveDatabase } from '../../electron/yaamDatabase';
import { adoptionMode } from '../../electron/shared/installState';
import { CatalogAddon, releaseZipName } from '../../electron/shared/types';

// Shapes taken from a real ~/.minion/minion.xml (Minion 3.0.12)
const LIVE = path.join(os.tmpdir(), 'yaam-minion-fixture', 'live', 'AddOns');
const PTS = path.join(os.tmpdir(), 'yaam-minion-fixture', 'pts', 'AddOns');

const b64 = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc).toString('base64');
const rec = (uid: string, version: string, ...dirs: string[]) =>
  `<addon md5="a10b" ui-version="${version}" uid="${uid}">\n<dirs>\n${dirs.map((d) => `<dir>${d}</dir>`).join('\n')}\n</dirs>\n</addon>\n\n`;
const game = (addonPath: string, records: string, gameId = 'ESO') =>
  `<game addon-path="${addonPath}" auto-update="false" display-name="x" game-id="${gameId}" unique-game-id="${gameId}-1">\n` +
  `<auto-updated>\n<addon date="08.28.2025 2:25PM" title="LibGroupCombatStats" version="2025.08.28"/>\n</auto-updated>\n` +
  `<addons>\n${records}</addons>\n</game>\n`;
const config = (...games: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<minion>\n<config-version>2</config-version>\n` +
  `<game-configs never-ask-about-scanning="true">\n<game-config game-id="WOW" scannable="false"/>\n<game-config game-id="ESO" scannable="true"/>\n</game-configs>\n` +
  `<games>\n${games.join('')}</games>\n</minion>\n`;

describe('parseMinionConfig', () => {
  it('reads catalog ID and version per folder', () => {
    const index = parseMinionConfig(config(game(b64(LIVE), rec('2753', '3.8.33', 'MasterMerchant'))), LIVE);
    expect(index.get('MasterMerchant')).toMatchObject({ uid: '2753', uiVersion: '3.8.33' });
  });

  it('skips the self-closing auto-update log entries', () => {
    const index = parseMinionConfig(config(game(b64(LIVE), rec('2753', '3.8.33', 'MasterMerchant'))), LIVE);
    expect([...index.keys()]).toEqual(['MasterMerchant']);
  });

  it('keeps other installations and other games out', () => {
    const xml = config(
      game(b64(PTS), rec('1', '1.0', 'OnlyOnPts')),
      game(b64(LIVE), rec('2', '2.0', 'OnLive')),
      game(b64(LIVE), rec('3', '3.0', 'WowAddon'), 'WOW'),
    );
    expect([...parseMinionConfig(xml, LIVE).keys()]).toEqual(['OnLive']);
    expect([...parseMinionConfig(xml, PTS).keys()]).toEqual(['OnlyOnPts']);
  });

  it("gives a folder to the record whose main folder it is, whatever the order", () => {
    // Real order: TeamFormation comes first and bundles both libraries
    const xml = config(game(b64(LIVE),
      rec('1135', '1.3.1b', 'ProvisionsTeamFormation', 'LibAddonMenu-2.0', 'LibStub')
      + rec('7', '2.0 r43', 'LibAddonMenu-2.0')
      + rec('44', '1.0 r7', 'LibStub')));
    const index = parseMinionConfig(xml, LIVE);
    expect(index.get('LibAddonMenu-2.0')?.uid).toBe('7');
    expect(index.get('LibStub')?.uid).toBe('44');
    expect(index.get('ProvisionsTeamFormation')?.uid).toBe('1135');
  });

  it('leaves a folder to its bundler when nothing else claims it', () => {
    const xml = config(game(b64(LIVE), rec('1135', '1.3.1b', 'ProvisionsTeamFormation', 'LibStub')));
    expect(parseMinionConfig(xml, LIVE).get('LibStub')?.uid).toBe('1135');
  });

  it('does not decide between two main claims (AsylumTracker and its fork)', () => {
    const xml = config(game(b64(LIVE), rec('4060', '2.0.5.1', 'AsylumTracker') + rec('2111', '2.0.5', 'AsylumTracker')));
    expect(parseMinionConfig(xml, LIVE).has('AsylumTracker')).toBe(false);
  });

  it('matches the path in UTF-8, in the JVM charset and in plain text', () => {
    const umlaut = path.join(os.tmpdir(), 'Jörg', 'live', 'AddOns');
    const records = rec('1', '1.0', 'A');
    expect(parseMinionConfig(config(game(b64(umlaut), records)), umlaut).size).toBe(1);
    expect(parseMinionConfig(config(game(b64(umlaut, 'latin1'), records)), umlaut).size).toBe(1);
    expect(parseMinionConfig(config(game(umlaut, records)), umlaut).size).toBe(1);
  });

  it('ignores a trailing separator in the path', () => {
    expect(parseMinionConfig(config(game(b64(LIVE + path.sep), rec('1', '1.0', 'A'))), LIVE).size).toBe(1);
  });

  it('decodes XML entities', () => {
    const index = parseMinionConfig(config(game(b64(LIVE), rec('1', '1.0 &amp; more', 'Foo&amp;Bar'))), LIVE);
    expect(index.get('Foo&Bar')?.uiVersion).toBe('1.0 & more');
  });

  it('yields nothing for a half-written or foreign file', () => {
    const whole = config(game(b64(LIVE), rec('1', '1.0', 'A')));
    expect(parseMinionConfig(whole.slice(0, whole.indexOf('</game>')), LIVE).size).toBe(0);
    expect(parseMinionConfig('not xml at all', LIVE).size).toBe(0);
    expect(parseMinionConfig('', LIVE).size).toBe(0);
  });
});

describe('scan with a Minion installation', () => {
  let tmp: string;
  let addons: string;
  const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  const cat = (over: Partial<CatalogAddon> & { id: string; name: string }): CatalogAddon => ({
    categoryId: '1', author: 'x', version: '1.0', date: 1000, infoUrl: '', totalDownloads: 0, monthlyDownloads: 0, favorites: 0,
    compatibility: [], directories: [over.name], thumbnails: [], images: [], donationLink: '', ...over,
  });
  const release = (version: string) => ({ 'Tool/Tool.txt': `## Title: Tool\n## Version: ${version}\n`, 'Tool/main.lua': '-- main\n' });
  const makeZip = (files: Record<string, string>, target: string) => {
    const zip = new AdmZip();
    for (const [n, c] of Object.entries(files)) zip.addFile(n, Buffer.from(c));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    zip.writeZip(target);
    return target;
  };
  /** A folder Minion installed: files only, no YAAM trace */
  const placeFolder = (version: string) => {
    for (const [n, c] of Object.entries(release(version))) {
      fs.mkdirSync(path.dirname(path.join(addons, n)), { recursive: true });
      fs.writeFileSync(path.join(addons, n), c);
    }
  };
  const writeMinion = (forPath: string, records: string) => {
    const dir = path.join(tmp, 'home', '.minion');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'minion.xml'), config(game(b64(forPath), records)));
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-minion-'));
    addons = path.join(tmp, 'live', 'AddOns');
    fs.mkdirSync(addons, { recursive: true });
    // os.homedir() reads these at call time
    process.env.HOME = path.join(tmp, 'home');
    process.env.USERPROFILE = path.join(tmp, 'home');
  });
  afterEach(() => {
    // Assigning undefined would store the STRING "undefined" (Windows has no HOME)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('starts an untracked folder from what Minion recorded', () => {
    placeFolder('1.0');
    writeMinion(addons, rec('42', '1.0.8', 'Tool'));
    const [a] = scanAddonsFolder(addons);
    expect(a.yaamMeta).toMatchObject({ esouid: '42', catalogVersion: '1.0.8', localVersion: '1.0' });
    expect(readMarkerFile(addons, 'Tool')?.esouid).toBe('42');
  });

  it("does not take another installation's record", () => {
    placeFolder('1.0');
    writeMinion(path.join(tmp, 'pts', 'AddOns'), rec('42', '1.0.8', 'Tool'));
    expect(scanAddonsFolder(addons)[0].yaamMeta).toBeUndefined();
  });

  it("never overrides YAAM's tracking with Minion's stale record (Master Merchant)", () => {
    // YAAM updated to 3.8.34, Minion still notes 3.8.33
    extractAndRegister(makeZip(release('3.8.34'), path.join(tmp, 'mm.zip')), addons, cat({ id: '42', name: 'Tool', version: '3.8.34' }));
    writeMinion(addons, rec('42', '3.8.33', 'Tool'));
    expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('3.8.34');
  });

  it('backfills an entry without a version only from a record of the same catalog entry', () => {
    placeFolder('1.0');
    const entry = { esouid: '42', url: '', catalogName: 'Tool', catalogAuthor: 'x', catalogVersion: '', localVersion: '1.0', installedAt: '', updatedAt: '' };
    saveDatabase({ schemaVersion: 1, addons: { Tool: entry } }, addons);

    writeMinion(addons, rec('99', '7.7', 'Tool'));
    expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('');

    writeMinion(addons, rec('42', '1.0.8', 'Tool'));
    expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('1.0.8');
  });

  describe('after "Reset YAAM Tracking"', () => {
    beforeEach(() => {
      extractAndRegister(makeZip(release('1.0'), path.join(tmp, 'v1.zip')), addons, cat({ id: '42', name: 'Tool' }));
      writeMinion(addons, rec('42', '1.0', 'Tool'));
      cleanupMarkerFiles(addons);
    });

    it('stays reset: Minion does not re-anchor the folder', () => {
      const [a] = scanAddonsFolder(addons);
      expect(a.yaamMeta?.catalogVersion).toBe('');
      expect(a.yaamMeta?.trackingReset).toBe(true);
      expect(readMarkerFile(addons, 'Tool')).toBeNull();
    });

    it('survives reconciliation', () => {
      reconcileYaamMetadata(addons, [{ folderName: 'Tool', esouid: '42', name: 'Tool Renamed', author: 'x', version: '1.1', url: '', catalogDate: 2000, localVersion: '1.0', confident: true }]);
      expect(loadDatabase(addons).addons.Tool.trackingReset).toBe(true);
      expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('');
    });

    it('ends with the next install', () => {
      extractAndRegister(makeZip(release('1.1'), path.join(tmp, 'v2.zip')), addons, cat({ id: '42', name: 'Tool', version: '1.1' }));
      const [a] = scanAddonsFolder(addons);
      expect(a.yaamMeta?.catalogVersion).toBe('1.1');
      expect(a.yaamMeta?.trackingReset).toBeUndefined();
    });
  });

  it('gives an imported folder stamps and a catalog date through the release check', () => {
    placeFolder('1.0');
    writeMinion(addons, rec('42', '1.0', 'Tool'));
    const [a] = scanAddonsFolder(addons);
    expect(a.yaamMeta?.catalogDate).toBeUndefined();
    const ca = cat({ id: '42', name: 'Tool', version: '1.0', date: 1000 });
    expect(adoptionMode(a.yaamMeta, ca, a.version, false)).toBe('stamp');

    makeZip(release('1.0'), path.join(tmp, 'live', 'Downloads', releaseZipName(ca)));
    const [r] = adoptCachedRelease(addons, [{ folderName: 'Tool', zipName: releaseZipName(ca), notBefore: ca.date, mode: 'stamp' }]);
    expect(r).toMatchObject({ outcome: 'stamped', modified: 0 });
    const [after] = scanAddonsFolder(addons);
    expect(after.yaamMeta?.catalogDate).toBe(1000);
    expect(Object.keys(after.yaamMeta?.fileStamps ?? {}).sort()).toEqual(['Tool.txt', 'main.lua']);
  });
});

describe('adoptionMode (what the release check may do)', () => {
  const ca = { id: '42', version: '1.5', date: 1000 };
  const tracked = { esouid: '42', catalogVersion: '1.5', catalogDate: 1000, localVersion: '1.5' };

  it('anchors an untracked folder, unless the catalog match is ambiguous', () => {
    expect(adoptionMode(undefined, ca, '1.5', false)).toBe('anchor');
    expect(adoptionMode({ ...tracked, catalogVersion: '' }, ca, '1.5', false)).toBe('anchor');
    expect(adoptionMode(undefined, ca, '1.5', true)).toBeNull();
  });

  it('respects a tracking reset: nothing re-anchors the folder on its own', () => {
    expect(adoptionMode({ ...tracked, catalogVersion: '', trackingReset: true }, ca, '1.5', false)).toBeNull();
  });

  it('stamps a folder tracked at the current release', () => {
    expect(adoptionMode(tracked, ca, '1.5', false)).toBe('stamp');
    // Imported from Minion: no date recorded
    expect(adoptionMode({ ...tracked, catalogDate: undefined }, ca, '1.5', false)).toBe('stamp');
  });

  it('leaves everything else alone', () => {
    expect(adoptionMode({ ...tracked, fileStamps: {} }, ca, '1.5', false)).toBeNull();
    expect(adoptionMode({ ...tracked, catalogVersion: '1.4' }, ca, '1.4', false)).toBeNull();
    expect(adoptionMode({ ...tracked, catalogDate: 900 }, ca, '1.5', false)).toBeNull();
    expect(adoptionMode({ ...tracked, esouid: '99' }, ca, '1.5', false)).toBeNull();
    expect(adoptionMode(tracked, ca, '1.6', false)).toBeNull();
  });
});
