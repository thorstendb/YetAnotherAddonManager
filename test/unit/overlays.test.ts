import { describe, it, expect } from 'vitest';
import { isOverlayStyleEntry, classifyDirOwnership, findHijackedManifestOverlay } from '../../electron/shared/overlays';
import { CatalogAddon } from '../../electron/shared/types';

/** Minimal CatalogAddon factory (only fields the classifier reads + id). */
function ca(partial: Partial<CatalogAddon> & { id: string; name: string; directories: string[] }): CatalogAddon {
  return {
    categoryId: '',
    author: '',
    version: '',
    date: 0,
    infoUrl: '',
    totalDownloads: 0,
    monthlyDownloads: 0,
    favorites: 0,
    compatibility: [],
    thumbnails: [],
    images: [],
    donationLink: '',
    ...partial,
  };
}

// Real constellations from the live ESOUI catalog (April 2026 snapshot)
const asylumOriginal = ca({ id: '1847', name: 'Asylum Sanctorium Status Panel', categoryId: '45', directories: ['AsylumNotifier'], totalDownloads: 50000, version: '1.2.0' });
const asylumLangPatch = ca({ id: '2855', name: 'AsylumNotifier.LangPatch', categoryId: '33', directories: ['AsylumNotifier'], totalDownloads: 3000, version: '2.1.5' });
const raidNotifierUpdated = ca({ id: '1355', name: 'RaidNotifier Updated', categoryId: '45', directories: ['RaidNotifier'], totalDownloads: 900000, version: '2.30' });
const raidNotifierEs = ca({ id: '2766', name: 'RaidNotifier Updated - Traducción al español para quienes usen el juego en ingles', categoryId: '33', directories: ['RaidNotifier'], totalDownloads: 4000, version: '7.0.4' });
const raidNotifierIt = ca({ id: '2991', name: 'RaidNotifier - Traduzione Italiana', categoryId: '45', directories: ['RaidNotifier'], totalDownloads: 2000, version: '2.18' });
const hideHousePreviewOld = ca({ id: '2245', name: 'HideHousePreviews on World Map', categoryId: '24', directories: ['HideHousePreview'], totalDownloads: 30000, version: '3.0.25' });
const hideHousePreviewNew = ca({ id: '3175', name: 'HideHousePreviews (Updated)', categoryId: '24', directories: ['HideHousePreview'], totalDownloads: 20000, version: '3.0.5' });
const libAddonMenu = ca({ id: '7', name: 'LibAddonMenu-2.0', categoryId: '53', directories: ['LibAddonMenu-2.0'], totalDownloads: 6000000, version: '2.0 r43' });
const writWorthy = ca({ id: '1605', name: 'WritWorthy', categoryId: '40', directories: ['WritWorthy'], totalDownloads: 400000, version: '7.5.6' });
const frLocalizationPA = ca({ id: '3956', name: 'Fr Localization PersonalAssistant V3', categoryId: '20', directories: ['PersonalAssistant'], totalDownloads: 500, version: '0.0' });
const personalAssistant = ca({ id: '3512', name: "PersonalAssistant (Banking, Consume, Junk, Loot, Repair, Worker) [Masteroshi430's branch]", categoryId: '20', directories: ['PersonalAssistant'], totalDownloads: 100000, version: '2026.04.07' });

const catalog = [
  asylumOriginal, asylumLangPatch,
  raidNotifierUpdated, raidNotifierEs, raidNotifierIt,
  hideHousePreviewOld, hideHousePreviewNew,
  libAddonMenu, writWorthy,
  frLocalizationPA, personalAssistant,
];

describe('isOverlayStyleEntry', () => {
  it('classifies category 33 (Plug-Ins & Patches) as overlay', () => {
    expect(isOverlayStyleEntry(asylumLangPatch)).toBe(true);
  });

  it('classifies translation names as overlay regardless of category', () => {
    expect(isOverlayStyleEntry(raidNotifierIt)).toBe(true); // cat 45, "Traduzione"
    expect(isOverlayStyleEntry(frLocalizationPA)).toBe(true); // cat 20, "Localization"
  });

  it('does NOT classify plain forks/continuations as overlay', () => {
    expect(isOverlayStyleEntry(hideHousePreviewNew)).toBe(false); // "(Updated)"
    expect(isOverlayStyleEntry(raidNotifierUpdated)).toBe(false);
    expect(isOverlayStyleEntry(writWorthy)).toBe(false);
    expect(isOverlayStyleEntry(libAddonMenu)).toBe(false);
  });
});

describe('classifyDirOwnership', () => {
  const ownership = classifyDirOwnership(catalog);

  it('splits AsylumNotifier into original + LangPatch overlay', () => {
    const o = ownership.get('AsylumNotifier');
    expect(o?.original?.id).toBe('1847');
    expect(o?.overlays.map(x => x.id)).toEqual(['2855']);
  });

  it('collects multiple translation overlays for RaidNotifier', () => {
    const o = ownership.get('RaidNotifier');
    expect(o?.original?.id).toBe('1355');
    expect(o?.overlays.map(x => x.id).sort()).toEqual(['2766', '2991']);
  });

  it('leaves fork-only conflicts (HideHousePreview) out of the overlay map', () => {
    // Two non-overlay claimants → replacement-candidate territory, not overlays
    expect(ownership.has('HideHousePreview')).toBe(false);
  });

  it('leaves single-owner dirs (WritWorthy, LibAddonMenu) out of the overlay map', () => {
    expect(ownership.has('WritWorthy')).toBe(false);
    expect(ownership.has('LibAddonMenu-2.0')).toBe(false);
  });

  it('detects name-pattern overlays in regular categories (PersonalAssistant FR)', () => {
    const o = ownership.get('PersonalAssistant');
    expect(o?.original?.id).toBe('3512');
    expect(o?.overlays.map(x => x.id)).toEqual(['3956']);
  });
});

describe('findHijackedManifestOverlay', () => {
  it('matches the hijacked manifest title against the patch name (color codes stripped upstream)', () => {
    // Local manifest title after LangPatch install: "AsylumNotifier.LangPatch"
    const hit = findHijackedManifestOverlay('AsylumNotifier.LangPatch', [asylumLangPatch]);
    expect(hit?.id).toBe('2855');
  });

  it('does not match the original title', () => {
    expect(findHijackedManifestOverlay('AsylumNotifier', [asylumLangPatch])).toBeUndefined();
  });

  it('handles empty titles gracefully', () => {
    expect(findHijackedManifestOverlay('', [asylumLangPatch])).toBeUndefined();
  });
});
