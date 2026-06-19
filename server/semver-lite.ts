/**
 * Minimal semver comparison — the repo has no `semver` dependency and the core
 * update channel only needs "is A strictly newer than B" plus a total order.
 *
 * Supports `MAJOR.MINOR.PATCH` with an optional `-prerelease` suffix. A version
 * WITH a prerelease tag sorts BELOW the same version without one (`4.9.0-rc.1` <
 * `4.9.0`), matching semver §11. Prerelease identifiers are compared
 * left-to-right: numeric identifiers numerically, others lexically, numeric <
 * non-numeric, and a shorter prerelease set sorts lower when all prior
 * identifiers are equal. Build metadata (`+…`) is ignored. Leading `v`/`=` and
 * surrounding whitespace are tolerated. Unparseable input sorts as `0.0.0`.
 */

interface Parsed {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parse(raw: string): Parsed {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^[v=]+/, '')
    .split('+', 1)[0] // drop build metadata
  const [core, pre] = cleaned.split('-', 2) as [string, string | undefined]
  const parts = core.split('.')
  const num = (s: string | undefined): number => {
    const n = Number.parseInt(s ?? '', 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return {
    major: num(parts[0]),
    minor: num(parts[1]),
    patch: num(parts[2]),
    prerelease: pre && pre.length > 0 ? pre.split('.') : [],
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease outranks any prerelease (1.0.0 > 1.0.0-rc).
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i]
    const bi = b[i]
    if (ai === undefined) return -1 // shorter set sorts lower
    if (bi === undefined) return 1
    if (ai === bi) continue
    const an = /^\d+$/.test(ai)
    const bn = /^\d+$/.test(bi)
    if (an && bn) {
      const d = Number.parseInt(ai, 10) - Number.parseInt(bi, 10)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (an) {
      return -1 // numeric identifiers have lower precedence than non-numeric
    } else if (bn) {
      return 1
    } else {
      return ai < bi ? -1 : 1
    }
  }
  return 0
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

/** True when `candidate` is strictly newer than `base`. */
export function isNewer(candidate: string, base: string): boolean {
  return compareVersions(candidate, base) > 0
}

/** True when `raw` looks like a parseable `MAJOR.MINOR.PATCH[-pre]` version. */
export function isValidVersion(raw: string): boolean {
  return /^[v=]?\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(raw ?? '').trim())
}
