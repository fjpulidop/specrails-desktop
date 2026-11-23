import { useEffect, useState } from 'react'
import { nextCountdownTick } from './format-reset'

/** `Date.now()` that refreshes exactly when a countdown to one of `resets` changes its label. */
export function useCountdownNow(resets: readonly (string | null)[]): number {
  const [now, setNow] = useState(() => Date.now())
  const key = resets.join('|')
  useEffect(() => {
    const delay = nextCountdownTick(key ? key.split('|').map((value) => value || null) : [], now)
    if (delay === null) return
    const timer = setTimeout(() => setNow(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [key, now])
  return now
}
