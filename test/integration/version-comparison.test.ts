import { describe, it, expect } from 'vitest';
import { parseVersionParts, compareVersionStrings } from '../../electron/shared/types';
import testData from '../../electron/shared/version-test-data.json';

describe('parseVersionParts – real-world addon versions', () => {
  for (const t of testData.parseTests) {
    it(`[${t.pattern}] "${t.input}" (${t.addon})`, () => {
      const result = parseVersionParts(t.input);

      expect(result.parts).toEqual(t.expectedParts);
      expect(result.subParts).toEqual(t.expectedSubParts);

      if ('expectedPreRelease' in t) {
        expect(result.preRelease).toBe((t as any).expectedPreRelease);
      }
      if ('expectedPreReleaseNum' in t) {
        expect(result.preReleaseNum).toBe((t as any).expectedPreReleaseNum);
      }
    });
  }
});

describe('compareVersionStrings – real-world addon versions', () => {
  for (const t of testData.compareTests) {
    const catalogDate = (t as any).catalogDate as number | undefined;
    const label = catalogDate ? `${t.description} [+catalogDate]` : t.description;

    it(label, () => {
      const result = compareVersionStrings(t.a, t.b, catalogDate);

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
