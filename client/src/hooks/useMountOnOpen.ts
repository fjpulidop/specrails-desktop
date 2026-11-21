import { useState } from 'react'

/**
 * True from the first render where `open` is true, and from then on. Lets a
 * lazily loaded dialog fetch its chunk only when it is first opened, while
 * staying mounted afterwards so its close animation and state still work.
 */
export function useMountOnOpen(open: boolean): boolean {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return opened || open
}
