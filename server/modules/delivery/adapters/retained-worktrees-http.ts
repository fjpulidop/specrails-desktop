import type { Router } from 'express'
import type { ProjectContext, ProjectRegistry } from '../../../project-registry'
import { defaultGitRunner, type GitRunner } from '../../../worktree-manager'
import {
  createRetainedSizeScanner, listRetainedWorktreeCandidates, listRetainedWorktrees, removeRetainedWorktree,
  type RetainedRemovalResult, type RetainedSizeState, type RetainedWorktreeItem, type RetainedWorktreeProject,
} from '../runtime/retained-worktrees'

type Registry = Pick<ProjectRegistry, 'listContexts' | 'getContext'>

/** At most this many worktrees per removal request (each removal holds its repository lock). */
const MAX_REMOVALS = 100
const MAX_SIZE_KEYS = 200

function projectOf(ctx: ProjectContext): RetainedWorktreeProject {
  return {
    id: ctx.project.id,
    name: ctx.project.name,
    path: ctx.project.path,
    db: ctx.db,
    ticketTitle: (ticketId) => {
      const spec = ctx.getTicketSpec(ticketId) as { title?: unknown } | undefined
      return typeof spec?.title === 'string' ? spec.title : null
    },
  }
}

interface ItemRef { projectId: string; id: string }

function readRefs(value: unknown, max: number): ItemRef[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const refs: ItemRef[] = []
  for (const entry of value) {
    const projectId = (entry as { projectId?: unknown })?.projectId
    const id = (entry as { id?: unknown })?.id
    if (typeof projectId !== 'string' || typeof id !== 'string' || !projectId || !id) return null
    refs.push({ projectId, id })
  }
  return refs
}

/**
 * Settings ▸ Storage: retained run worktrees across every project.
 *
 * - `GET /worktrees/retained` lists them with their Git evidence and label.
 * - `POST /worktrees/retained/sizes` `{ items: [{projectId, id}] }` returns
 *   (and lazily starts) disk-usage scans; paths are resolved server-side.
 * - `POST /worktrees/retained/remove` `{ items: [{projectId, id, head, deleteBranch}] }`
 *   removes the confirmed ones through the release path, one at a time.
 *
 * Each project is read through its own context; one failing project only
 * reports its own error.
 */
export function registerRetainedWorktreeRoutes(router: Router, registry: Registry, git: GitRunner = defaultGitRunner): void {
  const sizes = createRetainedSizeScanner()

  router.get('/worktrees/retained', async (_req, res) => {
    const now = Date.now()
    const projects: Array<{ projectId: string; projectName: string; error?: string }> = []
    const items: RetainedWorktreeItem[] = []
    for (const ctx of registry.listContexts()) {
      try {
        items.push(...await listRetainedWorktrees(projectOf(ctx), git, now))
        projects.push({ projectId: ctx.project.id, projectName: ctx.project.name })
      } catch (err) {
        projects.push({ projectId: ctx.project.id, projectName: ctx.project.name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    res.json({ generatedAt: new Date(now).toISOString(), projects, items })
  })

  router.post('/worktrees/retained/sizes', (req, res) => {
    const refs = readRefs((req.body as { items?: unknown } | undefined)?.items, MAX_SIZE_KEYS)
    if (!refs) { res.status(400).json({ error: 'items must be a list of { projectId, id }' }); return }
    const out: Array<ItemRef & { size: RetainedSizeState | null }> = []
    const byProject = new Map<string, Map<string, string>>()
    for (const ref of refs) {
      const ctx = registry.getContext(ref.projectId)
      if (!ctx) { out.push({ ...ref, size: null }); continue }
      let paths = byProject.get(ref.projectId)
      if (!paths) {
        paths = new Map(listRetainedWorktreeCandidates(projectOf(ctx)).map((candidate) => [candidate.id, candidate.worktreePath]))
        byProject.set(ref.projectId, paths)
      }
      const dir = paths.get(ref.id)
      out.push({ ...ref, size: dir ? sizes.request(ref.projectId, ref.id, dir) : null })
    }
    res.json({ items: out })
  })

  router.post('/worktrees/retained/remove', async (req, res) => {
    const raw = (req.body as { items?: unknown } | undefined)?.items
    const refs = readRefs(raw, MAX_REMOVALS)
    if (!refs || !Array.isArray(raw)) { res.status(400).json({ error: 'items must be a list of { projectId, id, head, deleteBranch }' }); return }
    const requests = raw.map((entry, index) => ({
      ...refs[index],
      head: (entry as { head?: unknown }).head,
      deleteBranch: (entry as { deleteBranch?: unknown }).deleteBranch === true,
    }))
    if (requests.some((entry) => typeof entry.head !== 'string' || !/^[0-9a-f]{40,64}$/i.test(entry.head))) {
      res.status(400).json({ error: 'each item needs the confirmed head commit' }); return
    }
    const results: Array<RetainedRemovalResult & { projectId: string }> = []
    // Sequential on purpose: a removal re-checks the branches the previous one left.
    for (const entry of requests) {
      const ctx = registry.getContext(entry.projectId)
      if (!ctx) { results.push({ projectId: entry.projectId, id: entry.id, status: 'not-found', reason: null, branchDeleted: false, warnings: [] }); continue }
      try {
        const outcome = await removeRetainedWorktree(projectOf(ctx), git, { id: entry.id, head: entry.head as string, deleteBranch: entry.deleteBranch })
        if (outcome.status === 'removed') sizes.forget(entry.projectId, entry.id)
        results.push({ projectId: entry.projectId, ...outcome })
      } catch (err) {
        results.push({ projectId: entry.projectId, id: entry.id, status: 'kept', reason: 'release', branchDeleted: false, warnings: [err instanceof Error ? err.message : String(err)] })
      }
    }
    res.json({ results })
  })
}
