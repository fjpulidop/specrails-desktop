import fs from 'fs'
import path from 'path'
import { mutateStore, readStore } from './modules/specs/runtime/ticket-store'
import { isWorkspacePopulated, resolveProjectExecution } from './workspace-resolution'

/**
 * Specs written while a new project's workspace was still being assembled.
 *
 * Until Core has installed into the relocated workspace, the project resolves to
 * the legacy layout and the board writes to `<repo>/.specrails/local-tickets.json`.
 * Once the workspace is populated the board reads the workspace store, so a spec
 * created in that first minute disappeared (with its delivery) and the next spec
 * reused its id. When the repository has no in-repo install of its own and the
 * workspace store holds no spec yet, the gap's store moves over unchanged (same
 * ids, so deliveries keep pointing at their specs). Never merges: a workspace
 * that already has specs keeps the in-repo file where it is.
 */
export function adoptPreAssemblySpecs(project: { slug: string; path: string }): 'adopted' | 'none' | 'kept' {
  const legacyDir = path.join(project.path, '.specrails')
  const legacyStore = path.join(legacyDir, 'local-tickets.json')
  if (!fs.existsSync(legacyStore)) return 'none'
  // A repository with its own in-repo install keeps using the legacy store on purpose.
  if (fs.existsSync(path.join(legacyDir, 'specrails-version')) || fs.existsSync(path.join(project.path, '.specrails-version'))) return 'none'
  const execution = resolveProjectExecution(project)
  if (!execution.relocated || !execution.workspaceDir || !isWorkspacePopulated(execution.workspaceDir)) return 'none'
  if (path.resolve(execution.ticketsPath) === path.resolve(legacyStore)) return 'none'
  const legacy = readStore(legacyStore)
  if (Object.keys(legacy.tickets).length === 0) return 'none'
  let adopted = false
  mutateStore(execution.ticketsPath, (store) => {
    if (Object.keys(store.tickets).length > 0) return
    store.tickets = legacy.tickets
    store.next_id = Math.max(store.next_id, legacy.next_id)
    adopted = true
  })
  if (!adopted) {
    console.warn(`[setup] ${project.slug}: specs written before assembly stay in ${legacyStore}; the workspace already has specs`)
    return 'kept'
  }
  fs.renameSync(legacyStore, `${legacyStore}.adopted`)
  return 'adopted'
}
