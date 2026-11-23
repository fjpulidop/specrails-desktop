/** Localized sizes and durations for the diagnostics surfaces (Intl units, no hand-built suffixes). */

export function formatReportSize(bytes: number, locale?: string): string {
  const kilobytes = Math.max(bytes, 0) / 1024
  if (kilobytes >= 1024) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(kilobytes / 1024)
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: kilobytes < 10 ? 1 : 0 }).format(kilobytes)
}

/** `640 ms`, `1.2 s`: stalls are short, so milliseconds below one second. */
export function formatStallDuration(ms: number, locale?: string): string {
  if (ms < 1000) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', maximumFractionDigits: 0 }).format(Math.max(0, Math.round(ms)))
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', maximumFractionDigits: 1 }).format(ms / 1000)
}

export function formatClockTime(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
}
