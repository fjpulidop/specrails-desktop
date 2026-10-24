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
import { getAgentConversation, listAgentMessages } from '../../agents/runtime/agent-store'
import { getProjectRepositories } from '../../../project-repositories'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { getLinkByLocalId } from '../../../jira/jira-db'
import { getAdapter } from '../../../providers'
import { isProviderEnabled } from '../../../provider-selection'
import { supportsContractRefine } from '../../../providers/runtime'
import { captureProcessAdmission } from '../../../process-admission'
import { resolveDefaultSpecModel } from '../../../project-router-helpers'
import { runtimeRunSummary } from '../../agent-runtime/runtime/agent-runtime-controls-router'
import { readSettleEvidence } from '../../delivery/runtime/delivery-evidence'
import { FLOW_SPEC_DELIVERY_LOOP_ID } from '../../delivery/runtime/flow-review-outcome'
import { getPrDelivery, toPrDeliverySnapshot, type DeliverBranchRecord, type PrDeliverySnapshot } from '../../delivery/runtime/rail-pr-store'
import { FlowReturnRejectedError, announceReturnedDelivery, returnFlowWorktree } from '../../delivery/runtime/flow-worktree-return'
import { generateSpecFromText, resolveSpecGenerationToolPolicy } from '../../specs/runtime/spec-generation'
import type { SpecProvider } from '../../specs/runtime/spec-models'
import { RepositoryHasNoCommitsError, isolatedRepositoryTarget, prepareIsolatedWorktree, readHeadSha, resolveOverlaySources } from '../../delivery/runtime/isolated-worktree'
import { FlowHandOffNotReadyError, type FlowHandOffAuthority } from '../../delivery/runtime/flow-worktree-handoff'
import { getRail } from '../../delivery/runtime/rails-store'
import { buildFlowSystemPrompt } from '../../missions/runtime/agent-flow-prompt'
import { FAILURE_BRIEFING_REF_KIND } from '../../missions/runtime/agent-failure-briefing'
import { FLOW_SESSION_BOUNDARY, type FlowTurn, type FlowTurnContext } from '../../missions/runtime/flow-turn-context'
import { isFlowHeldTicket, mutateStore, readStore, type Ticket, type TicketStatus } from '../../specs/runtime/ticket-store'
import { applyFlowSpecAddenda, ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import { openAddenda, readSpecAddenda } from '../../specs/runtime/spec-addenda-core'
import { getRails } from '../../delivery/runtime/rails-store'
import { getActivePrDeliveryByRail } from '../../delivery/runtime/rail-pr-store'
import {
  FLOW_SPEC_LOOP_ID, FlowConflictError, FlowLaunchRejectedError, FlowUnavailableError, FlowValidationError, buildFlowSummary, buildOriginalSpecComment, currentDerivedChange, firstErrorLine, isOpenSpecChangeId, flowCoreSessionId, inFlowWindow, nextFlowCoreSessionId, FLOW_UNEXPLAINED_FILES_CAP, transition,
  type DerivedChangeText, type FlowRunFailure, type FlowSession, type FlowSpecSnapshot,
} from '../domain'
import type { Clock, FlowDiffFile, FlowLaunchOptions, FlowEffectsStore, FlowPorts, FlowProcesses, FlowPublication, FlowRepository, FlowSpecBlocker, FlowTickets, WorktreeReservation } from '../ports'
import type { FlowService } from '../application'

/** What Flow needs from the mission agent host (implemented by AgentChatManager). */
export interface FlowAgentHost {
  assertFlowSupport(conversationId: string): Promise<void>
  closeFlowSession(conversationId: string, coreSessionId: string, reason: string): Promise<void>
  /** Persist + broadcast a system row once per `dedupeKey` (null when skipped). Never throws. */
  postSystemRow?(conversationId: string, row: Record<string, unknown> & { kind: string }, dedupeKey: string): string | null
  /** Start ONE automatic, app-authored turn keyed by `turnKey` (durable dedup). Never throws. */
  startAutomaticTurn?(conversationId: string, text: string, opts: { turnKey: string; label: string }): Promise<'started' | 'skipped'>
}

/** The automatic turn after Back to Flow (the briefing itself rides the Flow turn). */
export const FLOW_RETURN_TURN_TEXT = 'Back to Flow: the Flow → Spec run came back with the findings above. In at most 2 short lines say what you will fix, then start fixing it in this worktree. If a finding leaves a genuine decision to me (for example removing behaviour nobody asked for versus recording it as a requirement), offer it as an `options` block before editing and wait for my answer.'

/** The automatic turn after a Flow → Spec run failed outright and came back on its own. */
export const FLOW_FAILURE_RETURN_TURN_TEXT = 'Back to Flow: the Flow → Spec run failed with the error above and the worktree came back to this Flow intact. In at most 2 short lines tell me what failed in plain words and what you will do. If the cause is in this worktree, fix it here; if it is outside it (a tool version, the environment, credentials), tell me exactly what to change instead of working around it.'

/** Status codes of a Flow → Spec run that stopped for review reasons (never a crash). */
const FLOW_REVIEW_STATUS_CODES = new Set(['review_changes_requested', 'returned_to_flow'])

/** The delivery codes of a Flow → Spec run that failed outright (null for a review outcome). */
export function deliveryFailureOf(snap: Pick<PrDeliverySnapshot, 'statusCode' | 'statusDetail' | 'units' | 'flowReview'>): FlowRunFailure | null {
  if (snap.flowReview) return null
  // After the return, the delivery's own codes say `returned_to_flow`: the crash codes are gone.
  const returned = snap.statusCode === 'returned_to_flow'
  return {
    stepId: null,
    cause: null,
    statusCode: returned ? null : snap.statusCode ?? null,
    failureCode: snap.units.find((unit) => unit.failureCode)?.failureCode ?? null,
    statusDetail: returned ? null : snap.statusDetail ?? null,
  }
}

/** Whether a Flow → Spec delivery failed outright and is idle (the automatic return may take its worktree). */
export function isCrashedFlowDelivery(snap: Pick<PrDeliverySnapshot, 'loopId' | 'decision' | 'statusCode' | 'flowReview' | 'operation'>): boolean {
  return snap.loopId === FLOW_SPEC_DELIVERY_LOOP_ID
    && snap.decision === 'implementation_failed'
    && !snap.flowReview
    && !FLOW_REVIEW_STATUS_CODES.has(snap.statusCode ?? '')
    && !snap.operation
}

export const systemClock: Clock = { now: () => new Date().toISOString() }

function canonical(value: string): string {
  try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(canonical(parent), canonical(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

// ─── The Flow's spec (placeholder or existing) ────────────────────────────────

/** Where a spec sits on the project's rails (null ⇒ on none). */
export type FlowRailOf = (ticketId: number) => { railIndex: number; running: boolean } | null

/** The rail of a spec from the project's rails and their live deliveries. */
export function railOfTicket(db: ProjectContext['db']): FlowRailOf {
  return (ticketId) => {
    const rail = getRails(db).find((candidate) => candidate.ticketIds.includes(ticketId))
    if (!rail) return null
    return { railIndex: rail.railIndex, running: Boolean(getActivePrDeliveryByRail(db, rail.railIndex)) }
  }
}

const CLOSED_SPEC_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled'])

/** The open addenda of a spec, as the first Flow turn lists them. */
function renderOpenAddenda(ticket: Ticket): string {
  const open = openAddenda(ticket.addenda)
  if (!open.length) return ''
  return ['## Open addenda (iterations requested on this spec)', '', ...open.slice(0, 20).map((addendum, index) =>
    `${index + 1}. [${addendum.kind}] ${addendum.title}${addendum.body.trim() ? `\n   ${addendum.body.trim().slice(0, 600).replace(/\n/g, '\n   ')}` : ''}`)].join('\n')
}

function snapshotOf(ticket: Ticket): FlowSpecSnapshot {
  return {
    id: ticket.id,
    title: ticket.title,
    description: ticket.description ?? '',
    status: ticket.status,
    nonGoals: Array.isArray(ticket.nonGoals) ? ticket.nonGoals.filter((goal): goal is string => typeof goal === 'string') : [],
    repositoryIds: Array.isArray(ticket.repositoryIds) ? ticket.repositoryIds.filter((id): id is string => typeof id === 'string') : [],
    addenda: renderOpenAddenda(ticket),
  }
}

/** Why this spec cannot start a Flow now (null ⇒ it can). `flowId`: the Flow re-checking its own adoption. */
function existingSpecBlocker(ticket: Ticket | undefined, railOf: FlowRailOf | undefined, flowId?: string): FlowSpecBlocker | null {
  if (!ticket) return { code: 'spec_not_found', message: 'This spec no longer exists' }
  if (CLOSED_SPEC_STATUSES.has(ticket.status)) return { code: 'spec_closed', message: `Spec #${ticket.id} is ${ticket.status === 'done' ? 'done' : 'cancelled'}; reopen it to work on it in Flow` }
  if (isFlowHeldTicket(ticket) && ticket.metadata?.flow?.flowId !== flowId) return { code: 'spec_in_flow', message: `Spec #${ticket.id} is already in Flow` }
  const rail = railOf?.(ticket.id) ?? null
  if (rail?.running) return { code: 'spec_running', message: `Spec #${ticket.id} is running on Rail ${rail.railIndex + 1}` }
  if (rail) return { code: 'spec_on_rail', message: `Spec #${ticket.id} is on Rail ${rail.railIndex + 1}; take it off the rail to start it in Flow` }
  return null
}

export function createFlowTickets(ctx: Pick<ProjectContext, 'project' | 'broadcast' | 'ticketWatcher'>, clock: Clock = systemClock, railOf?: FlowRailOf): FlowTickets {
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
          // A Flow in a non-primary repository: the spec targets exactly it, so
          // the hand-off and every later launch run in that repository.
          ...(input.repositoryIds?.length ? { repositoryIds: [...input.repositoryIds] } : {}),
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
        // Only a Flow placeholder is ever deleted by Flow: never the person's own spec.
        if (!ticket?.metadata?.flow || ticket.metadata.flow.origin === 'existing') return
        delete s.tickets[String(ticketId)]
        deleted = true
      })
      if (deleted) announce(store.revision, { type: 'ticket_deleted', ticketId, projectId: ctx.project.id, timestamp: clock.now() })
    },
    markDelivered(ticketId, input) {
      let updated: Ticket | undefined
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        if (!ticket?.metadata?.flow) return
        const changeName = input.openspecChangeName ?? (typeof ticket.metadata.openspecChangeName === 'string' ? ticket.metadata.openspecChangeName : null)
        const unchanged = ticket.metadata.flow.state === 'delivered' && ticket.metadata.openspecChangeName === (changeName ?? undefined)
          && ticket.status !== 'in_progress' && ticket.status !== 'todo'
        if (unchanged) return
        ticket.metadata = { ...ticket.metadata, flow: { ...ticket.metadata.flow, state: 'delivered' }, ...(changeName ? { openspecChangeName: changeName } : {}) }
        // The delivery is on review; never pull back a ticket that moved on (done, cancelled).
        if (ticket.status === 'in_progress' || ticket.status === 'todo') ticket.status = 'on_review'
        ticket.updated_at = clock.now()
        updated = ticket
      })
      if (updated) announce(store.revision, { type: 'ticket_updated', ticket: updated as never, projectId: ctx.project.id, timestamp: clock.now() })
    },
    read(ticketId) {
      const ticket = readStore(file()).tickets[String(ticketId)]
      if (!ticket) return null
      const spec = snapshotOf(ticket)
      return { title: spec.title, description: spec.description, status: spec.status, repositoryIds: [...spec.repositoryIds], nonGoals: [...spec.nonGoals] }
    },
    inspectExisting(ticketId) {
      const ticket = readStore(file()).tickets[String(ticketId)]
      return { spec: ticket ? snapshotOf(ticket) : null, blocker: existingSpecBlocker(ticket, railOf) }
    },
    adoptExisting(input) {
      let adopted: Ticket | undefined
      let blocker: FlowSpecBlocker | null = null
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(input.ticketId)]
        blocker = existingSpecBlocker(ticket, railOf, input.flowId)
        if (blocker || !ticket) return
        const current = ticket.metadata?.flow
        // Idempotent: this Flow already holds the spec.
        if (current?.flowId === input.flowId && current.origin === 'existing') { adopted = ticket; return }
        const previousStatus: TicketStatus = ticket.status
        ticket.metadata = {
          ...ticket.metadata,
          flow: {
            conversationId: input.conversationId, flowId: input.flowId, worktreeId: input.flowId, startedAt: input.startedAt,
            state: 'active', chosenMode: 'flow', origin: 'existing', previousStatus,
          },
        }
        // The same "in progress, In Flow" a placeholder spec shows.
        ticket.status = 'in_progress'
        ticket.updated_at = clock.now()
        adopted = ticket
      })
      if (blocker) {
        const reason = blocker as FlowSpecBlocker
        if (reason.code === 'spec_not_found') throw new FlowValidationError(reason.code, reason.message)
        throw new FlowConflictError(reason.code, reason.message)
      }
      announce(store.revision, { type: 'ticket_updated', ticket: adopted as never, projectId: ctx.project.id, timestamp: clock.now() })
      return snapshotOf(adopted!)
    },
    restoreExisting(ticketId, flowId) {
      let updated: Ticket | undefined
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        const flow = ticket?.metadata?.flow
        // Only the spec THIS Flow holds; an existing spec is never deleted.
        if (!ticket || !flow || flow.flowId !== flowId || flow.origin !== 'existing') return
        const { flow: _held, ...metadata } = ticket.metadata ?? {}
        ticket.metadata = metadata
        // Its own status comes back unless it moved on meanwhile (done, cancelled…).
        if (ticket.status === 'in_progress' && flow.previousStatus) ticket.status = flow.previousStatus
        ticket.updated_at = clock.now()
        updated = ticket
      })
      if (updated) announce(store.revision, { type: 'ticket_updated', ticket: updated as never, projectId: ctx.project.id, timestamp: clock.now() })
    },
    preserveOriginal(ticketId, flowId) {
      let updated: Ticket | undefined
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        const flow = ticket?.metadata?.flow
        if (!ticket || !flow || flow.flowId !== flowId) return
        const comments = Array.isArray(ticket.comments) ? ticket.comments : []
        // Idempotent: the original was already kept for this Flow.
        if (typeof flow.originalCommentId === 'number' && comments.some((comment) => comment.id === flow.originalCommentId)) return
        const id = comments.reduce((max, comment) => Math.max(max, typeof comment.id === 'number' ? comment.id : 0), 0) + 1
        const now = clock.now()
        ticket.comments = [...comments, {
          id,
          body: buildOriginalSpecComment({ title: ticket.title, description: ticket.description ?? '', nonGoals: Array.isArray(ticket.nonGoals) ? ticket.nonGoals : [], flowId }),
          created_at: now,
          created_by: 'flow',
        }]
        ticket.metadata = { ...ticket.metadata, flow: { ...flow, originalCommentId: id } }
        ticket.updated_at = now
        updated = ticket
      })
      if (updated) announce(store.revision, { type: 'ticket_updated', ticket: updated as never, projectId: ctx.project.id, timestamp: clock.now() })
    },
    applyAddenda(ticketId, flowId, causalId) {
      // Read-only probe first: a spec without live addenda (or a replay) never rewrites the store.
      const probe = readStore(file()).tickets[String(ticketId)]
      if (probe?.metadata?.flow?.flowId !== flowId || !readSpecAddenda(probe.addenda).some((a) => a.status === 'open' || a.status === 'in_flight')) return
      let updated: Ticket | undefined
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        // Only the spec this Flow holds (the label stays through settlement).
        if (!ticket || ticket.metadata?.flow?.flowId !== flowId) return
        if (applyFlowSpecAddenda(s, ticketId, causalId, clock.now())) updated = ticket
      })
      if (updated) announce(store.revision, { type: 'ticket_updated', ticket: updated as never, projectId: ctx.project.id, timestamp: clock.now() })
    },
    reopen(ticketId) {
      let updated: Ticket | undefined
      const store = mutateStore(file(), (s) => {
        const ticket = s.tickets[String(ticketId)]
        if (!ticket?.metadata?.flow) return
        // A failed run moved the spec back to todo; Back to Flow works on it again.
        // Never pull back a ticket that moved on (done, cancelled).
        const status = ticket.status === 'todo' || ticket.status === 'on_review' ? 'in_progress' : ticket.status
        if (status === ticket.status && ticket.metadata.flow.state === 'paused') return
        ticket.status = status
        ticket.metadata = { ...ticket.metadata, flow: { ...ticket.metadata.flow, state: 'paused' } }
        ticket.updated_at = clock.now()
        updated = ticket
      })
      if (updated) announce(store.revision, { type: 'ticket_updated', ticket: updated as never, projectId: ctx.project.id, timestamp: clock.now() })
    },
  }
}

/** The engine choices a stopped Flow → Spec launch used (Relaunch repeats them). */
export function launchOptionsOf(raw: string | null | undefined): FlowLaunchOptions {
  let config: Record<string, unknown> = {}
  try { const parsed: unknown = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown> } catch { /* defaults */ }
  const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 200 ? value.trim() : undefined
  const loopId = text(config.loopId), aiEngine = text(config.aiEngine), model = text(config.model), reasoningEffort = text(config.reasoning_effort ?? config.reasoningEffort)
  return { ...(loopId ? { loopId } : {}), ...(aiEngine ? { aiEngine } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) }
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

async function forkPoint(git: GitRunner, worktreePath: string, repo: string): Promise<string | null> {
  const branch = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo)
  if (branch.code !== 0 || !branch.stdout.trim()) return null
  const base = await git.run(['merge-base', 'HEAD', branch.stdout.trim()], worktreePath)
  const sha = base.code === 0 ? base.stdout.trim() : ''
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
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
  // The Flow's repository: the project root for the primary (unchanged), or a
  // non-primary Git member's own checkout and per-repository mount root.
  const repositoryTarget = (repositoryId: string | null | undefined) => {
    try {
      return isolatedRepositoryTarget(ctx.project as ProjectContext['project'], repositoryId)
    } catch (error) {
      throw new FlowConflictError('flow_repository_missing', `The Flow's repository is no longer usable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const flowRoot = (flowId: string, repositoryId: string | null | undefined) => path.join(repositoryTarget(repositoryId).worktreesRoot, flowId)
  return {
    async reserve(input) {
      let prepared: Awaited<ReturnType<typeof prepareIsolatedWorktree>>
      repositoryTarget(input.repositoryId)
      try {
        prepared = await (deps.prepare ?? prepareIsolatedWorktree)({
          ctx: ctx as ProjectContext,
          ticketId: input.ticketId,
          provider: deps.providerFor(input.conversationId),
          // The Flow id is the mount id: the worktree path is provably Flow-owned.
          runId: input.flowId,
          ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
        }, { git })
      } catch (error) {
        if (error instanceof RepositoryHasNoCommitsError) throw new FlowConflictError(error.code, error.message)
        throw error
      }
      // The Flow's base is the reservation SHA; never leave it unknown (a null
      // base would measure the diff against HEAD and lose committed work).
      return { branch: prepared.branch, worktreePath: prepared.worktreePath, baseSha: prepared.baseSha ?? prepared.initialSha, headSha: prepared.initialSha }
    },
    async release(input) {
      const repo = repositoryTarget(input.repositoryId).path
      const root = flowRoot(input.flowId, input.repositoryId)
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
      const { path: repo, primary } = repositoryTarget(input.repositoryId)
      return withRepoLock(repo, async () => {
        // Same never-commit set the rail uses: overlay links and warm node_modules.
        const sources = resolveOverlaySources({ slug: ctx.project.slug, baseRepo: repo, provider: deps.providerFor(input.conversationId) },
          primary ? undefined : () => resolveProjectExecution(ctx.project))
        const overlay = applyWorktreeOverlay({ worktreePath: input.worktreePath, ...sources })
        const warm = linkNodeModulesIntoWorktree(repo, input.worktreePath)
        const excludes = [...new Set([...overlay.createdPaths, ...(warm.authenticated ?? warm.linked ?? [])])]
        const title = ctx.getTicketSpec(input.ticketId)?.title ?? `Flow ${input.flowId}`
        // The Flow's own derived change (a returned Flow → Spec run left it
        // active) is intended; any other new active change still blocks.
        // Everything in a Flow worktree is the Flow's own work. A single active
        // change the Flow does not know yet (an earlier Flow -> Spec run named
        // it differently) is adopted as its derived change; several are
        // ambiguous and still block, with a message the agent can act on.
        const unknown = await unknownActiveChanges(git, input.worktreePath, input.baseSha, input.allowedChanges)
        if (unknown.length > 1) {
          throw new FlowConflictError('flow_freeze_failed', `This Flow has ${unknown.length} open spec changes (${unknown.join(', ')}); keep one and archive or remove the others, then hand off again`, input.flowId)
        }
        const adoptedChange = unknown.length === 1 && !input.allowedChanges.some((name) => fs.existsSync(path.join(input.worktreePath, 'openspec', 'changes', name))) ? unknown[0] : undefined
        if (unknown.length === 1 && !adoptedChange) {
          throw new FlowConflictError('flow_freeze_failed', `This Flow has two open spec changes (${[...input.allowedChanges.filter((name) => fs.existsSync(path.join(input.worktreePath, 'openspec', 'changes', name))), unknown[0]].join(', ')}); keep one and archive or remove the other, then hand off again`, input.flowId)
        }
        const allowed = adoptedChange ? [...input.allowedChanges, adoptedChange] : input.allowedChanges
        const commit = await commitWorktreeAndVerify(git, input.worktreePath, `Flow #${input.ticketId}: ${title}`, excludes, input.baseSha ?? undefined, { allowedActiveChanges: allowed })
        if (!commit.clean) {
          throw new FlowConflictError('flow_freeze_failed', `The Flow worktree could not be committed: ${commit.error ?? commit.dirty.slice(0, 5).join(', ')}`, input.flowId)
        }
        const headSha = await readHeadSha(git, input.worktreePath)
        if (!headSha) throw new FlowConflictError('flow_freeze_failed', 'The Flow worktree HEAD could not be verified', input.flowId)
        return adoptedChange ? { headSha, adoptedChange } : { headSha }
      })
    },
    exists(worktreePath) {
      return fs.existsSync(path.join(worktreePath, '.git'))
    },
    async diff(input) {
      const overlay = readOverlayManifest(input.worktreePath)
      // Legacy sessions without a recorded base: the fork point from the
      // project's checked-out branch, never HEAD (frozen commits would vanish).
      const base = input.baseSha ?? await forkPoint(git, input.worktreePath, repositoryTarget(input.repositoryId).path) ?? 'HEAD'
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
  effects: FlowEffectsStore
  internalApi: InternalApi
  /** The app-global mission host (null while agent chat is disabled). */
  agentHost: () => FlowAgentHost | null
  availability: FlowPorts['availability']
  /** Stops the Flow's background processes (bound to the process registry at
   * composition). Absent ⇒ the Flow never started any. */
  processes?: FlowProcesses
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
    // Target triage: a workspace or multi-repository project names the Git
    // member a Flow runs in; a single repository is never triaged.
    repositories: {
      list: () => getProjectRepositories(ctx.project).map((member) => ({
        id: member.id, name: member.name, isPrimary: member.isPrimary, kind: member.kind, ...(member.available === false ? { available: false } : {}),
      })),
    },
    tickets: createFlowTickets(ctx, clock, railOfTicket(ctx.db)),
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
      async open({ flowId, renew }) {
        // The Core session itself opens lazily on the first Flow turn (cwd = worktree).
        // A resume never reuses a closed session: it gets a new generation.
        return { coreSessionId: renew ? nextFlowCoreSessionId(flowId, Date.now()) : flowCoreSessionId(flowId) }
      },
      async close({ conversationId, coreSessionId }) {
        const agentHost = deps.agentHost()
        if (agentHost) await agentHost.closeFlowSession(conversationId, coreSessionId, 'flow_closed')
      },
      launchEngine(conversationId) {
        const conversation = getAgentConversation(ctx.desktopDb, conversationId)
        if (!conversation?.provider || !isProviderEnabled(ctx.project, conversation.provider)) return null
        return {
          aiEngine: conversation.provider,
          ...(conversation.model ? { model: conversation.model } : {}),
          ...(conversation.reasoning_effort ? { reasoningEffort: conversation.reasoning_effort } : {}),
        }
      },
    },
    rails: {
      async launch({ flowId, conversationId, ticketId, railIndex, options, repositoryId }) {
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
          // A Flow in a non-primary repository launches exactly that repository.
          ...(repositoryId ? { repositoryIds: [repositoryId] } : {}),
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
      stoppedDelivery(deliveryId) {
        const row = getPrDelivery(ctx.db, deliveryId)
        if (!row) return null
        const derivation = readSettleEvidence(row.settle_evidence)?.units[0]?.runtime?.derivation ?? null
        const snap = toPrDeliverySnapshot(row)
        return {
          railIndex: row.rail_index, options: launchOptionsOf(row.launch_config_json), findings: snap.flowReview ?? null,
          derivation: derivation ? { change: derivation.change, files: derivation.files, explained: derivation.explained, unexplainedFiles: derivation.unexplainedFiles.slice(0, FLOW_UNEXPLAINED_FILES_CAP), unexplainedOmitted: derivation.unexplainedOmitted + Math.max(0, derivation.unexplainedFiles.length - FLOW_UNEXPLAINED_FILES_CAP) } : null,
          failure: deliveryFailureOf(snap),
        }
      },
      async runFailure(deliveryId) {
        try {
          const row = getPrDelivery(ctx.db, deliveryId)
          const runId = row ? toPrDeliverySnapshot(row).runIds[0] : undefined
          if (!runId) return null
          // The runtime's own record: the step it stopped at and its error
          // (the same source the mission run card shows).
          const summary = await runtimeRunSummary(ctx, runId)
          if (!summary) return null
          return {
            stepId: summary.pendingApproval?.stepId ?? summary.nextStep ?? null,
            cause: summary.status === 'failed' ? firstErrorLine(summary.error) : null,
          }
        } catch {
          return null
        }
      },
      returnWorktree({ deliveryId, worktreePath, detail, commit }) {
        try {
          const closed = returnFlowWorktree(ctx.db, { deliveryId, worktreePath, detail }, commit)
          announceReturnedDelivery(ctx.project.id, closed, (message) => ctx.broadcast(message))
        } catch (error) {
          if (error instanceof FlowReturnRejectedError) throw new FlowConflictError(error.code, error.message)
          throw error
        }
      },
    },
    conversation: {
      postReturnCard({ conversationId, flowId, deliveryId, findings, derivation, failure }) {
        deps.agentHost()?.postSystemRow?.(conversationId, {
          kind: 'flow-return-briefing', flowId, deliveryId,
          reason: findings?.reason ?? null, score: findings?.score ?? null, summary: findings?.summary ?? null,
          issues: findings?.issues ?? [], issuesOmitted: findings?.issuesOmitted ?? 0, failingChecks: findings?.failingChecks ?? [],
          derivation,
          // A run that failed outright: the client localizes the step and keeps the codes as technical details.
          ...(!findings && failure ? { failure } : {}),
          at: clock.now(),
        }, `flow-return-briefing:${deliveryId}`)
      },
      async startReturnTurn({ conversationId, deliveryId, failure }) {
        await deps.agentHost()?.startAutomaticTurn?.(conversationId, failure ? FLOW_FAILURE_RETURN_TURN_TEXT : FLOW_RETURN_TURN_TEXT, { turnKey: `flow-return:${deliveryId}`, label: 'Back to Flow' })
      },
      postDeliveredSummary({ conversationId, flowId, deliveryId, ticketId, settlement }) {
        const row = deliveryId ? getPrDelivery(ctx.db, deliveryId) : undefined
        const ticket = readStore(ticketStorePathForProject(ctx.project)).tickets[String(ticketId)]
        const changeName = typeof ticket?.metadata?.openspecChangeName === 'string' ? ticket.metadata.openspecChangeName : null
        let jiraKey: string | null = null
        try { const link = getLinkByLocalId(ctx.db, ticketId); jiraKey = link && !link.tombstoned ? link.jiraKey : null } catch { jiraKey = null }
        deps.agentHost()?.postSystemRow?.(conversationId, {
          kind: 'flow-delivered', flowId, deliveryId, ticketId,
          prUrl: row?.pr_url ?? null, prNumber: row?.pr_number ?? null,
          // Flow → Spec archives the change before it delivers (its `archive` step).
          changeName, changeArchived: Boolean(changeName),
          specRewrite: settlement.specRewrite, jiraCreate: settlement.jiraCreate, jiraKey,
          at: clock.now(),
        }, `flow-delivered:${flowId}`)
      },
      postBoundary({ conversationId, flowId, event, reason, branch }) {
        const at = clock.now()
        deps.agentHost()?.postSystemRow?.(conversationId, {
          kind: 'flow-boundary', flowId, event, reason, branch, at,
        }, `flow-boundary:${flowId}:${event}:${reason}:${at}`)
      },
    },
    processes: deps.processes ?? { stop: async () => {} },
    effects: deps.effects,
    publication: createFlowPublication(ctx, { git: deps.git }),
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
export function createFlowHandOffAuthority(
  repository: FlowRepository, clock: Clock = systemClock, onChanged?: (session: FlowSession) => void,
  summarize?: (session: FlowSession) => string,
): FlowHandOffAuthority {
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
        ...(session.repositoryId ? { repositoryId: session.repositoryId } : {}),
        branch: session.branch,
        worktreePath: session.worktreePath,
        headSha: session.headSha,
        baseSha: session.baseSha,
        // A re-derivation updates the Flow's own change in place (null ⇒ named after the spec).
        changeId: currentDerivedChange(session),
        // A summary failure never blocks the hand-off: Core derives from the diff alone.
        summary: (() => { try { return summarize?.(session) ?? '' } catch { return '' } })(),
        adopt(adoption) {
          const current = repository.get(flowId)
          if (!current) throw new FlowHandOffNotReadyError('The Flow disappeared during the hand-off')
          repository.save(transition(current, { type: 'handed-off', railIndex: adoption.railIndex, deliveryId: adoption.deliveryId, headSha: adoption.headSha, now: clock.now() }).session)
          // Announce the hand-off as soon as the delivery's transaction commits,
          // so the hand-off card gives way to the run card that appears with it
          // instead of waiting for the rest of the launch.
          setImmediate(() => {
            // Best effort: the connection may be gone (project closed) by then.
            try {
              const adopted = repository.get(flowId)
              if (adopted?.state === 'handed_off' && adopted.deliveryId === adoption.deliveryId) onChanged?.(adopted)
            } catch { /* clients rehydrate through GET */ }
          })
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

/** The turn of an active Flow with a session (null otherwise). */
function toFlowTurn(session: FlowSession | null): FlowTurn | null {
  if (!session || session.state !== 'active' || session.step !== null || !session.worktreePath || !session.coreSessionId) return null
  return {
    flowId: session.id,
    cwd: session.worktreePath,
    branch: session.branch,
    coreSessionId: session.coreSessionId,
    systemPrompt: buildFlowSystemPrompt(),
    policy: FLOW_SESSION_BOUNDARY,
    ...(session.returnBriefing ? { briefing: session.returnBriefing } : {}),
  }
}

/**
 * Missions' FlowTurnContext, bound app-wide: a conversation is in Flow while
 * the Flow of its pinned project is `active` with an open session.
 */
export function createFlowTurnContext(deps: {
  conversationProject: (conversationId: string) => string | null
  flowServiceFor: (projectId: string) => Pick<FlowService, 'getByConversation'> & Partial<Pick<FlowService, 'briefingDelivered' | 'renewSession'>> | null
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
      return toFlowTurn(deps.flowServiceFor(projectId)?.getByConversation(conversationId) ?? null)
    },
    async renewSession(conversationId, flowId) {
      const projectId = deps.conversationProject(conversationId)
      const service = projectId ? deps.flowServiceFor(projectId) : null
      if (!service?.renewSession) return null
      return toFlowTurn(await service.renewSession(flowId))
    },
    async briefingDelivered(conversationId, flowId) {
      const projectId = deps.conversationProject(conversationId)
      if (!projectId) return
      await deps.flowServiceFor(projectId)?.briefingDelivered?.(flowId)
    },
  }
}

// ─── Settlement publication (arch section 4.6) ───────────────────────────────

/** Decisions that mean the delivery reached review (or went beyond it). */
const DELIVERED_DECISIONS = new Set(['on_review', 'pr_draft', 'pr_ready', 'completed', 'merged'])
const ARCHIVED_CHANGE = /^openspec\/changes\/archive\/([^/]+)\/(proposal|design)\.md$/
const ACTIVE_CHANGE = /^openspec\/changes\/(?!archive\/)([^/]+)\/(proposal|design)\.md$/
const TEXT_CAP = 64 * 1024

/**
 * The bounded summary of a Flow conversation: the person's messages since the
 * Flow started (automatic briefings excluded), the first line of each final
 * agent reply and the recorded decisions. Message times (SQLite) and Flow times
 * (ISO) are compared as instants, never as strings.
 */
export function flowConversationSummary(desktopDb: ProjectContext['desktopDb'], input: { conversationId: string; idea: string | null; from: string; to: string | null }): string {
  const messages = listAgentMessages(desktopDb, input.conversationId)
    .filter((message) => inFlowWindow(message.created_at, input.from, input.to))
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.context_refs.some((ref) => ref.kind === FAILURE_BRIEFING_REF_KIND) ? { automated: true } : {}),
    }))
  return buildFlowSummary({ idea: input.idea, messages })
}

/** Strip OpenSpec's `YYYY-MM-DD-` archive prefix. */
export function changeNameFromArchive(directory: string): string {
  return directory.replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

/**
 * Read the derived OpenSpec change from the delivered commit: the archived
 * (or still active) change directory the run added since the Flow base, its
 * proposal and design, and a bounded diffstat. Pure Git reads; never mutates.
 */
export async function readDerivedChange(git: GitRunner, repo: string, input: { ref: string; baseSha: string | null; changeName: string | null }): Promise<DerivedChangeText> {
  const base = input.baseSha ?? `${input.ref}~1`
  const added = await git.run(['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=A', base, input.ref, '--', 'openspec/changes'], repo)
  if (added.code !== 0) throw new Error(`git diff failed: ${added.stderr.trim() || added.code}`)
  const candidates = added.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const directories = new Map<string, { name: string; files: Map<string, string> }>()
  for (const file of candidates) {
    const archived = ARCHIVED_CHANGE.exec(file)
    const active = archived ? null : ACTIVE_CHANGE.exec(file)
    const match = archived ?? active
    if (!match) continue
    const dir = file.slice(0, file.lastIndexOf('/'))
    const entry = directories.get(dir) ?? { name: archived ? changeNameFromArchive(match[1]!) : match[1]!, files: new Map() }
    entry.files.set(match[2]!, file)
    directories.set(dir, entry)
  }
  const ranked = [...directories.entries()].sort(([a], [b]) => Number(b.includes('/archive/')) - Number(a.includes('/archive/')))
  const chosen = ranked.find(([, entry]) => input.changeName && entry.name === input.changeName) ?? ranked[0]
  const show = async (file: string | undefined): Promise<string | null> => {
    if (!file) return null
    const result = await git.run(['show', `${input.ref}:${file}`], repo)
    return result.code === 0 ? result.stdout.slice(0, TEXT_CAP) : null
  }
  const stat = await git.run(['diff', '--stat=120', base, input.ref, '--'], repo)
  return {
    changeName: chosen?.[1].name ?? input.changeName,
    proposal: await show(chosen?.[1].files.get('proposal')),
    design: await show(chosen?.[1].files.get('design')),
    diffstat: stat.code === 0 ? stat.stdout.slice(0, 8000) : null,
  }
}

export function createFlowPublication(
  ctx: Pick<ProjectContext, 'project' | 'db' | 'desktopDb' | 'broadcast' | 'ticketWatcher' | 'jiraSyncManager'>,
  deps: { git?: GitRunner; generate?: typeof generateSpecFromText } = {},
): FlowPublication {
  const git = deps.git ?? defaultGitRunner
  const ticketFile = () => ticketStorePathForProject(ctx.project)
  const readTicket = (ticketId: number) => readStore(ticketFile()).tickets[String(ticketId)]
  return {
    deliveryState(deliveryId) {
      const row = getPrDelivery(ctx.db, deliveryId)
      if (!row) return null
      const delivered = DELIVERED_DECISIONS.has(row.decision) && row.implementation_outcome === 'succeeded'
      return { delivered, crashed: !delivered && isCrashedFlowDelivery(toPrDeliverySnapshot(row)) }
    },
    async derivedChange(input) {
      const row = input.deliveryId ? getPrDelivery(ctx.db, input.deliveryId) : undefined
      let units: DeliverBranchRecord[] = []
      try { units = row ? JSON.parse(row.branches) as DeliverBranchRecord[] : [] } catch { units = [] }
      const unit = units.find((entry) => entry.ticketId === input.ticketId) ?? units[0]
      const ref = unit?.finalSha ?? unit?.branch ?? row?.branch ?? input.branch
      if (!ref) throw new Error('The delivered branch of this Flow is unknown')
      const metadata = readTicket(input.ticketId)?.metadata
      const changeName = typeof metadata?.openspecChangeName === 'string' ? metadata.openspecChangeName : null
      // The delivered branch lives in the Flow's repository (the project root for the primary).
      const repo = input.repositoryId ? getProjectRepositories(ctx.project).find((member) => member.id === input.repositoryId)?.path : ctx.project.path
      if (!repo) throw new Error(`The Flow's repository ${input.repositoryId} is no longer registered`)
      return readDerivedChange(git, repo, { ref, baseSha: input.baseSha, changeName })
    },
    conversationSummary(input) {
      return flowConversationSummary(ctx.desktopDb, { conversationId: input.conversationId, idea: readTicket(input.ticketId)?.description ?? null, from: input.from, to: input.to })
    },
    async rewriteSpec({ ticketId, text }) {
      const provider = (ctx.project.provider ?? 'claude') as SpecProvider
      const scope = { specrails: false, openspec: false, full: false, mcp: false, contractRefine: true, userMcp: false }
      if (!resolveSpecGenerationToolPolicy(provider, scope)) return { ok: false, error: `Provider ${provider} cannot run spec generation` }
      const model = resolveDefaultSpecModel({ projectPath: ctx.project.path, slug: ctx.project.slug, provider })
      const outcome = await (deps.generate ?? generateSpecFromText)({
        db: ctx.db,
        project: ctx.project as never,
        ticketStorePath: ticketFile(),
        ticketWatcher: ctx.ticketWatcher,
        broadcast: ctx.broadcast as (message: unknown) => void,
        admission: captureProcessAdmission(ctx.project.id),
      }, {
        text, provider, model, scope, ticketId, surface: 'flow',
        // Contract Layer always (feedback-2026-10 decision 6.2), awaited so the
        // Jira issue that follows is born with the complete spec.
        contractRefine: supportsContractRefine(getAdapter(provider)) ? { model: null, await: true } : null,
        hooks: {
          onPersisted: (ticket) => {
            try { ctx.broadcast({ type: 'ticket_updated', ticket: ticket as never, projectId: ctx.project.id, timestamp: new Date().toISOString() }) } catch { /* clients rehydrate */ }
          },
        },
      })
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
    },
    jira: {
      connected: () => { try { return ctx.jiraSyncManager.isActive() } catch { return false } },
      enqueueCreate: (ticketId, key) => ctx.jiraSyncManager.enqueuePromote(ticketId, key),
      enqueueUpdate: (ticketId, key) => ctx.jiraSyncManager.enqueueSpecUpdate(ticketId, key),
      linked: (ticketId) => { try { const link = getLinkByLocalId(ctx.db, ticketId); return Boolean(link && !link.tombstoned) } catch { return false } },
      enqueueReview: (ticketId, refId) => ctx.jiraSyncManager.onRailReview([ticketId], refId),
    },
  }
}

/** Periodic retry of due settlement effects (backoff lives in the rows). */
export function startFlowSettlementScheduler(service: Pick<FlowService, 'runDueSettlements'>, intervalMs = 30_000): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void service.runDueSettlements().catch(() => undefined).finally(() => { running = false })
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

/** Active OpenSpec changes in the worktree that are neither in the base commit nor already the Flow's. */
async function unknownActiveChanges(git: GitRunner, worktreePath: string, baseSha: string | null, known: string[]): Promise<string[]> {
  let names: string[]
  try {
    names = fs.readdirSync(path.join(worktreePath, 'openspec', 'changes'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive' && isOpenSpecChangeId(entry.name))
      .map((entry) => entry.name)
  } catch { return [] }
  if (!names.length) return []
  const baseline = new Set<string>()
  if (baseSha) {
    const listed = await git.run(['ls-tree', '-d', '--name-only', `${baseSha}:openspec/changes`], worktreePath).catch(() => null)
    if (listed?.code === 0) for (const name of listed.stdout.split('\n')) if (name.trim()) baseline.add(name.trim())
  }
  return names.filter((name) => !baseline.has(name) && !known.includes(name))
}
