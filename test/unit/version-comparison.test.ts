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
    expect(result.parts).toEqual([2, 3, 22]);
    expect(result.suffix).toBe('build');
    expect(result.suffixParts).toEqual([1442]);
  });

  it('handles r-revision formats', () => {
    expect(parseVersionParts('2.r1').parts).toEqual([2]);
    expect(parseVersionParts('2.r1').suffix).toBe('r');
    expect(parseVersionParts('2.r1').suffixParts).toEqual([1]);

    expect(parseVersionParts('3.0r5.0').parts).toEqual([3, 0]);
    expect(parseVersionParts('3.0r5.0').suffix).toBe('r');
    expect(parseVersionParts('3.0r5.0').suffixParts).toEqual([5, 0]);

    expect(parseVersionParts('2.0 r41').parts).toEqual([2, 0]);
    expect(parseVersionParts('2.0 r41').suffix).toBe('r');
    expect(parseVersionParts('2.0 r41').suffixParts).toEqual([41]);
  });

  it('extracts suffix keyword', () => {
    expect(parseVersionParts('2.0 r41').suffix).toBe('r');
    expect(parseVersionParts('2.r1').suffix).toBe('r');
    expect(parseVersionParts('3.0r5.0').suffix).toBe('r');
    expect(parseVersionParts('2.3.22 build 1442').suffix).toBe('build');
    expect(parseVersionParts('1.0 rev3').suffix).toBe('rev');
  });

  it('suffixParts empty for plain versions', () => {
    expect(parseVersionParts('1.2.3').suffixParts).toEqual([]);
    expect(parseVersionParts('86').suffixParts).toEqual([]);
    expect(parseVersionParts('2025.08.08').suffixParts).toEqual([]);
    expect(parseVersionParts('v2.31').suffixParts).toEqual([]);
  });
});

describe('compareVersionStrings', () => {
  // ── Basic equality and ordering ──

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

  // ── Normal same-scheme comparisons (no catalogDate needed) ──

  it('semver: 1.2.3 < 1.2.4', () => {
    expect(compareVersionStrings('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('semver: 3.16.5 < 3.17.0', () => {
    expect(compareVersionStrings('3.16.5', '3.17.0')).toBeLessThan(0);
  });

  it('semver: 5.0.0 > 3.16.5', () => {
    expect(compareVersionStrings('5.0.0', '3.16.5')).toBeGreaterThan(0);
  });

  it('two-part: 1.2 < 1.3', () => {
    expect(compareVersionStrings('1.2', '1.3')).toBeLessThan(0);
  });

  it('single int: 85 < 86', () => {
    expect(compareVersionStrings('85', '86')).toBeLessThan(0);
  });

  it('date: 2025.08.08 < 2026.03.30', () => {
    expect(compareVersionStrings('2025.08.08', '2026.03.30')).toBeLessThan(0);
  });

  // ── Scheme mismatch: date ↔ semver ──

  it('date→semver without catalogDate: raw comparison (2025>1, a>b)', () => {
    // Without catalogDate the fallback is raw numeric: 2025 > 1
    expect(compareVersionStrings('2025.08.08', '1.2.3')).toBeGreaterThan(0);
  });

  it('semver→date without catalogDate: raw comparison (1<2026, a<b)', () => {
    expect(compareVersionStrings('1.2.3', '2026-03-30')).toBeLessThan(0);
  });

  it('date→semver with catalogDate: catalog newer', () => {
    // local=2025-08-08, catalog=2.0.0, catalogDate=2026-03-30
    expect(compareVersionStrings('2025-08-08', '2.0.0', 1774828800)).toBeLessThan(0);
  });

  it('date→semver with catalogDate: local newer', () => {
    // local=2026-03-30, catalog=2.0.0, catalogDate=2026-01-01
    expect(compareVersionStrings('2026-03-30', '2.0.0', 1767225600)).toBeGreaterThan(0);
  });

  it('semver→date with catalogDate: catalog always wins', () => {
    // local=1.2.3, catalog=2026-03-30, catalogDate=2026-03-30
    expect(compareVersionStrings('1.2.3', '2026-03-30', 1774828800)).toBeLessThan(0);
  });

  // ── Scheme mismatch: date ↔ short (1-2 parts) ──

  it('date→short with catalogDate: catalog wins', () => {
    // local=2025.08.08, catalog=49, catalogDate=2026-03-30
    // isDate mismatch → semver/short wins when catalog is newer by date
    expect(compareVersionStrings('2025.08.08', '49', 1774828800)).toBeLessThan(0);
  });

  it('short→date with catalogDate: catalog wins', () => {
    // local=49, catalog=2026-03-30, catalogDate=2026-03-30
    expect(compareVersionStrings('49', '2026-03-30', 1774828800)).toBeLessThan(0);
  });

  // ── Scheme mismatch: short (1-2 parts) ↔ semver (3+ parts) ──
  // The HarvestMap-style problem: "49" vs "3.16.5"

  it('short→semver: single int "49" vs semver "3.16.5" (HarvestMap)', () => {
    expect(compareVersionStrings('49', '3.16.5', 1762720907)).toBe(0);
  });

  it('short→semver: large int "31605" vs semver "3.16.5"', () => {
    expect(compareVersionStrings('31605', '3.16.5', 1762720907)).toBe(0);
  });

  it('short→semver: two-part "316.5" vs semver "3.16.5"', () => {
    expect(compareVersionStrings('316.5', '3.16.5', 1762720907)).toBe(0);
  });

  it('short→semver: two-part "1.2" vs semver "3.16.5"', () => {
    expect(compareVersionStrings('1.2', '3.16.5', 1762720907)).toBe(0);
  });

  it('semver→short: "3.16.5" vs "49" (reverse direction)', () => {
    // Catalog now publishes a single-int build number
    expect(compareVersionStrings('3.16.5', '49', 1762720907)).toBe(0);
  });

  it('semver→short: "1.2.3" vs "100" (reverse direction)', () => {
    expect(compareVersionStrings('1.2.3', '100', 1762720907)).toBe(0);
  });

  // ── No false positives: same-scheme with catalogDate present ──

  it('same-scheme semver: 5.0.0 > 3.16.5 (no false positive)', () => {
    expect(compareVersionStrings('5.0.0', '3.16.5', 1762720907)).toBeGreaterThan(0);
  });

  it('same-scheme semver: 1.0.0 < 3.16.5 (no false positive)', () => {
    expect(compareVersionStrings('1.0.0', '3.16.5', 1762720907)).toBeLessThan(0);
  });

  it('same-scheme single int: 100 > 49 (no false positive)', () => {
    expect(compareVersionStrings('100', '49', 1762720907)).toBeGreaterThan(0);
  });

  it('same-scheme two-part: 2.0 > 1.5 (no false positive)', () => {
    expect(compareVersionStrings('2.0', '1.5', 1762720907)).toBeGreaterThan(0);
  });

  it('same-scheme date: 2025.08.08 < 2026.03.30 with catalogDate', () => {
    expect(compareVersionStrings('2025.08.08', '2026.03.30', 1774828800)).toBeLessThan(0);
  });

  // ── Without catalogDate, short↔semver falls back to raw comparison ──

  it('short→semver without catalogDate: raw comparison (49 > 3)', () => {
    expect(compareVersionStrings('49', '3.16.5')).toBeGreaterThan(0);
  });

  it('short→semver without catalogDate: raw comparison (2 < 3)', () => {
    expect(compareVersionStrings('2', '3.16.5')).toBeLessThan(0);
  });

  // ── Pre-release transitions (NOT scheme changes) ──

  it('pre-release: 1.2-beta < 1.2.3 (not a scheme change)', () => {
    // "1.2-beta" parses as [1,2] + pre=beta → short
    // "1.2.3" parses as [1,2,3] → semver
    // But this is NOT a scheme change since "1.2-beta" is a pre-release of the 1.2 line
    expect(compareVersionStrings('1.2-beta', '1.2.3', 1774828800)).toBeLessThan(0);
  });

  it('pre-release: 1.2.3 > 1.2-beta (not a scheme change)', () => {
    expect(compareVersionStrings('1.2.3', '1.2-beta', 1774828800)).toBeGreaterThan(0);
  });

  it('pre-release: 1.2.3-beta1 < 1.2.3 (same-scheme, pre < release)', () => {
    expect(compareVersionStrings('1.2.3-beta1', '1.2.3', 1774828800)).toBeLessThan(0);
  });

  it('pre-release: 1.2-rc < 1.2.0 (prefix match, pre-release is older)', () => {
    expect(compareVersionStrings('1.2-rc', '1.2.0', 1774828800)).toBeLessThan(0);
  });

  it('pre-release: v1.0-alpha < 1.0.1 (v-prefix + pre-release)', () => {
    expect(compareVersionStrings('v1.0-alpha', '1.0.1', 1774828800)).toBeLessThan(0);
  });

  // ── All possible scheme transitions (comprehensive matrix) ──
  // Catalog date: 2026-03-30 = 1774828800

  // short→date
  it('transition: short "v1." → date "2026-01-27"', () => {
    expect(compareVersionStrings('v1.', '2026-01-27', 1774828800)).toBeLessThan(0);
  });

  // date→semver
  it('transition: date "2026-01-27" → semver "1.2.3"', () => {
    // catalogDate=2026-03-30, local date=2026-01-27 → catalog is newer
    expect(compareVersionStrings('2026-01-27', '1.2.3', 1774828800)).toBeLessThan(0);
  });

  // semver→short+pre
  it('transition: semver "1.2.3" → short+pre "1.2-beta"', () => {
    // This is NOT a scheme change (pre-release prefix match)
    // "1.2-beta" → [1,2]+pre, which is a prefix of [1,2,3]
    // So numeric: 1.2.0 < 1.2.3, plus pre-release makes it even older
    expect(compareVersionStrings('1.2.3', '1.2-beta', 1774828800)).toBeGreaterThan(0);
  });

  // short→semver+pre
  it('transition: short "49" → semver+pre "1.2.3-beta1"', () => {
    // "49" → [49] (short), "1.2.3-beta1" → [1,2,3]+pre (semver)
    // No pre-release prefix match since [49] != [1,2,3] prefix → scheme change
    // Scheme mismatch returns 0 (unknown); .yaam.json handles real updates
    expect(compareVersionStrings('49', '1.2.3-beta1', 1774828800)).toBe(0);
  });

  // date→short
  it('transition: date "2025.08.08" → short "42"', () => {
    // catalogDate=2026-03-30, local date=2025-08-08 → catalog is newer
    expect(compareVersionStrings('2025.08.08', '42', 1774828800)).toBeLessThan(0);
  });

  // short→short (same scheme, not a mismatch)
  it('same-scheme: short "5" < short "10"', () => {
    expect(compareVersionStrings('5', '10', 1774828800)).toBeLessThan(0);
  });

  // date→date (same scheme)
  it('same-scheme: date "2025.01.01" < date "2026.03.30"', () => {
    expect(compareVersionStrings('2025.01.01', '2026.03.30', 1774828800)).toBeLessThan(0);
  });

  // semver→date→semver chain: local was date, catalog now semver (local still date)
  it('transition: date "2025-08-08" → semver "2.0.0" catalog newer', () => {
    expect(compareVersionStrings('2025-08-08', '2.0.0', 1774828800)).toBeLessThan(0);
  });

  // ── r-revision suffix (LibAddonMenu style: "2.0 r41") ──

  it('r-revision: "2.0 r41" < "2.0 r42" (revision bump)', () => {
    expect(compareVersionStrings('2.0 r41', '2.0 r42')).toBeLessThan(0);
  });

  it('r-revision: "2.0 r41" = "2.0 r41" (same revision)', () => {
    expect(compareVersionStrings('2.0 r41', '2.0 r41')).toBe(0);
  });

  it('r-revision: "2.0" < "2.0 r41" (base version vs revision)', () => {
    expect(compareVersionStrings('2.0', '2.0 r41')).toBeLessThan(0);
  });

  it('r-revision: "2.0 r41" > "2.0" (revision vs base version)', () => {
    expect(compareVersionStrings('2.0 r41', '2.0')).toBeGreaterThan(0);
  });

  it('r-revision: "v2.0 r41" < "2.0 r42" (v-prefix + revision bump)', () => {
    expect(compareVersionStrings('v2.0 r41', '2.0 r42')).toBeLessThan(0);
  });

  it('r-revision: "2.0" < "2.0 r41" with catalogDate (not a scheme change)', () => {
    expect(compareVersionStrings('2.0', '2.0 r41', 1774828800)).toBeLessThan(0);
  });

  it('r-revision: "2.0 r41" > "2.0" with catalogDate (not a scheme change)', () => {
    expect(compareVersionStrings('2.0 r41', '2.0', 1774828800)).toBeGreaterThan(0);
  });

  // ── Suffix mismatch (r vs build vs rev) ──

  it('suffix mismatch: "2.0 r41" vs "2.0 build 5" without catalogDate → 0', () => {
    expect(compareVersionStrings('2.0 r41', '2.0 build 5')).toBe(0);
  });

  it('suffix mismatch: "2.0 r41" vs "2.0 build 5" with catalogDate → catalog wins', () => {
    expect(compareVersionStrings('2.0 r41', '2.0 build 5', 1774828800)).toBeLessThan(0);
  });

  it('suffix mismatch: "1.0 rev3" vs "1.0 r3" with catalogDate → catalog wins', () => {
    expect(compareVersionStrings('1.0 rev3', '1.0 r3', 1774828800)).toBeLessThan(0);
  });

  it('same suffix: "2.0 r41" vs "2.0 r42" (both r → normal compare)', () => {
    expect(compareVersionStrings('2.0 r41', '2.0 r42', 1774828800)).toBeLessThan(0);
  });

  it('same suffix: "2.3.22 build 1442" vs "2.3.22 build 1500" (both build → normal compare)', () => {
    expect(compareVersionStrings('2.3.22 build 1442', '2.3.22 build 1500', 1774828800)).toBeLessThan(0);
  });
});
