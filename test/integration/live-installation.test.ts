import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { previewFolderHygiene } from '../../electron/addonScanner';
import { classifyDirOwnership, findHijackedManifestOverlay, isOverlayStyleEntry } from '../../electron/shared/overlays';
import { CatalogAddon } from '../../electron/shared/types';

/**
 * READ-ONLY smoke test against a real ESO installation + real catalog snapshot.
 * Verifies that the fixes work on the exact real-world mess they were built
 * for.  Skipped automatically when the live folder or snapshot is missing
 * (CI, other machines) — it never modifies anything.
 */
const LIVE_ADDONS = path.join(os.homedir(), 'Documents', 'Elder Scrolls Online', 'live', 'AddOns');
const SNAPSHOT = path.join(__dirname, '..', 'esoui-catalog-snapshot-2026-04-10.json');
const haveLive = fs.existsSync(LIVE_ADDONS);
const haveSnapshot = fs.existsSync(SNAPSHOT);

interface RawEntry {
  UID: string; UICATID: string; UIName: string; UIVersion: string;
  UIDownloadTotal: string; UIDir: string[] | null;
}

function loadCatalog(): CatalogAddon[] {
  const raw: RawEntry[] = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8'));
  return raw.map((e) => ({
    id: e.UID,
    categoryId: e.UICATID,
    name: e.UIName,
    author: '',
    version: e.UIVersion,
    date: 0,
    infoUrl: '',
    totalDownloads: parseInt(e.UIDownloadTotal) || 0,
    monthlyDownloads: 0,
    favorites: 0,
    compatibility: [],
    directories: e.UIDir || [],
    thumbnails: [],
    images: [],
    donationLink: '',
  }));
}

describe.skipIf(!haveSnapshot)('real catalog snapshot (2 932 entries)', () => {
  const catalog = loadCatalog();
  const ownership = classifyDirOwnership(catalog);

  it('resolves the AsylumNotifier folder to original #1847 with LangPatch #2855 as overlay', () => {
    const o = ownership.get('AsylumNotifier');
    expect(o?.original?.id).toBe('1847');
    expect(o?.overlays.map((x) => x.id)).toContain('2855');
  });

  it('resolves AsylumTracker (4 claimants) to one original + patch overlays', () => {
    const o = ownership.get('AsylumTracker');
    expect(o?.original?.id).toBe('2111'); // "Asylum Tracker" — most downloads among non-overlays
    const overlayIds = o?.overlays.map((x) => x.id) ?? [];
    expect(overlayIds).toContain('2847'); // AsylumTracker.LangPatch
    expect(overlayIds).toContain('3589'); // AsylumTracker lang.CN JP RU
  });

  it('keeps WritWorthy a single unambiguous owner (heal target for the poisoned DB entry)', () => {
    // The poisoned DB entry (esouid 7 = LibAddonMenu) fails the ownership
    // check: folder "WritWorthy" is not among LibAddonMenu's directories,
    // while #1605 claims it as primary — exactly the self-heal condition.
    const libAddonMenu = catalog.find((c) => c.id === '7')!;
    const writWorthy = catalog.find((c) => c.id === '1605')!;
    expect(libAddonMenu.directories.includes('WritWorthy')).toBe(false);
    expect(writWorthy.directories[0]).toBe('WritWorthy');
  });

  it('detects the hijacked AsylumNotifier manifest title', () => {
    const o = ownership.get('AsylumNotifier')!;
    // Real local manifest title (color codes stripped): "AsylumNotifier.LangPatch"
    const hit = findHijackedManifestOverlay('AsylumNotifier.LangPatch', o.overlays);
    expect(hit?.id).toBe('2855');
  });

  it('classifies a meaningful share of dir conflicts as overlays', () => {
    // 161 dirs have >1 primary claimant; a good chunk must resolve to
    // original + overlays instead of staying ambiguous.
    expect(ownership.size).toBeGreaterThan(40);
    let withOriginal = 0;
    for (const [, o] of ownership) if (o.original) withOriginal++;
    expect(withOriginal).toBeGreaterThan(30);
  });

  it('never classifies the top-100 addons themselves as overlays', () => {
    const top = catalog.slice().sort((a, b) => b.totalDownloads - a.totalDownloads).slice(0, 100);
    // Popular main addons must not be swallowed by the overlay heuristic
    const misclassified = top.filter((c) => isOverlayStyleEntry(c) && c.categoryId !== '33' && c.categoryId !== '163');
    expect(misclassified.map((c) => c.name)).toEqual([]);
  });
});

describe.skipIf(!haveLive)('live AddOns folder (read-only)', () => {
  const preview = previewFolderHygiene(LIVE_ADDONS);

  it('finds the broken ArchiveHelper root install with its scattered folders', () => {
    const stray = preview.strayManifests.find((s) => s.addonName === 'ArchiveHelper');
    expect(stray).toBeDefined();
    expect(stray!.folderExists).toBe(false);
    expect(stray!.version).toBe('1.3.5');
    expect(stray!.relatedFiles).toEqual(expect.arrayContaining(['ArchiveHelper.lua', 'ui', 'data', 'languages']));
  });

  it('flags the stale 2024 HodorReflexes root manifest (proper folder exists)', () => {
    const stray = preview.strayManifests.find((s) => s.addonName === 'HodorReflexes');
    expect(stray).toBeDefined();
    expect(stray!.folderExists).toBe(true);
    expect(stray!.rootIsStale).toBe(true);
  });

  it('finds the Finder duplicates (HodorReflexes 2, core 2, " N" manifests)', () => {
    const rels = preview.duplicates.map((d) => d.relPath);
    expect(rels).toContain('HodorReflexes 2');
    expect(rels.some((r) => / \d(\.\w+)?$/.test(r))).toBe(true);
    expect(preview.duplicates.length).toBeGreaterThanOrEqual(10);
  });
});
