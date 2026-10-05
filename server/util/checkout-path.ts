import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** Where a directory sits inside its Git checkout. Handles worktree .git files
 * as well as directories; root and non-Git directories both return ''. */
export function checkoutSubdirectory(directory: string): string {
  let start: string
  try { start = realpathSync(directory) } catch { return '' }
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return relative(current, start).split(sep).join('/')
    if (dirname(current) === current) return ''
  }
}
