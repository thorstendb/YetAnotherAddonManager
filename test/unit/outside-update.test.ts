// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { extractAndRegister, adoptCachedRelease } from '../../electron/addonFiles';
import { scanAddonsFolder, reconcileYaamMetadata, ReconcileMatch } from '../../electron/addonScanner';
import { loadDatabase, readMarkerFile } from '../../electron/yaamDatabase';
import { CatalogAddon, releaseZipName } from '../../electron/shared/types';

/**
 * An addon updated OUTSIDE YAAM (Minion, manual copy) — files replaced, the
 * .yaam.json marker left in place.  Reconciliation moved the localVersion
 * anchor to the new manifest but kept the OLD catalogVersion; with anchor and
 * manifest equal again, Tier 2 trusted it and offered an "update" Minion had
 * already installed.
 */
const cat = (over: Partial<CatalogAddon> & { id: string; name: string }): CatalogAddon => ({
  categoryId: '1', author: 'x', version: '1.0', date: 1000,
  infoUrl: '', totalDownloads: 0, monthlyDownloads: 0, favorites: 0,
  compatibility: [], directories: [over.name], thumbnails: [], images: [],
  donationLink: '', ...over,
});
const addonV1 = cat({ id: '42', name: 'Tool', version: '1.0', date: 1000 });

let tmp: string;
let addons: string;

const zipOf = (files: Record<string, string>, name: string): string => {
  const zip = new AdmZip();
  for (const [n, c] of Object.entries(files)) zip.addFile(n, Buffer.from(c));
  const p = path.join(tmp, name);
  zip.writeZip(p);
  return p;
};
const release = (manifest: string) => ({ 'Tool/Tool.txt': `## Title: Tool\n${manifest}\n`, 'Tool/main.lua': `-- ${manifest}\n` });
/** What Minion does: overwrite the files, leave .yaam.json alone */
const updateOutsideYaam = (manifest: string) => {
  for (const [n, c] of Object.entries(release(manifest))) fs.writeFileSync(path.join(addons, n), c);
};
/** The renderer's match for the folder, as App.tsx sends it */
const match = (catalogVersion: string, catalogDate: number, localVersion: string): ReconcileMatch => ({
  folderName: 'Tool', esouid: '42', name: 'Tool', author: 'x', version: catalogVersion, url: '',
  catalogDate, localVersion, confident: true,
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaam-outside-'));
  addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  extractAndRegister(zipOf(release('## Version: 1.0'), 'v1.zip'), addons, addonV1);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('reconciling an addon updated outside YAAM', () => {
  it('adopts the current catalog version when the new manifest matches it', () => {
    updateOutsideYaam('## Version: 1.1');
    const res = reconcileYaamMetadata(addons, [match('1.1', 2000, '1.1')]);

    for (const stored of [loadDatabase(addons).addons.Tool, readMarkerFile(addons, 'Tool')!]) {
      expect(stored.catalogVersion).toBe('1.1');
      expect(stored.catalogDate).toBe(2000);
      expect(stored.localVersion).toBe('1.1');
      expect(stored.installedFiles).toBeUndefined();
      expect(stored.fileStamps).toBeUndefined();
    }
    // The renderer adopts exactly this entry
    expect(res.entries.Tool.catalogVersion).toBe('1.1');
    // …and the next scan does not flip it back from a stale marker
    expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('1.1');
  });

  it('clears the catalog version when the catalog has moved on past the new files', () => {
    updateOutsideYaam('## Version: 1.1');
    reconcileYaamMetadata(addons, [match('1.2', 3000, '1.1')]);
    expect(loadDatabase(addons).addons.Tool.catalogVersion).toBe('');
    expect(readMarkerFile(addons, 'Tool')!.catalogVersion).toBe('');
    // Tier 3 now compares 1.1 with 1.2 — a correct update offer
    expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('');
  });

  it('clears it for incomparable version schemes, and the cached release re-anchors byte-exactly', () => {
    const stats = cat({ id: '42', name: 'Tool', version: '1.5.7', date: 1 });
    updateOutsideYaam('## AddOnVersion: 1157000');
    reconcileYaamMetadata(addons, [match('1.5.7', 1, '1157000')]);
    expect(loadDatabase(addons).addons.Tool.catalogVersion).toBe('');

    const downloads = path.join(tmp, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    fs.copyFileSync(zipOf(release('## AddOnVersion: 1157000'), 'v157.zip'), path.join(downloads, releaseZipName(stats)));
    const [r] = adoptCachedRelease(addons, [{
      folderName: 'Tool', zipName: releaseZipName(stats), notBefore: 0, mode: 'anchor',
      baseline: { folderName: 'Tool', esouid: '42', url: '', name: 'Tool', author: 'x', catalogVersion: '1.5.7', catalogDate: 1, localVersion: '1157000' },
    }]);
    expect(r.outcome).toBe('anchored');
    expect(scanAddonsFolder(addons)[0].yaamMeta?.catalogVersion).toBe('1.5.7');
  });

  it('keeps the install-time catalog version while the files are untouched', () => {
    // No outside update: only catalog metadata changed (author renamed the
    // entry, released 1.1).  The old anchor must stay so the update is offered.
    const res = reconcileYaamMetadata(addons, [{ ...match('1.1', 2000, '1.0'), name: 'Tool Renamed' }]);
    expect(res.updated).toBe(1);
    const stored = loadDatabase(addons).addons.Tool;
    expect(stored.catalogVersion).toBe('1.0');
    expect(stored.installedFiles?.slice().sort()).toEqual(['Tool.txt', 'main.lua']);
  });

  it('keeps tracked language patches through reconciliation', () => {
    extractAndRegister(zipOf({ 'Tool/lang/de.lua': '-- de\n' }, 'patch.zip'), addons,
      cat({ id: '99', name: 'Tool LangPatch', version: '2.0' }), { overlayFor: 'Tool' });
    updateOutsideYaam('## Version: 1.1');
    reconcileYaamMetadata(addons, [match('1.1', 2000, '1.1')]);
    expect(loadDatabase(addons).addons.Tool.overlays?.map((o) => o.esouid)).toEqual(['99']);
    expect(readMarkerFile(addons, 'Tool')!.overlays?.map((o) => o.esouid)).toEqual(['99']);
  });
});
