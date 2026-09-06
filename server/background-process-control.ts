import { execFile, type ChildProcess } from 'child_process'
import path from 'path'
import { windowsSpawnEnv, treeKillSafe } from './util/win-spawn'

export interface BackgroundProcessControl {
  /** Windows bootstrap admission waits until its live root identity is frozen. */
  ready?: Promise<void>
  /** Containment forced cleanup after a supervisor failure, rather than a clean exit. */
  terminalFailure?(): string | undefined
  isAlive(): Promise<boolean>
  terminate(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
}

function gone(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ESRCH' }

interface WindowsProcessIdentity { pid: number; parentPid: number; createdAt: string }

let windowsSnapshotPending: Promise<WindowsProcessIdentity[]> | undefined

async function windowsSnapshot(fresh = false): Promise<WindowsProcessIdentity[]> {
  // Multiple apps share the expensive OS query. After sending a signal wait
  // out any earlier query and require a new snapshot to confirm termination.
  if (fresh && windowsSnapshotPending) await windowsSnapshotPending.catch(() => {})
  if (windowsSnapshotPending) return windowsSnapshotPending
  const env = windowsSpawnEnv()
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows'
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate } | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='createdAt';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"
  const pending = new Promise<WindowsProcessIdentity[]>((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env, windowsHide: true, timeout: 2500, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) { reject(error); return }
      try {
        const decoded: unknown = JSON.parse(stdout || '[]')
        const rows = Array.isArray(decoded) ? decoded : [decoded]
        if (rows.some(row => !row || !Number.isInteger(row.pid) || row.pid <= 0 || !Number.isInteger(row.parentPid) || row.parentPid < 0 || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)))) {
          throw new Error('Invalid Windows process identity snapshot.')
        }
        resolve(rows as WindowsProcessIdentity[])
      } catch (error) { reject(error) }
    })
  })
  windowsSnapshotPending = pending
  try { return await pending } finally { if (windowsSnapshotPending === pending) windowsSnapshotPending = undefined }
}

/** POSIX children are launched in a dedicated session/group. Query and signal
 * that group, not a rediscovered tree whose parent may already have exited.
 * Windows uses creation-time identities plus taskkill /T /F; deliberately
 * detached/breakaway processes require OS job containment and are not claimed
 * to be contained here. A failed identity query must never report stopped. */
export function createBackgroundProcessControl(child: ChildProcess, startedAt: number): BackgroundProcessControl {
  const pid = child.pid!
  if (process.platform !== 'win32') {
    return {
      async isAlive() {
        try { process.kill(-pid, 0); return true } catch (error) { if (gone(error)) return false; throw error }
      },
      async terminate(signal) {
        try { process.kill(-pid, signal) } catch (error) { if (!gone(error)) throw error }
      },
    }
  }

  const owned = new Map<number, WindowsProcessIdentity>()
  let rootExited = false
  let identified = false
  let snapshotPending: Promise<WindowsProcessIdentity[]> | undefined
  child.once('exit', () => { rootExited = true })
  child.once('close', () => { rootExited = true })
  const inspect = async (fresh = false): Promise<WindowsProcessIdentity[]> => {
    if (fresh && snapshotPending) await snapshotPending.catch(() => {})
    if (snapshotPending) return snapshotPending
    // Snapshot while the child handle still refers to our live root. A later
    // process with the same pid must never become a new ownership anchor.
    const canIdentifyRoot = !rootExited && !identified
    const pending = windowsSnapshot(fresh).then(rows => {
      const current = new Map(rows.map(row => [row.pid, row]))
      const root = current.get(pid)
      if (canIdentifyRoot && !rootExited && root && Date.parse(root.createdAt) >= startedAt - 2000) {
        owned.set(pid, root)
        identified = true
      }
      if (!identified) throw new Error('Could not verify the Windows background process identity; stop cannot be confirmed.')
      const live = new Map<number, WindowsProcessIdentity>()
      for (const [ownedPid, identity] of owned) {
        const match = current.get(ownedPid)
        if (match?.createdAt === identity.createdAt) live.set(ownedPid, match)
      }
      let changed = true
      while (changed) {
        changed = false
        for (const row of rows) {
          const parent = live.get(row.parentPid)
          if (!live.has(row.pid) && parent && Date.parse(row.createdAt) >= Date.parse(parent.createdAt)) {
            live.set(row.pid, row); owned.set(row.pid, row); changed = true
          }
        }
      }
      return [...live.values()]
    })
    snapshotPending = pending
    try { return await pending } finally { if (snapshotPending === pending) snapshotPending = undefined }
  }
  // Begin capturing descendants before a stop request or a fast parent exit.
  // A shared query may have begun before this particular bootstrap spawned.
  // Retry once with a fresh bounded query while its child handle is still live.
  const ready = inspect().catch(error => { if (rootExited) throw error; return inspect(true) }).then(() => undefined)
  void ready.catch(() => { /* the owner exposes errors from its next probe */ })
  return {
    ready,
    async isAlive() { return (await inspect()).length > 0 },
    async terminate(signal) {
      const live = await inspect()
      const ids = new Set(live.map(row => row.pid))
      const roots = live.filter(row => !ids.has(row.parentPid))
      const errors: Error[] = []
      await Promise.all(roots.map(row => new Promise<void>(resolve => {
        try {
          treeKillSafe(row.pid, signal, error => { if (error) errors.push(error); resolve() })
        } catch (error) { errors.push(error as Error); resolve() }
      })))
      if ((await inspect(true)).length > 0 && errors.length) throw errors[0]
    },
  }
}
