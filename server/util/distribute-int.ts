/**
 * Distribute an integer `total` across `n` buckets via the largest-remainder
 * method so the per-bucket values sum EXACTLY back to `total` (no floor loss).
 * Used by queue and SMASH accounting to split a multi-ticket job's
 * token / turn totals across one ai_invocations row per ticket
 * (COST-ACCOUNTING-AUDIT MED-7). Returns `undefined` per bucket when the input
 * is absent so the row carries NULL rather than a spurious 0.
 */
export function distributeIntEvenly(
  total: number | null | undefined,
  n: number,
): (number | undefined)[] {
  if (total === null || total === undefined) return new Array(n).fill(undefined)
  const t = Math.trunc(total)
  const base = Math.floor(t / n)
  let remainder = t - base * n
  const out: (number | undefined)[] = new Array(n)
  for (let i = 0; i < n; i++) {
    // Hand the leftover to the leading buckets; sign-safe for negative totals.
    if (remainder > 0) { out[i] = base + 1; remainder -= 1 }
    else if (remainder < 0) { out[i] = base - 1; remainder += 1 }
    else out[i] = base
  }
  return out
}


/**
 * Distribute an integer `total` across buckets in proportion to `weights`
 * (largest remainder), summing EXACTLY back to `total`. Non-positive or
 * non-finite weights count as zero; when every weight is zero the total is
 * split evenly. `undefined` total ⇒ `undefined` per bucket.
 */
export function distributeIntByWeight(
  total: number | null | undefined,
  weights: readonly number[],
): (number | undefined)[] {
  const n = weights.length
  if (total === null || total === undefined || n === 0) return new Array(n).fill(undefined)
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const sum = clean.reduce((a, b) => a + b, 0)
  if (sum === 0) return distributeIntEvenly(total, n)
  const t = Math.trunc(total)
  const exact = clean.map((w) => (t * w) / sum)
  const out = exact.map((v) => Math.floor(v))
  let remainder = t - out.reduce((a, b) => a + b, 0)
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) out[order[k][1]] += 1
  return out
}
