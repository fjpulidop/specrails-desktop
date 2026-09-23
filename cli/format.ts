



// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}


// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

export function formatTokens(n: number): string {
  return new Intl.NumberFormat('en-US', { useGrouping: true })
    .format(n)
    .replace(/,/g, ' ')
}


export function formatJobDuration(ms: number | null): string {
  if (ms == null) return '-'
  return formatDuration(ms)
}


export function formatJobStarted(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${min}`
  } catch {
    return isoStr.slice(0, 16)
  }
}
