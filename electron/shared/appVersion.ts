// Copyright (c) 2026 thorstendb
// SPDX-License-Identifier: MIT
/**
 * Versions of YAAM ITSELF: "0.5.0", "v0.6.0", "1.0.0-beta.2".
 *
 * Deliberately separate from compareVersionStrings.  That one is tuned for the
 * free-form versions ESO addon authors use (dates, "r43", hotfix letters), and
 * its heuristics have no business deciding whether YAAM is outdated — a wrong
 * "newer" there would nag every user with an update that does not exist.
 */

interface ParsedVersion {
  nums: [number, number, number];
  /** Pre-release tag ("beta.2"), empty for a release */
  pre: string;
}

function parse(v: string): ParsedVersion | null {
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' };
}

/** Numeric-aware comparison of dot-separated pre-release tags (beta.2 < beta.10). */
function comparePre(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!isNaN(nx) && !isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * <0 if a is older, 0 if equal OR either side is unreadable, >0 if a is newer.
 * Unreadable counts as equal on purpose: the only decision riding on this is
 * "tell the user there is an update", and that must never fire on garbage.
 */
export function compareAppVersions(a: string, b: string): number {
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] < vb.nums[i] ? -1 : 1;
  }
  // A release ranks above its own pre-releases: 1.0.0 > 1.0.0-beta.2
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  return comparePre(va.pre, vb.pre);
}
