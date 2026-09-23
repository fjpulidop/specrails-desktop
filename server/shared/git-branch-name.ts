/** Safe input subset for branch names passed to Git commands. */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string') return false
  const n = name.trim()
  if (!n || n.length > 255) return false
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/')) return false
  if (n.includes('..') || n.includes('//') || n.endsWith('.lock')) return false
  return /^[A-Za-z0-9._/-]+$/.test(n)
}
