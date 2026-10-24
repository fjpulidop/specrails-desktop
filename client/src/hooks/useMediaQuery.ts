import { useEffect, useState } from 'react'

function matches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)?.matches === true
      : false
  } catch {
    return false
  }
}

/**
 * Live `window.matchMedia(query).matches`. Re-renders when the query flips;
 * returns `false` where matchMedia is unavailable.
 */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mql: MediaQueryList | undefined
    try { mql = window.matchMedia(query) } catch { return }
    if (!mql) return
    const update = () => setValue(mql?.matches === true)
    update()
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update)
      return () => mql?.removeEventListener('change', update)
    }
    mql.addListener?.(update)
    return () => mql?.removeListener?.(update)
  }, [query])
  return value
}
