import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

function isPosix(): boolean {
  return process.platform !== 'win32'
}

function assertOwnedRegularFile(stat: fs.Stats, file: string): void {
  if (!stat.isFile()) throw new Error(`Refusing non-regular credential file: ${file}`)
  if (isPosix() && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Refusing credential file owned by another user: ${file}`)
  }
}

/**
 * Read a credential without following symlinks. Existing POSIX files are
 * tightened to 0600 before their contents leave this boundary.
 */
export function readPrivateTextFile(file: string): string | null {
  let fd: number | null = null
  try {
    const noFollow = isPosix() ? (fs.constants.O_NOFOLLOW ?? 0) : 0
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
    const stat = fs.fstatSync(fd)
    assertOwnedRegularFile(stat, file)
    if (isPosix()) fs.fchmodSync(fd, 0o600)
    return fs.readFileSync(fd, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* best effort */ }
    }
  }
}

/**
 * Atomically replace a credential with a same-directory, exclusively-created
 * 0600 file. rename replaces a hostile symlink instead of writing through it.
 */
export function writePrivateTextFile(file: string, value: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (isPosix()) fs.chmodSync(dir, 0o700)

  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    fs.writeFileSync(fd, value, { encoding: 'utf8' })
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
    if (isPosix()) fs.chmodSync(file, 0o600)
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    throw err
  }
}
