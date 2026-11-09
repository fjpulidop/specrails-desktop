import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

/**
 * One server per data home. The installed app and `npm run dev:desktop` can
 * share `~/.specrails`; two servers on the same databases would recover each
 * other's running jobs as orphans and race on the queues. The lock file names
 * its owner; a dead or unrelated PID (after a crash) never blocks startup.
 */
export interface DataHomeOwner { pid: number; port: number }

export class DataHomeInUseError extends Error {
  constructor(readonly owner: DataHomeOwner, readonly specrailsDir: string) {
    super(`Another Specrails server (pid ${owner.pid}, port ${owner.port}) is already using ${specrailsDir}`)
    this.name = 'DataHomeInUseError'
  }
}

const SERVER_COMMAND = /specrails-server|server[\\/]index\.[cm]?[jt]s|server-bundle\.c?js/

/** Whether `pid` is a running Specrails server (not just any process that reused the PID). */
export function isLiveSpecrailsServer(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    // ESRCH: gone. EPERM: alive but owned by another user, so not our server.
    return false
  }
  // Windows has no cheap command-line probe here; a live PID is treated as the owner.
  if (process.platform === 'win32') return true
  const probe = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 })
  return probe.status === 0 && SERVER_COMMAND.test(probe.stdout)
}

export interface DataHomeLockOptions { pid?: number; isLive?: (pid: number) => boolean }

/** Take the lock for `specrailsDir` or throw DataHomeInUseError. Returns the release function. */
export function acquireDataHomeLock(specrailsDir: string, port: number, options: DataHomeLockOptions = {}): () => void {
  const pid = options.pid ?? process.pid
  const isLive = options.isLive ?? isLiveSpecrailsServer
  const lockPath = path.join(specrailsDir, 'server.lock')
  fs.mkdirSync(specrailsDir, { recursive: true })
  let owner: Partial<DataHomeOwner> | undefined
  try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<DataHomeOwner> } catch { owner = undefined }
  if (owner && Number.isInteger(owner.pid) && owner.pid !== pid && isLive(owner.pid as number)) {
    throw new DataHomeInUseError({ pid: owner.pid as number, port: Number(owner.port) }, specrailsDir)
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid, port }), { mode: 0o600 })
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<DataHomeOwner>
      if (current.pid === pid) fs.unlinkSync(lockPath)
    } catch { /* already gone */ }
  }
}
