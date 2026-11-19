import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIGEST = /^[a-f0-9]{64}$/
/** Where the shared package cache records which pin files name each package. */
export const SHARED_REFS_DIRECTORY = '.refs'

/**
 * Record that `pinFile` names `integrity` in the shared cache, and mark the package
 * as just used (its directory mtime is the cache's recency). Callers hold the package lock.
 */
export function recordSharedPackageReference(cache: string, integrity: string, pinFile: string): void {
  if (!DIGEST.test(integrity)) throw new Error('Invalid runtime package digest')
  const directory = path.join(cache, SHARED_REFS_DIRECTORY, integrity)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const name = createHash('sha256').update(path.resolve(pinFile)).digest('hex').slice(0, 32) + '.json'
  fs.writeFileSync(path.join(directory, name), JSON.stringify({ pinFile: path.resolve(pinFile) }) + '\n', { mode: 0o600 })
  const now = new Date()
  try { fs.utimesSync(path.join(cache, integrity), now, now) } catch { /* recency is advisory */ }
}
