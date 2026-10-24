// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { findCharDepConflicts, findUnusedAddons, requiredDepClosure } from '../../electron/shared/charDeps';
import { AddonInfo } from '../../electron/shared/types';

/** Minimal AddonInfo: only what the dependency logic reads. */
function mod(folderName: string, deps: string[] = [], subAddons: AddonInfo[] = [], isContainer = false): AddonInfo {
  return {
    folderName, dependsOn: deps.map((name) => ({ name })), subAddons, isContainer,
  } as unknown as AddonInfo;
}

// Real shapes from a live install (October 2026)
const harvestMap = mod('HarvestMap', [], [mod('HarvestMapAD', ['HarvestMap']), mod('HarvestMapDC', ['HarvestMap'])]);
const harvestMapData = mod('HarvestMapData', [], [mod('HarvestMapAD', ['HarvestMap']), mod('HarvestMapDC', ['HarvestMap'])], true);
const fisherman = mod('VotansFisherman', ['LibGPS', 'LibAddonMenu-2.0'], [mod('VotansFishermanExport', ['VotansFisherman'])]);
const libGps = mod('LibGPS', ['LibMapPing']);
const libMapPing = mod('LibMapPing');
const lam = mod('LibAddonMenu-2.0');
const all = [harvestMap, harvestMapData, fisherman, libGps, libMapPing, lam];

const byName = new Map<string, AddonInfo>();
for (const a of all) for (const m of [a, ...a.subAddons]) byName.set(m.folderName, m);
const lookup = (n: string) => byName.get(n);
const installed = (n: string) => byName.has(n);

describe('findCharDepConflicts', () => {
  it('flags modules left on while their parent was switched off', () => {
    const off = new Set(['HarvestMap', 'VotansFisherman']);
    const conflicts = findCharDepConflicts(all, ['Alhandur'], (_c, n) => !off.has(n), installed);
    expect(conflicts.get('HarvestMap')?.Alhandur).toEqual([
      { module: 'HarvestMapAD', dep: 'HarvestMap' },
      { module: 'HarvestMapDC', dep: 'HarvestMap' },
    ]);
    // The data container has no manifest of its own — only its modules count
    expect(conflicts.get('HarvestMapData')?.Alhandur?.map((c) => c.module)).toEqual(['HarvestMapAD', 'HarvestMapDC']);
    expect(conflicts.get('VotansFisherman')?.Alhandur).toEqual([{ module: 'VotansFishermanExport', dep: 'VotansFisherman' }]);
  });

  it('reports nothing when the dependent is off too, or the dep is not installed', () => {
    const off = new Set(['HarvestMap', 'HarvestMapAD', 'HarvestMapDC']);
    const conflicts = findCharDepConflicts(all, ['A'], (_c, n) => !off.has(n), installed);
    expect(conflicts.size).toBe(0);
    // A dependency that is not installed is a different problem ("missing") — not a toggle conflict
    const lonely = mod('Lonely', ['LibNotInstalled']);
    expect(findCharDepConflicts([lonely], ['A'], (_c, n) => n !== 'LibNotInstalled', installed).size).toBe(0);
  });

  it('keeps characters apart', () => {
    const conflicts = findCharDepConflicts(all, ['A', 'B'], (c, n) => !(c === 'B' && n === 'LibGPS'), installed);
    expect(Object.keys(conflicts.get('VotansFisherman') ?? {})).toEqual(['B']);
  });
});

describe('findUnusedAddons', () => {
  const lib = (folderName: string, deps: string[] = []) => ({ ...mod(folderName, deps), isLibrary: true }) as AddonInfo;
  const chars = ['Alhandur', 'Aldharun'];
  /** Switched off for every character, everything else on (no entry → enabled) */
  const offEverywhere = (...names: string[]) => (_c: string, n: string) => !names.includes(n);

  it('reports folders no character loads, keeps everything with an enabled entry', () => {
    const tank = mod('TankHelper');
    const synergy = mod('Synergy');
    const both = [tank, synergy, lam];
    expect(findUnusedAddons(both, chars, offEverywhere('TankHelper', 'Synergy'))).toEqual(['Synergy', 'TankHelper']);
    // On for a single character is enough to stay
    expect(findUnusedAddons(both, chars, (c, n) => n !== 'TankHelper' || c === 'Aldharun')).toEqual([]);
  });

  it('ignores embedded libraries when judging the host', () => {
    const ck = mod('CharacterKnowledge', ['LibCharacterKnowledge'], [lib('LibCharacterKnowledge'), lib('LibExtendedJournal')]);
    const lej = lib('LibExtendedJournal');
    const lck = lib('LibCharacterKnowledge');
    expect(findUnusedAddons([ck, lej, lck], chars, offEverywhere('CharacterKnowledge'))).toEqual(['CharacterKnowledge']);
  });

  it('judges modules: a container is in use while one of its modules is', () => {
    expect(findUnusedAddons([harvestMapData], chars, offEverywhere('HarvestMapAD', 'HarvestMapDC'))).toEqual(['HarvestMapData']);
    expect(findUnusedAddons([harvestMapData], chars, (c, n) => n !== 'HarvestMapAD' && !(c === 'Alhandur' && n === 'HarvestMapDC')))
      .toEqual([]);
    // Parent off, module still on → the folder is in use (the game reports a conflict instead)
    expect(findUnusedAddons([harvestMap], chars, offEverywhere('HarvestMap'))).toEqual([]);
  });

  it('keeps what an addon in use requires, even when it is switched off everywhere', () => {
    expect(findUnusedAddons([fisherman, libGps, libMapPing, lam], chars, offEverywhere('LibGPS'))).toEqual([]);
    // Only required dependencies protect — optional ones do not
    const optional = { ...mod('UsesTtcOptionally'), optionalDependsOn: [{ name: 'TamrielTradeCentre' }] } as AddonInfo;
    expect(findUnusedAddons([optional, mod('TamrielTradeCentre')], chars, offEverywhere('TamrielTradeCentre')))
      .toEqual(['TamrielTradeCentre']);
  });

  it('keeps an unused host whose embedded library is the only copy a used addon requires', () => {
    const host = mod('LucentCitadel', [], [lib('LibUnits2')]);
    const user = mod('RaidNotifier', ['LibUnits2']);
    expect(findUnusedAddons([host, user], chars, offEverywhere('LucentCitadel'))).toEqual([]);
    // With a standalone copy in use the host can go
    expect(findUnusedAddons([host, user, lib('LibUnits2')], chars, offEverywhere('LucentCitadel'))).toEqual(['LucentCitadel']);
  });

  it('reports nothing without character sections', () => {
    expect(findUnusedAddons([mod('TankHelper')], [], () => false)).toEqual([]);
  });
});

describe('requiredDepClosure', () => {
  it('follows dependencies transitively and skips what is not installed', () => {
    expect(requiredDepClosure(['VotansFisherman', 'VotansFishermanExport'], lookup).sort())
      .toEqual(['LibAddonMenu-2.0', 'LibGPS', 'LibMapPing']);
  });

  it('never returns the requested entries themselves', () => {
    expect(requiredDepClosure(['HarvestMap', 'HarvestMapAD'], lookup)).toEqual([]);
  });
});
