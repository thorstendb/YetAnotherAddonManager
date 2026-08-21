// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { classifyInstallState } from '../../electron/shared/installState';

/**
 * Regression cover for the case Melanchtor reported: installing ESOUI #2221
 * "Price Tooltip" made the separate entry #3201 "Price Tooltip Note" show up as
 * installed, because its archive ships both addon folders.
 *
 * Folder layout after installing #2221 (the archive has a wrapper folder):
 *   AddOns/PriceTooltip/                 ← top level
 *   AddOns/PriceTooltip/PriceTooltip/    ← sub-addon
 *   AddOns/PriceTooltip/PriceTooltipNote/← sub-addon, and #3201's UIDir
 */
describe('classifyInstallState', () => {
  const topLevel = new Set(['PriceTooltip']);
  const present = new Set(['PriceTooltip', 'PriceTooltipNote']);

  it('marks an entry whose main folder sits in AddOns/ as installed', () => {
    expect(classifyInstallState(['PriceTooltip'], topLevel, present)).toBe('installed');
  });

  it('does NOT mark an entry installed when its folder only exists inside another addon', () => {
    expect(classifyInstallState(['PriceTooltipNote'], topLevel, present)).toBe('bundled');
  });

  it('reports absent when no folder of the entry exists at all', () => {
    expect(classifyInstallState(['SomethingElse'], topLevel, present)).toBe('absent');
  });

  it('reports bundled when only a secondary folder (shared library) is present', () => {
    // Entry ships MyAddon + LibFoo; only LibFoo is around, standalone
    const tl = new Set(['LibFoo']);
    expect(classifyInstallState(['MyAddon', 'LibFoo'], tl, tl)).toBe('bundled');
  });

  it('keys on the FIRST directory — a present secondary never makes it installed', () => {
    const tl = new Set(['LibFoo']);
    expect(classifyInstallState(['MyAddon', 'LibFoo'], tl, tl)).not.toBe('installed');
  });

  it('treats an entry without directories as absent', () => {
    expect(classifyInstallState([], topLevel, present)).toBe('absent');
  });
});
