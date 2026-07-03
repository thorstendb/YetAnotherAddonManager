import { describe, it, expect } from 'vitest';
import { parseVersionParts, compareVersionStrings } from '../../electron/shared/types';
import testData from '../../electron/shared/version-test-data.json';

interface ParseTest {
  pattern: string; input: string; addon: string;
  expectedParts: number[]; expectedSubParts: number[];
  expectedPreRelease?: string; expectedPreReleaseNum?: number;
  expectedSuffix?: string; expectedSuffixParts?: number[];
  expectedLetterRank?: number;
}
interface CompareTest {
  description: string; a: string; b: string; expected: string;
  catalogDate?: number;
}

describe('parseVersionParts – real-world addon versions', () => {
  for (const t of testData.parseTests as ParseTest[]) {
    it(`[${t.pattern}] "${t.input}" (${t.addon})`, () => {
      const result = parseVersionParts(t.input);

      expect(result.parts).toEqual(t.expectedParts);
      expect(result.subParts).toEqual(t.expectedSubParts);

      if (t.expectedPreRelease !== undefined) {
        expect(result.preRelease).toBe(t.expectedPreRelease);
      }
      if (t.expectedPreReleaseNum !== undefined) {
        expect(result.preReleaseNum).toBe(t.expectedPreReleaseNum);
      }
      if (t.expectedSuffix !== undefined) {
        expect(result.suffix).toBe(t.expectedSuffix);
      }
      if (t.expectedSuffixParts !== undefined) {
        expect(result.suffixParts).toEqual(t.expectedSuffixParts);
      }
      if (t.expectedLetterRank !== undefined) {
        expect(result.letterRank).toBe(t.expectedLetterRank);
      }
    });
  }
});

describe('compareVersionStrings – real-world addon versions', () => {
  for (const t of testData.compareTests as CompareTest[]) {
    const label = t.catalogDate ? `${t.description} [+catalogDate]` : t.description;

    it(label, () => {
      const result = compareVersionStrings(t.a, t.b, t.catalogDate);

      if (t.expected === 'a<b') {
        expect(result).toBeLessThan(0);
      } else if (t.expected === 'a>b') {
        expect(result).toBeGreaterThan(0);
      } else {
        expect(result).toBe(0);
      }
    });
  }
});
