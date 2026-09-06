import fs from 'fs'
import path from 'path'
import { managedCoreRoot } from './core-runtime'

export const coreUpdatePendingPath = (workspace: string): string => path.join(workspace, '.specrails', 'core-update-pending.json')

/** Reading the project remains available; only implementation setup calls this. */
export function assertWorkspaceCoreReady(workspace: string, home?: string): void {
  let pending = fs.existsSync(coreUpdatePendingPath(workspace))
  // If a workspace was read-only and its marker could not be created, the
  // durable global migration still prevents a launch using its old seed.
  try {
    const target = JSON.parse(fs.readFileSync(path.join(managedCoreRoot(home), 'update-status.json'), 'utf8')).pendingVersion
    if (typeof target === 'string' && target) {
      const recorded = fs.readFileSync(path.join(workspace, '.specrails', 'specrails-version'), 'utf8').trim()
      pending ||= recorded !== target
    }
  } catch { /* no pending global migration / uninstalled workspace */ }
  if (pending) {
    throw new Error('This project has an unfinished Core update. Retry the Core update in Settings before starting an implementation.')
  }
}
