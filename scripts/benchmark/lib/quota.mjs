// Quota guard: reads the app's own subscription-usage signal
// (`GET /api/subscription-usage`) and decides whether the benchmark may launch
// another run. Pure: the usage payload is passed in.

/**
 * Flatten the subscription-usage payload into `{ provider, label, usedPercent, resetsAt, weekly }` rows.
 * A window is weekly when its label or id says 7 days / week.
 */
export function quotaWindows(usage) {
  const rows = []
  for (const p of usage?.providers ?? []) {
    for (const w of p?.windows ?? []) {
      if (w?.scope && w.scope !== 'account') continue
      const label = String(w?.label ?? w?.id ?? '')
      const used = Number(w?.usedPercent)
      if (!Number.isFinite(used)) continue
      rows.push({ provider: String(p.providerId ?? p.id ?? ''), label, usedPercent: used, resetsAt: w?.resetsAt ?? null,
        weekly: /(7\s*d|7-day|week|seven)/i.test(`${label} ${w?.id ?? ''} ${w?.kind ?? ''}`) })
    }
  }
  return rows
}

/**
 * May the harness launch another run on `provider`?
 * Stops when the provider's weekly window reached `stopAtWeekly`, or any of its
 * windows is at 100 % (a hard limit). Missing data never blocks, but is reported.
 * @returns {{ ok: boolean, reason: string, weekly: number|null, windows: ReturnType<typeof quotaWindows> }}
 */
export function quotaDecision(usage, { provider, stopAtWeekly = 95, stopAtWindow = 100 }) {
  const windows = quotaWindows(usage).filter(w => w.provider === provider)
  if (!windows.length) return { ok: true, reason: `no ${provider} quota data`, weekly: null, windows }
  const weekly = windows.filter(w => w.weekly).reduce((max, w) => Math.max(max, w.usedPercent), -1)
  const weeklyValue = weekly < 0 ? null : weekly
  if (weeklyValue !== null && weeklyValue >= stopAtWeekly) return { ok: false, reason: `${provider} weekly window at ${weeklyValue}% (stop at ${stopAtWeekly}%)`, weekly: weeklyValue, windows }
  const full = windows.find(w => w.usedPercent >= stopAtWindow)
  if (full) return { ok: false, reason: `${provider} ${full.label} window at ${full.usedPercent}%${full.resetsAt ? ` until ${full.resetsAt}` : ''}`, weekly: weeklyValue, windows }
  return { ok: true, reason: `${provider} weekly ${weeklyValue ?? '?'}%`, weekly: weeklyValue, windows }
}

/** One timeline row for the report: `{ at, provider: { label: percent } }`. */
export function quotaSample(usage, at = new Date()) {
  const sample = { at: at.toISOString() }
  for (const w of quotaWindows(usage)) (sample[w.provider] ??= {})[w.label] = w.usedPercent
  return sample
}

/**
 * Soak mode: should launching WAIT (not stop) because a short window of `provider`
 * (anything that is not weekly, e.g. the 5-hour session) is at or above `pauseAt`?
 * The window resets, so the soak resumes launching when it drops. Pure.
 */
export function windowGate(usage, { provider, pauseAt = 85 }) {
  const hot = quotaWindows(usage).filter(w => w.provider === provider && !w.weekly && w.usedPercent >= pauseAt)
  if (!hot.length) return { wait: false, reason: null }
  const w = hot[0]
  return { wait: true, reason: `${provider} ${w.label} window at ${w.usedPercent}% (pause launches at ${pauseAt}%${w.resetsAt ? `, resets ${w.resetsAt}` : ''})` }
}

/** "1:05am (Europe/Madrid)": the provider-style reset words for a time `minutes` from `now`, in `tz`. Pure. */
export function resetWords(now, minutes, tz = 'Europe/Madrid') {
  const at = new Date(now.getTime() + minutes * 60_000)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(at).map(p => [p.type, p.value]))
  return `${parts.hour}:${parts.minute}${String(parts.dayPeriod).toLowerCase()} (${tz})`
}
