/** A file's identity includes its repository. Recorded patches are separate
 * from the source currently present in that repository's registered checkout. */
export interface ExplorerLocation {
  repositoryId?: string
  path: string | null
  line?: number
  changeJobId?: string | null
}

export type ExplorerMode = 'files' | 'search' | 'activity'

export function positiveLine(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}
