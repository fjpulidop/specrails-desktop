import * as fs from 'fs'
import * as path from 'path'

const chains = new Map<string, Promise<unknown>>()

function canonicalPath(value: string): string {
  try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
}

/** A worktree, symlink and main checkout share the same Git object/ref store.
 * Resolve it on every admission: a moved checkout must not inherit a stale key. */
export function repositoryLockKey(repositoryPath: string): string {
  if (!fs.existsSync(repositoryPath)) return canonicalPath(repositoryPath)
  let current = canonicalPath(repositoryPath)
  while (true) {
    const dotGit = path.join(current, '.git')
    try {
      let gitDir = dotGit
      if (fs.statSync(dotGit).isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
        if (!match) break
        gitDir = path.resolve(current, match[1].trim())
      }
      const commonFile = path.join(gitDir, 'commondir')
      if (fs.existsSync(commonFile)) gitDir = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim())
      return canonicalPath(gitDir)
    } catch { /* walk upward for paths inside a checkout */ }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return canonicalPath(repositoryPath)
}

function withKeyLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(fn)
  const tail = run.then(() => undefined, () => undefined)
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}

/** Process-local mutex over the canonical Git common directory. */
export function withRepoLock<T>(repositoryPath: string, fn: () => Promise<T> | T): Promise<T> {
  return withKeyLock(repositoryLockKey(repositoryPath), fn)
}

/** Acquire each physical repository exactly once, in stable order. Callers must
 * not re-enter withRepoLock from fn; compose effects under this one admission. */
export function withRepoLocks<T>(repositoryPaths: readonly string[], fn: () => Promise<T> | T): Promise<T> {
  const keys = [...new Set(repositoryPaths.map(repositoryLockKey))].sort()
  const enter = (index: number): Promise<T> => index === keys.length ? Promise.resolve().then(fn) : withKeyLock(keys[index], () => enter(index + 1))
  return enter(0)
}

export function __resetRepoLocks(): void { chains.clear() }
