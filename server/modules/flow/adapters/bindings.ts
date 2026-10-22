/**
 * Production bindings of the Flow ports onto the other capabilities: delivery
 * (worktree machinery, rail launch), specs (placeholder ticket), missions/Core
 * agent sessions, accounting and the project's WebSocket. Bound to ONE project
 * context at composition (project-registry); the application never sees them.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { newId } from '../../../ids'
import type { ProjectContext } from '../../../project-registry'
import { internalApiError, type InternalApi } from '../../../internal-api'
import { sumFlowInvocations } from '../../../desktop-db'
import { withRepoLock } from '../../../repo-lock'
import {
  PR_NEVER_STAGE_PATHSPEC_ROOTS, commitWorktreeAndVerify, defaultGitRunner, listWorktrees, removeWorktree, worktreePath as ticketWorktreePath,
  type GitRunner,
} from '../../../worktree-manager'
import { OVERLAY_MANIFEST, applyWorktreeOverlay } from '../../../worktree-overlay'
import { linkNodeModulesIntoWorktree } from '../../../worktree-node-modules'
import type { WsMessage } from '../../../types'
import { getAgentConversation } from '../../agents/runtime/agent-store'
import { isolatedWorktreesRoot, prepareIsolatedWorktree, readHeadSha, resolveOverlaySources } from '../../delivery/runtime/isolated-worktree'
import { FlowHandOffNotReadyError, type FlowHandOffAuthority } from '../../delivery/runtime/flow-worktree-handoff'
import { getRail } from '../../delivery/runtime/rails-store'
import { buildFlowSystemPrompt } from '../../missions/runtime/agent-flow-prompt'
import { FLOW_SESSION_BOUNDARY, type FlowTurnContext } from '../../missions/runtime/flow-turn-context'
import { mutateStore, type Ticket } from '../../specs/runtime/ticket-store'
import { ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import {
  FLOW_SPEC_LOOP_ID, FlowConflictError, FlowLaunchRejectedError, FlowUnavailableError, FlowValidationError, flowCoreSessionId, transition,
  type FlowSession,
} from '../domain'
import type { Clock, FlowDiffFile, FlowPorts, FlowRepository, FlowTickets, WorktreeReservation } from '../ports'
import type { FlowService } from '../application'

/** What Flow needs from the mission agent host (implemented by AgentChatManager). */
export interface FlowAgentHost {
  assertFlowSupport(conversationId: string): Promise<void>
  closeFlowSession(conversationId: string, coreSessionId: string, reason: string): Promise<void>
}

export const systemClock: Clock = { now: () => new Date().toISOString() }

function canonical(value: string): string {
  try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(canonical(parent), canonical(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

// ─── Placeholder spec ─────────────────────────────────────────────────────────

export function createFlowTickets(ctx: Pick<ProjectContext, 'project' | 'broadcast' | 'ticketWatcher'>, clock: Clock = systemClock): FlowTickets {
  const file = () => ticketStorePathForProject(ctx.project)
  const announce = (revision: number, message: WsMessage) => {
    try { ctx.ticketWatcher.notifyDesktopWrite(revision) } catch { /* watcher is advisory */ }
    try { ctx.broadcast(message) } catch { /* clients rehydrate */ }
  }
  return {
    createPlaceholder(input) {
      let created: Ticket | undefined
      // The non-promoting path: a plain local spec write. Jira sees nothing
      // until the Flow -> Spec rail settles (isFlowHeldTicket guards promotion).
      const store = mutateStore(file(), (s) => {
        const id = s.next_id++
        created = {
          id,
          title: input.title,
          description: input.description,
          status: 'in_progress',
          priority: 'medium',
          labels: [],
          assignee: null,
          prerequisites: [],
          metadata: {
            flow: { conversationId: input.conversationId, flowId: input.flowId, worktreeId: input.flowId, startedAt: input.startedAt, state: 'active', chosenMode: 'flow' },
          },
          comments: [],
          origin_conversation_id: null,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: null,
          created_at: input.startedAt,
          updated_at: input.startedAt,
          created_by: 'flow',
          source: 'flow',
        }
        s.tickets[String(id)] = created
      })
      announce(store.revision, { type: 'ticket_created', ticket: created as never, projectId: ctx.project.id, timestamp: clock.now() })
      return created!.id
    },
    setFlowState(ticketId, state) {
      let updated: Ticket | undefined
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        if (!ticket?.metadata?.flow || ticket.metadata.flow.state === state) return
        ticket.metadata.flow = { ...ticket.metadata.flow, state }
        ticket.updated_at = clock.now()
        updated = ticket
      })
      if (updated) announce(store.revision, { type: 'ticket_updated', ticket: updated as never, projectId: ctx.project.id, timestamp: clock.now() })
    },
    deletePlaceholder(ticketId) {
      let deleted = false
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        // Only a Flow placeholder is ever deleted by Flow.
        if (!ticket?.metadata?.flow) return
        delete s.tickets[String(ticketId)]
        deleted = true
      })
      if (deleted) announce(store.revision, { type: 'ticket_deleted', ticketId, projectId: ctx.project.id, timestamp: clock.now() })
    },
  }
}

// ─── Worktree reservation (delivery's single machinery) ───────────────────────

function readOverlayManifest(worktreePath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(worktreePath, OVERLAY_MANIFEST), 'utf8')) as { paths?: unknown }
    return Array.isArray(parsed.paths) ? parsed.paths.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function excludedFromDiff(file: string, overlay: readonly string[]): boolean {
  if (file === OVERLAY_MANIFEST) return true
  if (file === 'node_modules' || file.startsWith('node_modules/') || file.includes('/node_modules/')) return true
  const roots = [...PR_NEVER_STAGE_PATHSPEC_ROOTS, ...overlay]
  return roots.some((root) => file === root || file.startsWith(`${root.replace(/\/$/, '')}/`))
}

const STATUS: Record<string, FlowDiffFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified', C: 'added' }

export function createFlowWorktrees(
  ctx: Pick<ProjectContext, 'project' | 'db' | 'desktopDb' | 'getTicketSpec'>,
  deps: { git?: GitRunner; providerFor: (conversationId: string) => string; prepare?: typeof prepareIsolatedWorktree } = { providerFor: () => 'claude' },
): WorktreeReservation {
  const git = deps.git ?? defaultGitRunner
  const repo = ctx.project.path
  const flowRoot = (flowId: string) => path.join(isolatedWorktreesRoot(ctx.project.slug), flowId)
  return {
    async reserve(input) {
      const prepared = await (deps.prepare ?? prepareIsolatedWorktree)({
        ctx: ctx as ProjectContext,
        ticketId: input.ticketId,
        provider: deps.providerFor(input.conversationId),
        // The Flow id is the mount id: the worktree path is provably Flow-owned.
        runId: input.flowId,
      }, { git })
      return { branch: prepared.branch, worktreePath: prepared.worktreePath, baseSha: prepared.baseSha, headSha: prepared.initialSha }
    },
    async release(input) {
      const root = flowRoot(input.flowId)
      const target = input.worktreePath ?? ticketWorktreePath(root, input.ticketId)
      // Never remove anything outside the Flow's own mount root.
      if (!isInside(target, root)) throw new Error(`Refusing to remove ${target}: it is not a Flow-owned worktree`)
      await withRepoLock(repo, async () => {
        const mounted = (await listWorktrees(git, repo)).some((entry) => canonical(entry) === canonical(target))
        let branch = input.branch
        if (mounted && !branch) {
          const head = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], target)
          branch = head.code === 0 && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : null
        }
        if (mounted) {
          await removeWorktree(git, { repoDir: repo, worktreePath: target, branch: branch ?? '', deleteBranch: Boolean(branch), force: true })
        } else if (branch) {
          // The mount is gone but the Flow-created branch may remain.
          await git.run(['branch', '-D', branch], repo).catch(() => undefined)
        }
        try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort: empty mount root */ }
      })
    },
    async freeze(input) {
      return withRepoLock(repo, async () => {
        // Same never-commit set the rail uses: overlay links and warm node_modules.
        const sources = resolveOverlaySources({ slug: ctx.project.slug, baseRepo: repo, provider: deps.providerFor(input.conversationId) })
        const overlay = applyWorktreeOverlay({ worktreePath: input.worktreePath, ...sources })
        const warm = linkNodeModulesIntoWorktree(repo, input.worktreePath)
        const excludes = [...new Set([...overlay.createdPaths, ...(warm.authenticated ?? warm.linked ?? [])])]
        const title = ctx.getTicketSpec(input.ticketId)?.title ?? `Flow ${input.flowId}`
        const commit = await commitWorktreeAndVerify(git, input.worktreePath, `Flow #${input.ticketId}: ${title}`, excludes, input.baseSha ?? undefined)
        if (!commit.clean) {
          throw new FlowConflictError('flow_freeze_failed', `The Flow worktree could not be committed: ${commit.error ?? commit.dirty.slice(0, 5).join(', ')}`, input.flowId)
        }
        const headSha = await readHeadSha(git, input.worktreePath)
        if (!headSha) throw new FlowConflictError('flow_freeze_failed', 'The Flow worktree HEAD could not be verified', input.flowId)
        return { headSha }
      })
    },
    exists(worktreePath) {
      return fs.existsSync(path.join(worktreePath, '.git'))
    },
    async diff(input) {
      const overlay = readOverlayManifest(input.worktreePath)
      const base = input.baseSha ?? 'HEAD'
      const files = new Map<string, FlowDiffFile>()
      const nameStatus = await git.run(['-c', 'core.quotepath=false', 'diff', '--no-renames', '--name-status', base, '--'], input.worktreePath)
      if (nameStatus.code === 0) {
        for (const line of nameStatus.stdout.split('\n')) {
          const [code, file] = line.split('\t')
          if (!file || excludedFromDiff(file, overlay)) continue
          files.set(file, { path: file, status: STATUS[code?.[0] ?? 'M'] ?? 'modified', additions: null, deletions: null })
        }
      }
      const numstat = await git.run(['-c', 'core.quotepath=false', 'diff', '--no-renames', '--numstat', base, '--'], input.worktreePath)
      if (numstat.code === 0) {
        for (const line of numstat.stdout.split('\n')) {
          const [added, removed, file] = line.split('\t')
          const entry = file ? files.get(file) : undefined
          if (!entry) continue
          entry.additions = added === '-' ? null : Number(added)
          entry.deletions = removed === '-' ? null : Number(removed)
        }
      }
      const untracked = await git.run(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'], input.worktreePath)
      if (untracked.code === 0) {
        for (const file of untracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
          if (excludedFromDiff(file, overlay) || files.has(file)) continue
          files.set(file, { path: file, status: 'untracked', additions: null, deletions: null })
        }
      }
      const list = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return {
        branch: input.branch,
        baseSha: input.baseSha,
        headSha: await readHeadSha(git, input.worktreePath),
        files: list,
        totals: {
          files: list.length,
          additions: list.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: list.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        },
      }
    },
  }
}

// ─── Composition ──────────────────────────────────────────────────────────────

export interface FlowBindingDeps {
  ctx: ProjectContext
  repository: FlowRepository
  internalApi: InternalApi
  /** The app-global mission host (null while agent chat is disabled). */
  agentHost: () => FlowAgentHost | null
  availability: FlowPorts['availability']
  clock?: Clock
  git?: GitRunner
}

export function createFlowPorts(deps: FlowBindingDeps): FlowPorts {
  const { ctx, repository } = deps
  const clock = deps.clock ?? systemClock
  const providerFor = (conversationId: string): string =>
    getAgentConversation(ctx.desktopDb, conversationId)?.provider ?? ctx.project.provider ?? 'claude'
  const host = (): FlowAgentHost => {
    const agentHost = deps.agentHost()
    if (!agentHost) throw new FlowUnavailableError('Flow needs the mission agent chat, which is disabled')
    return agentHost
  }
  return {
    repository,
    tickets: createFlowTickets(ctx, clock),
    worktrees: createFlowWorktrees(ctx, { git: deps.git, providerFor }),
    agent: {
      async assertReady({ conversationId }) {
        const conversation = getAgentConversation(ctx.desktopDb, conversationId)
        if (!conversation) throw new FlowValidationError('conversation_not_found', 'The mission conversation does not exist')
        if (conversation.pinned_project_id !== ctx.project.id) {
          throw new FlowValidationError('conversation_not_pinned', 'Pin the mission to this project before starting a Flow')
        }
        try {
          await host().assertFlowSupport(conversationId)
        } catch (error) {
          if (error instanceof FlowUnavailableError) throw error
          throw new FlowUnavailableError(error instanceof Error ? error.message : String(error))
        }
      },
      async open({ flowId }) {
        // The Core session itself opens lazily on the first Flow turn (cwd = worktree).
        return { coreSessionId: flowCoreSessionId(flowId) }
      },
      async close({ conversationId, coreSessionId }) {
        const agentHost = deps.agentHost()
        if (agentHost) await agentHost.closeFlowSession(conversationId, coreSessionId, 'flow_closed')
      },
    },
    rails: {
      async launch({ flowId, conversationId, ticketId, railIndex, options }) {
        const rail = getRail(ctx.db, railIndex)
        if (rail.ticketIds.length > 0 && !(rail.ticketIds.length === 1 && rail.ticketIds[0] === ticketId)) {
          throw new FlowConflictError('rail_not_empty', `Rail ${railIndex} already carries other specs; pick a free rail`, flowId)
        }
        const base = `/projects/${encodeURIComponent(ctx.project.id)}/rails/${railIndex}`
        if (rail.ticketIds.length === 0) {
          const assigned = await deps.internalApi.call('PUT', `${base}/tickets`, { ticketIds: [ticketId] })
          if (!assigned.ok) {
            const reason = internalApiError(assigned)
            throw new FlowLaunchRejectedError(assigned.status, reason.error, reason.detail ?? reason.error)
          }
        }
        const launched = await deps.internalApi.call('POST', `${base}/launch`, {
          flowId,
          originSurface: 'agent-chat',
          originConversationId: conversationId,
          // Never fall back to the rail's default loop: Flow hands off to Flow -> Spec unless told otherwise.
          loopId: options.loopId ?? FLOW_SPEC_LOOP_ID,
          ...(options.aiEngine ? { aiEngine: options.aiEngine } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        })
        if (!launched.ok) {
          const reason = internalApiError(launched)
          throw new FlowLaunchRejectedError(launched.status, reason.error, reason.detail ?? reason.error)
        }
        const body = (launched.body ?? {}) as { loopRunIds?: unknown; prDeliveryId?: unknown }
        return {
          loopRunIds: Array.isArray(body.loopRunIds) ? body.loopRunIds.filter((id): id is string => typeof id === 'string') : [],
          deliveryId: typeof body.prDeliveryId === 'string' ? body.prDeliveryId : null,
        }
      },
    },
    usage: { costSoFar: (input) => sumFlowInvocations(ctx.desktopDb, input) },
    notifier: {
      changed(session) {
        try {
          ctx.broadcast({ type: 'flow.state', projectId: ctx.project.id, conversationId: session.conversationId, flowId: session.id, flow: session, timestamp: clock.now() })
        } catch { /* clients rehydrate through GET */ }
      },
    },
    clock,
    ids: newId,
    availability: deps.availability,
  }
}

/**
 * The rails launch route's view of Flow (delivery never imports this module).
 * `adopt` and `release` run inside delivery's SQLite transaction on the same
 * project connection, so the ownership transfer is atomic.
 */
export function createFlowHandOffAuthority(repository: FlowRepository, clock: Clock = systemClock, onChanged?: (session: FlowSession) => void): FlowHandOffAuthority {
  return {
    resolve(flowId) {
      const session = repository.get(flowId)
      if (!session || session.step !== 'handoff:launch' || !session.worktreePath || !session.branch || !session.headSha || session.ticketId === null) {
        throw new FlowHandOffNotReadyError('This Flow is not waiting for a rail launch; end it from the Flow bar')
      }
      return {
        flowId,
        ticketId: session.ticketId,
        conversationId: session.conversationId,
        branch: session.branch,
        worktreePath: session.worktreePath,
        headSha: session.headSha,
        baseSha: session.baseSha,
        adopt(adoption) {
          const current = repository.get(flowId)
          if (!current) throw new FlowHandOffNotReadyError('The Flow disappeared during the hand-off')
          repository.save(transition(current, { type: 'handed-off', railIndex: adoption.railIndex, deliveryId: adoption.deliveryId, headSha: adoption.headSha, now: clock.now() }).session)
        },
        release() {
          const current = repository.get(flowId)
          if (!current) return
          const reverted = transition(current, { type: 'adoption-reverted', now: clock.now() }).session
          repository.save(reverted)
          onChanged?.(reverted)
        },
      }
    },
  }
}

/**
 * Missions' FlowTurnContext, bound app-wide: a conversation is in Flow while
 * the Flow of its pinned project is `active` with an open session.
 */
export function createFlowTurnContext(deps: {
  conversationProject: (conversationId: string) => string | null
  flowServiceFor: (projectId: string) => Pick<FlowService, 'getByConversation'> | null
  /** Core capability gate (flowSessions + deriveChange); absent ⇒ never offerable. */
  availability?: () => Promise<{ available: boolean }>
}): FlowTurnContext {
  return {
    async offerable(conversationId) {
      const projectId = deps.conversationProject(conversationId)
      if (!projectId || !deps.availability) return false
      const service = deps.flowServiceFor(projectId)
      if (!service) return false
      const open = service.getByConversation(conversationId)
      if (open && (open.state === 'active' || open.state === 'paused')) return false
      return (await deps.availability()).available
    },
    forConversation(conversationId) {
      const projectId = deps.conversationProject(conversationId)
      if (!projectId) return null
      const session = deps.flowServiceFor(projectId)?.getByConversation(conversationId)
      if (!session || session.state !== 'active' || session.step !== null || !session.worktreePath || !session.coreSessionId) return null
      return {
        flowId: session.id,
        cwd: session.worktreePath,
        branch: session.branch,
        coreSessionId: session.coreSessionId,
        systemPrompt: buildFlowSystemPrompt(),
        policy: FLOW_SESSION_BOUNDARY,
      }
    },
  }
}
