/** A compact project tile: the initials of its first two words
 *  ("specrails-desktop" → "SD"), or its first two letters/digits for a single
 *  word, so neighbouring projects stay distinguishable at a glance. */
export function projectMonogram(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const chars = (words[0] ?? '').match(/[\p{L}\p{N}]/gu) ?? []
  return chars.slice(0, 2).join('').toUpperCase() || '?'
}
