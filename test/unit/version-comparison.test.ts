import { describe, it, expect } from 'vitest';
import { parseVersionParts, compareVersionStrings } from '../../electron/shared/types';

describe('parseVersionParts', () => {
  it('returns fallback [0] for empty string', () => {
    const result = parseVersionParts('');
    expect(result.parts).toEqual([0]);
    expect(result.subParts).toEqual([]);
  });

  it('strips v-prefix', () => {
    const result = parseVersionParts('v2.31');
    expect(result.parts).toEqual([2, 31]);
  });

  it('extracts pre-release marker', () => {
    const result = parseVersionParts('1.0-alpha');
    expect(result.preRelease).toBe('alpha');
    expect(result.preReleaseNum).toBe(0);
  });

  it('extracts pre-release marker with number', () => {
    const result = parseVersionParts('1.0-rc.2');
    expect(result.preRelease).toBe('rc');
    expect(result.preReleaseNum).toBe(2);
  });

  it('marks date-based versions with isDate=true', () => {
    expect(parseVersionParts('2026-03-30').isDate).toBe(true);
    expect(parseVersionParts('2025.08.08').isDate).toBe(true);
  });

  it('marks non-date versions with isDate=false', () => {
    expect(parseVersionParts('1.2.3').isDate).toBe(false);
    expect(parseVersionParts('4.0.4.3.5').isDate).toBe(false);
    expect(parseVersionParts('86').isDate).toBe(false);
  });

  it('extracts parenthesized content as subParts', () => {
    const result = parseVersionParts('2026-03-04 (20260304)');
    expect(result.parts).toEqual([2026, 3, 4]);
    expect(result.subParts).toEqual([20260304]);
  });

  it('normalizes date inside parentheses', () => {
    const result = parseVersionParts('1.2.3 (2026-01-15)');
    expect(result.parts).toEqual([1, 2, 3]);
    expect(result.subParts).toEqual([2026, 1, 15]);
  });

  it('handles multi-segment versions (5+ parts)', () => {
    const result = parseVersionParts('4.0.4.3.5');
    expect(result.parts).toEqual([4, 0, 4, 3, 5]);
  });

  it('handles build keyword', () => {
    const result = parseVersionParts('2.3.22 build 1442');
    expect(result.parts).toEqual([2, 3, 22, 1442]);
  });

  it('handles r-revision formats', () => {
    expect(parseVersionParts('2.r1').parts).toEqual([2, 1]);
    expect(parseVersionParts('3.0r5.0').parts).toEqual([3, 0, 5, 0]);
    expect(parseVersionParts('2.0 r41').parts).toEqual([2, 0, 41]);
  });
});

describe('compareVersionStrings', () => {
  it('equal versions return 0', () => {
    expect(compareVersionStrings('1.2.3', '1.2.3')).toBe(0);
  });

  it('both empty returns 0', () => {
    expect(compareVersionStrings('', '')).toBe(0);
  });

  it('empty < any version', () => {
    expect(compareVersionStrings('', '1.0')).toBeLessThan(0);
  });

  it('pre-release < release', () => {
    expect(compareVersionStrings('1.0-rc', '1.0')).toBeLessThan(0);
  });

  it('pre-release ordering: alpha < beta', () => {
    expect(compareVersionStrings('1.0-alpha', '1.0-beta')).toBeLessThan(0);
  });

  it('sub-version used as tiebreaker', () => {
    expect(compareVersionStrings('1.2.3', '1.2.3 (2026-01-01)')).toBeLessThan(0);
  });

  it('v-prefix is ignored in comparison', () => {
    expect(compareVersionStrings('v2.31', '2.31')).toBe(0);
  });

  it('date dots vs date hyphens: same date', () => {
    expect(compareVersionStrings('2026.03.30', '2026-03-30')).toBe(0);
  });

  it('scheme mismatch: semver→date trusts catalog is newer', () => {
    expect(compareVersionStrings('1.2.3', '2026-03-30')).toBeLessThan(0);
  });

  it('scheme mismatch with catalogDate: date→semver, catalog newer', () => {
    // catalogDate 2026-03-30, local date 2025-08-08
    expect(compareVersionStrings('2025-08-08', '2.0.0', 1774828800)).toBeLessThan(0);
  });

  it('scheme mismatch with catalogDate: date→semver, local newer', () => {
    // catalogDate 2026-01-01, local date 2026-03-30
    expect(compareVersionStrings('2026-03-30', '2.0.0', 1767225600)).toBeGreaterThan(0);
  });
});
