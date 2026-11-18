/**
 * Copy-on-write copies for files Specrails materializes into run worktrees.
 *
 * Node's `COPYFILE_FICLONE` does NOT clone on macOS (libuv's darwin copyfile
 * path ignores it, and `COPYFILE_FICLONE_FORCE` fails with ENOSYS — measured on
 * Node 25: a 300 MB file takes ~250 ms either way, `cp -c` takes ~6 ms). So on
 * macOS a large file or any directory is cloned with `/bin/cp -c` (APFS
 * clonefile, no data blocks written); a volume without clone support, a
 * failure, a small file or another platform falls back to Node's copy, which
 * still reflinks where the kernel offers it (Linux Btrfs/XFS).
 *
 * Synchronous on purpose: the overlay that calls it is synchronous and runs
 * once per worktree; the clone itself is a metadata operation.
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'

/** Below this a spawn costs more than the bytes it would save. */
export const CLONE_MIN_FILE_BYTES = 1024 * 1024
const CLONE_TIMEOUT_MS = 60_000

export type CloneCopyOutcome = 'cloned' | 'copied'

export interface CloneCopyOptions {
  /** Follow symlinks inside a copied directory (like `cpSync({ dereference })`). */
  dereference?: boolean
  /** Test seam: platform override. */
  platform?: NodeJS.Platform
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true } catch { return false }
}

/** Copy `src` (file or directory) to an ABSENT `dest`. Throws like the
 *  fallback copy would; never leaves a partial clone behind. */
export function cloneCopySync(src: string, dest: string, options: CloneCopyOptions = {}): CloneCopyOutcome {
  if (exists(dest)) throw Object.assign(new Error(`destination exists: ${dest}`), { code: 'EEXIST' })
  const stat = options.dereference ? fs.statSync(src) : fs.lstatSync(src)
  const directory = stat.isDirectory()
  const platform = options.platform ?? process.platform
  if (platform === 'darwin' && (directory || stat.size >= CLONE_MIN_FILE_BYTES)) {
    try {
      execFileSync('/bin/cp', ['-c', ...(directory ? ['-R'] : []), ...(directory && options.dereference ? ['-L'] : []), '--', src, dest], {
        stdio: 'ignore', timeout: CLONE_TIMEOUT_MS, windowsHide: true,
      })
      return 'cloned'
    } catch {
      // No clone support on this volume (or a failure mid-way): drop what
      // `cp` wrote — dest was absent, so it is all ours — and copy normally.
      fs.rmSync(dest, { recursive: true, force: true })
    }
  }
  if (directory) fs.cpSync(src, dest, { recursive: true, dereference: Boolean(options.dereference), filter: () => true, mode: fs.constants.COPYFILE_FICLONE })
  else fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE)
  return 'copied'
}
