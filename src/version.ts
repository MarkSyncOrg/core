// Minimal semantic-version comparison for `x.y.z` strings. Build and prerelease
// suffixes (e.g. `-beta.1`) are ignored, which is sufficient for API-version gating.
// Implemented locally to avoid a dependency for such a small need.

function parseVersion(version: string): [number, number, number] {
  const core = (version.replace(/^[vV]/, '').split('-')[0] ?? '').split('.');
  return [Number(core[0]) || 0, Number(core[1]) || 0, Number(core[2]) || 0];
}

/** Returns -1, 0 or 1 when `a` is less than, equal to or greater than `b`. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);
  const diff = aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
  if (diff === 0) {
    return 0;
  }
  return diff < 0 ? -1 : 1;
}

/** True when `version` is greater than or equal to `minimum`. */
export function isVersionAtLeast(version: string, minimum: string): boolean {
  return compareSemver(version, minimum) >= 0;
}
