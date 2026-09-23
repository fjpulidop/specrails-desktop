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

