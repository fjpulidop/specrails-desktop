import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, originConversationDefaults, projectPath, repositoryPath, type McpToolContext } from './types'
import { actionEnum, linkAliases, type ActionAlias, type ActionFields } from './actions'
import { toolResponse, type NextCall } from './envelope'
import { answeredSpecIntent, checkSpecFraming, recordSpecCommitted } from '../../modules/missions/runtime/agent-spec-framing'

// Mirror of the McpTier union (mcp-tiers) — `./types` re-imports but does not
// re-export it, so we restate the literal union to keep imports to zod + ./types.
type McpTier = 'read' | 'write' | 'ai-spawn' | 'destructive'

// Per-action danger classification for the specs (tickets) facade.
const DESTRUCTIVE_ACTIONS = new Set(['delete', 'smash_undo', 'delete_epic_children', 'delete_addendum'])
// `create` routes through Quick Add Spec (generate-spec) so MCP-created specs
// match the app's "Add Spec → Quick" flow — hence ai-spawn, not write.
const AI_SPAWN_ACTIONS = new Set(['create', 'generate', 'ai_edit', 'contract_refine', 'smash'])
// A post-commit background AI pass still incurs cost. Classify commit_draft
// using its actual side effects, not the synchronous HTTP response alone.
const WRITE_ACTIONS = new Set([
  'update', 'from_prompt', 'save_draft', 'commit_draft', 'cancel_ai_edit',
  'add_addendum', 'update_addendum', 'dismiss_addendum', 'reopen_addendum', 'restore',
])

function resolveSpecsTier(action: string, args: Record<string, unknown>): McpTier {
  if (action === 'commit_draft') {
    // Explore's stored scope governs refinement; its route does not accept an
    // opt-out override here. A standalone draft flip does not launch AI.
    if (args.conversationId) return 'ai-spawn'
    return args.draftTicketId != null || args.contractRefine === false ? 'write' : 'ai-spawn'
  }
  if (DESTRUCTIVE_ACTIONS.has(action)) return 'destructive'
  if (AI_SPAWN_ACTIONS.has(action)) return 'ai-spawn'
  if (WRITE_ACTIONS.has(action)) return 'write'
  return 'read'
}

const WATCH_HINT =
  'Returns 202 immediately; the actual result streams over the WebSocket. ' +
  'Use specrails_watch with the returned requestId/scheduled ref to await completion ' +
  '(WS events: spec_gen_*, ticket_ai_edit_*, smash.*).'

// Contract Refine settles asymmetrically: only FAILURE emits a watch-terminal
// event (explore.contract_refine_failed); success lands as a plain
// ticket_updated broadcast, which watch does not treat as terminal.
const CONTRACT_REFINE_HINT =
  'Returns 202 immediately. Failure settles via specrails_watch (explore.contract_refine_failed); ' +
  "success arrives as ticket_updated — poll specrails_specs(get) for the '## Contract Layer' section."

export const SPEC_READ_ACTIONS = ['list', 'get', 'board', 'search', 'list_addenda', 'spending_summary', 'files_touched', 'list_attachments', 'get_attachment'] as const
export const SPEC_WRITE_ACTIONS = [
  'create', 'commit_draft', 'from_prompt', 'generate', 'update', 'delete', 'restore', 'save_draft',
  'ai_edit', 'cancel_ai_edit', 'contract_refine', 'smash', 'smash_undo', 'delete_epic_children',
  'add_addendum', 'update_addendum', 'dismiss_addendum', 'reopen_addendum', 'delete_addendum',
] as const

/** Every change moved to `specrails_specs_write`; `specrails_specs(<change>)` stays a hidden alias. */
export const SPEC_ALIASES: Record<string, ActionAlias> = Object.fromEntries(
  SPEC_WRITE_ACTIONS.map((action) => [action, { tool: 'specrails_specs_write', action }]),
)

export const SPEC_READ_FIELDS: Record<string, ActionFields> = {
  list: { optional: ['status', 'label', 'q', 'limit', 'cursor', 'offset'] },
  search: { required: ['q'], optional: ['status', 'label', 'limit', 'cursor'] },
  board: { optional: ['perColumn', 'label', 'q'] },
  get: { required: ['id'] },
  list_addenda: { required: ['id'] },
  spending_summary: { required: ['id'] },
  files_touched: { required: ['id'], optional: ['repositoryId'] },
  list_attachments: { required: ['ticketId'] },
  get_attachment: { required: ['ticketId', 'attachmentId'] },
}

export const SPEC_WRITE_FIELDS: Record<string, ActionFields> = {
  create: { oneOf: ['title', 'description'], optional: ['model', 'aiEngine', 'contextScope', 'contractRefine', 'attachmentIds', 'pendingSpecId', 'createLocal', 'repositoryIds'] },
  generate: { required: ['idea'], optional: ['model', 'aiEngine', 'contextScope', 'contractRefine', 'attachmentIds', 'pendingSpecId', 'createLocal', 'repositoryIds'] },
  commit_draft: { optional: ['title', 'description', 'conversationId', 'draftTicketId', 'acceptanceCriteria', 'priority', 'labels', 'shortSummary', 'assignee', 'prerequisites', 'metadata', 'intent', 'contractRefine', 'createLocal', 'pendingSpecId', 'repositoryIds'] },
  from_prompt: { required: ['description'], optional: ['title', 'labels', 'priority', 'structured', 'pendingSpecId', 'repositoryIds'] },
  update: { required: ['id'], optional: ['title', 'description', 'status', 'priority', 'labels', 'assignee', 'prerequisites', 'metadata', 'acceptanceCriteria', 'short_summary', 'intent', 'repositoryIds'] },
  delete: { required: ['id'] },
  restore: { required: ['id'] },
  save_draft: { required: ['conversationId'], optional: ['title', 'description', 'labels', 'editTicketId', 'repositoryIds'] },
  ai_edit: { required: ['id', 'instructions', 'description'], optional: ['title', 'attachmentIds', 'priorInstructions', 'priorProposal'] },
  cancel_ai_edit: { required: ['id', 'requestId'] },
  contract_refine: { required: ['id'], optional: ['aiEngine'] },
  smash: { required: ['id'], optional: ['mode', 'model'] },
  smash_undo: { required: ['id', 'smashedAt'] },
  delete_epic_children: { required: ['id'] },
  add_addendum: { required: ['id', 'body'], optional: ['kind', 'title'] },
  update_addendum: { required: ['id', 'addendumId'], optional: ['kind', 'title', 'body'] },
  dismiss_addendum: { required: ['id', 'addendumId'] },
  reopen_addendum: { required: ['id', 'addendumId'] },
  delete_addendum: { required: ['id', 'addendumId'] },
}

/** Board columns in workflow order; unknown statuses follow. */
export const BOARD_COLUMNS = ['draft', 'todo', 'in_progress', 'on_review', 'done', 'cancelled'] as const

type Row = Record<string, unknown>
const asRecord = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}

/** The compact spec row every listing returns (the full spec comes from get). */
export function compactSpec(ticket: Row): Row {
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    labels: ticket.labels,
    ...(ticket.repositoryIds === undefined ? {} : { repositoryIds: ticket.repositoryIds }),
    ...(ticket.needs_review === true ? { needsReview: true } : {}),
    shortSummary: ticket.short_summary ?? ticket.shortSummary ?? null,
    updatedAt: ticket.updated_at ?? ticket.updatedAt,
  }
}

/**
 * list/search: paged on the server (`GET /tickets?limit&cursor`), so only the
 * requested page crosses the loopback. `offset` stays accepted for older clients.
 */
async function listSpecs(ctx: McpToolContext, base: string, args: Row): Promise<unknown> {
  if (args.action === 'search' && (typeof args.q !== 'string' || !args.q.trim())) throw new Error('search requires a "q" (free text over title and description).')
  const qs = new URLSearchParams()
  for (const key of ['status', 'label', 'q'] as const) if (typeof args[key] === 'string') qs.set(key, args[key] as string)
  const limit = typeof args.limit === 'number' ? args.limit : args.action === 'search' ? 20 : 50
  qs.set('limit', String(limit))
  if (typeof args.cursor === 'string' && args.cursor) qs.set('cursor', args.cursor)
  else if (typeof args.offset === 'number') qs.set('offset', String(args.offset))
  const result = asRecord(await apiCall(ctx, 'GET', `${base}/tickets?${qs.toString()}`))
  let tickets = Array.isArray(result.tickets) ? result.tickets.map(asRecord) : []
  let offset = typeof result.offset === 'number' ? result.offset : 0
  let nextOffset = typeof result.nextOffset === 'number' ? result.nextOffset : null
  const nextCursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
  let matched = result.matched
  if (typeof result.limit !== 'number') {
    // A server without route paging answered the whole match: page it here.
    offset = typeof args.offset === 'number' ? args.offset : 0
    matched = tickets.length
    const page = tickets.slice(offset, offset + limit)
    nextOffset = offset + page.length < tickets.length ? offset + page.length : null
    tickets = page
  }
  return {
    tickets: tickets.map(compactSpec),
    revision: result.revision,
    total: result.total ?? tickets.length,
    matched: matched ?? tickets.length,
    statusCounts: result.statusCounts ?? undefined,
    offset,
    limit,
    nextOffset,
    nextCursor,
    ...(result.cursorStale === true ? { cursorStale: true } : {}),
    hint: nextCursor == null && nextOffset == null
      ? 'List complete. Use get(id) for the full description and acceptance criteria.'
      : `More specs are available. Pass ${nextCursor ? 'cursor=nextCursor' : `offset=${nextOffset}`}; use get(id) for full details.`,
  }
}

export interface BoardColumn { status: string; count: number; top: Row[] }

/** Backlog columns with counts and the newest items of each (`GET /tickets?groupBy=status`). */
export async function readBoardColumns(ctx: McpToolContext, base: string, options: { perColumn?: number; label?: string; q?: string } = {}): Promise<{ columns: BoardColumn[]; total: number; matched: number; revision: unknown }> {
  const qs = new URLSearchParams({ groupBy: 'status', perGroup: String(options.perColumn ?? 5) })
  if (options.label) qs.set('label', options.label)
  if (options.q) qs.set('q', options.q)
  const result = asRecord(await apiCall(ctx, 'GET', `${base}/tickets?${qs.toString()}`))
  const groups = new Map((Array.isArray(result.groups) ? result.groups.map(asRecord) : []).map((group) => [String(group.status), group]))
  const order = [...BOARD_COLUMNS, ...[...groups.keys()].filter((status) => !(BOARD_COLUMNS as readonly string[]).includes(status))]
  const columns = order.map((status) => {
    const group = groups.get(status)
    return { status, count: typeof group?.count === 'number' ? group.count : 0, top: (Array.isArray(group?.tickets) ? group.tickets.map(asRecord) : []).map(compactSpec) }
  })
  return { columns, total: typeof result.total === 'number' ? result.total : 0, matched: typeof result.matched === 'number' ? result.matched : 0, revision: result.revision }
}

export function boardColumnsText(columns: BoardColumn[]): string {
  return columns.filter((column) => column.count > 0).map((column) => `${column.status.replace(/_/g, ' ')} ${column.count}`).join(', ') || 'empty'
}

export function specsTools(): McpToolSpec[] {
  return linkAliases([specsReadTool(), specsWriteTool()])
}

function specsReadTool(): McpToolSpec {
  return {
    name: 'specrails_specs',
    title: 'Specs (read)',
    description:
      'Read a project\'s spec backlog. Actions: list (compact page; cursor for the next), search (q over title and description), ' +
      'board (status columns with counts and the newest items), get (full spec incl. acceptance criteria and addenda), list_addenda, ' +
      'spending_summary (per-spec AI spend), files_touched (provenance of files AI jobs touched), list_attachments, get_attachment (metadata + download path). ' +
      'Create or change specs with specrails_specs_write. Arguments per action: specrails_describe.',
    tier: 'read',
    aliases: SPEC_ALIASES,
    actionFields: SPEC_READ_FIELDS,
    inputSchema: {
      action: actionEnum(SPEC_READ_ACTIONS, SPEC_WRITE_ACTIONS),
      projectId: z.string().optional().describe('Project id (defaults to the active project)'),
      id: z.number().int().optional().describe('Numeric spec id'),
      status: z.string().optional().describe('list/search: CSV status filter (draft|todo|in_progress|on_review|done|cancelled)'),
      label: z.string().optional().describe('list/search/board: label filter (CSV)'),
      q: z.string().optional().describe('search (required) / list / board: free text over title + description'),
      limit: z.number().int().nonnegative().max(100).optional().describe('list/search: page size (default 50; search 20)'),
      cursor: z.string().max(512).optional().describe('list/search: nextCursor of the previous page'),
      offset: z.number().int().nonnegative().optional().describe('list: zero-based offset (prefer cursor)'),
      perColumn: z.number().int().min(0).max(20).optional().describe('board: newest items per column (default 5)'),
      repositoryId: z.string().min(1).optional().describe('files_touched: repository to inspect; required for multi-repository projects'),
      ticketId: z.string().optional().describe('list_attachments/get_attachment: spec numeric id or pending-spec UUID'),
      attachmentId: z.string().optional().describe('get_attachment: attachment id'),
    },
    async handler(ctx, args) {
      if (args.action === 'board') {
        const base = projectPath(ctx, args.projectId as string | undefined)
        const board = await readBoardColumns(ctx, base, { perColumn: args.perColumn as number | undefined, label: args.label as string | undefined, q: args.q as string | undefined })
        const projectId = typeof args.projectId === 'string' ? args.projectId : undefined
        const scope = projectId ? { projectId } : {}
        const firstTodo = board.columns.find((column) => column.status === 'todo')?.top[0]
        const next: NextCall[] = [{ tool: 'specrails_board', args: scope, why: 'The same columns plus rails and what is running.' }]
        if (firstTodo?.id !== undefined) next.unshift({ tool: 'specrails_specs', args: { action: 'get', id: firstTodo.id, ...scope }, why: 'Read the newest todo spec in full.' })
        return toolResponse(board, {
          summary: board.total ? `Backlog of ${board.total} specs: ${boardColumnsText(board.columns)}.` : 'The backlog is empty.',
          next,
        })
      }
      return specsHandler(ctx, args)
    },
  }
}

function specsWriteTool(): McpToolSpec {
  return {
    name: 'specrails_specs_write',
    title: 'Specs (changes)',
    description:
      'Create and change specs. Actions: create (ai-spawn — THE way to add a spec from a request: Quick Add Spec generates it with AI; async), ' +
      'commit_draft (persist a COMPLETE spec you authored, or flip an Explore draft; a Contract Layer is added by default — never ask about it; write without refinement, else ai-spawn), ' +
      'from_prompt (write — verbatim insert, no AI), generate (ai-spawn — create from an idea string), update (write), delete (destructive, soft: 30 days in Recently deleted), restore (write), ' +
      'save_draft (write — Explore conversation as a draft), ai_edit (ai-spawn), cancel_ai_edit (write), contract_refine (ai-spawn), smash (ai-spawn — split into child specs), ' +
      'smash_undo / delete_epic_children (destructive), add_addendum (write — THE way to iterate on an existing spec: it rides into the next launch), update_addendum / dismiss_addendum / reopen_addendum (write), delete_addendum (destructive). ' +
      'AI actions answer 202; await them with specrails_watch. Recipes: specrails_guide. Arguments per action: specrails_describe.',
    hintTier: 'write',
    tier: (args) => resolveSpecsTier(args.action as string, args),
    actionFields: SPEC_WRITE_FIELDS,
    inputSchema: {
      action: actionEnum(SPEC_WRITE_ACTIONS),
      projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        repositoryIds: z.array(z.string().min(1)).min(1).max(50).optional().describe('Affected repository memberships of this spec (omit to keep the scope)'),
        id: z
          .number()
          .int()
          .optional()
          .describe('Numeric spec id'),
        status: z
          .string()
          .optional()
          .describe('update: ticket status (job outcomes set in_progress/on_review/done automatically; do not fight the pipeline)'),
        title: z.string().optional().describe('Ticket title (required for create / commit_draft)'),
        description: z
          .string()
          .optional()
          .describe('Ticket description. For ai_edit this is the REQUIRED current baseline description'),
        priority: z
          .enum(['critical', 'high', 'medium', 'low'])
          .nullable()
          .optional()
          .describe('update/from_prompt/commit_draft: ticket priority. update: null allowed only for drafts'),
        labels: z.array(z.string()).optional().describe('update/from_prompt/save_draft/commit_draft: labels array'),
        assignee: z.string().nullable().optional().describe('update/commit_draft: assignee; null clears'),
        prerequisites: z.array(z.number().int()).optional().describe('update/commit_draft: prerequisite ticket ids'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('update/commit_draft: metadata (update merges keys; regressionOf = delivery id that introduced this bug)'),
        acceptanceCriteria: z
          .array(z.string())
          .optional()
          .describe('update/commit_draft: acceptance-criteria bullets folded into the description'),
        shortSummary: z.string().optional().describe('commit_draft: explicit short summary (camelCase key)'),
        intent: z.object({
          problem: z.string(),
          outcome: z.string(),
          hypothesis: z.string().optional(),
          successSignals: z.array(z.string()).optional(),
          affects: z.array(z.string()).optional(),
          constraints: z.array(z.string()).optional(),
          openQuestions: z.array(z.union([z.string(), z.object({ question: z.string(), answer: z.string().optional() })])).optional(),
        }).nullable().optional()
          .describe('update/commit_draft: the spec intent (problem, outcome, signals, affects, constraints, open questions — never the solution); null clears'),
        short_summary: z.string().nullable().optional().describe('update: explicit short summary (snake_case key; null clears)'),
        structured: z.boolean().optional().describe('from_prompt: lightly structure the verbatim prompt'),
        createLocal: z.boolean().optional().describe('create/generate/commit_draft: keep the spec local (skip Jira promote)'),
        conversationId: z
          .string()
          .optional()
          .describe("save_draft/commit_draft: Explore conversation id from specrails_chat (never a mission id)"),
        draftTicketId: z.number().int().optional().describe('commit_draft: explicit draft ticket id to flip in place'),
        editTicketId: z.number().int().optional().describe('save_draft: existing ticket id to demote to a draft in place'),
        pendingSpecId: z
          .string()
          .optional()
          .describe('create/generate/from_prompt/commit_draft: pending-spec UUID owning pre-creation attachments'),
        idea: z.string().optional().describe('generate: the idea/prompt to turn into a spec (required)'),
        model: z.string().optional().describe('create/generate/smash: model override (validated against the provider catalog)'),
        aiEngine: z
          .string()
          .optional()
          .describe('create/generate/contract_refine: provider/engine override (must be installed; contract_refine cannot switch an Explore-origin provider)'),
        contextScope: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('create/generate: context-awareness flags {specrails,openspec,full,mcp,userMcp,contractRefine}'),
        contractRefine: z
          .boolean()
          .optional()
          .describe('create/generate/commit_draft: add a Contract Layer (default true, never ask; false only when the person asked for none)'),
        attachmentIds: z.array(z.string()).optional().describe('create/generate/ai_edit: attachment ids (create/generate require pendingSpecId)'),
        instructions: z.string().optional().describe('ai_edit: natural-language editing instructions (required)'),
        priorInstructions: z.array(z.string()).optional().describe('ai_edit: prior refinement turns for an iterative edit'),
        priorProposal: z.string().optional().describe('ai_edit: the previous turn proposal to refine'),
        requestId: z.string().optional().describe('cancel_ai_edit: requestId of the in-flight ai-edit to abort (required)'),
        mode: z.enum(['simple', 'full']).optional().describe('smash: decomposition mode (default simple)'),
        smashedAt: z.string().optional().describe('smash_undo: the smashedAt timestamp of the SMASH to reverse (required)'),
        addendumId: z.string().max(64).optional().describe('*_addendum: addendum id (from list_addenda)'),
        kind: z
          .enum(['change-request', 'review-feedback', 'clarification', 'constraint'])
          .optional()
          .describe('add_addendum/update_addendum: what the note is (default change-request)'),
        body: z
          .string()
          .max(8000)
          .optional()
          .describe("add_addendum/update_addendum: the note in the person's own words (markdown, ≤ 8000 chars)"),
    },
    handler: (ctx, args) => specsHandler(ctx, args),
  }
}

/** Shared dispatcher of every specs action (both tools; the enums keep them apart). */
async function specsHandler(ctx: McpToolContext, args: Record<string, unknown>): Promise<unknown> {
  const base = projectPath(ctx, args.projectId as string | undefined)
  const action = args.action as string

  const requireId = (): number => {
    const id = args.id as number | undefined
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error(`Action "${action}" requires a numeric "id".`)
    }
    return id
  }

  // Shared body builder for the two Quick Add Spec entry points
  // (POST /tickets/generate-spec): `create` derives the idea from
  // title/description, `generate` takes it pre-formed. Both forward the
  // full option set (undefined fields are dropped by JSON.stringify).
  // Contract Layer enrichment defaults ON ("super specs by default" —
  // matching the Explore Desktop preset); an explicit `contractRefine:
  // false` opts out. The server force-skips it on non-claude engines.
  const buildGenerateSpecBody = (idea: string): Record<string, unknown> => ({
    idea,
    model: args.model,
    aiEngine: args.aiEngine,
    contextScope: args.contextScope,
    contractRefine: typeof args.contractRefine === 'boolean' ? args.contractRefine : true,
    attachmentIds: args.attachmentIds,
    pendingSpecId: args.pendingSpecId,
    createLocal: args.createLocal,
    ...(args.repositoryIds === undefined ? {} : { repositoryIds: args.repositoryIds }),
  })

  switch (action) {
    // ── reads ──────────────────────────────────────────────────────
    case 'list':
    case 'search':
      return listSpecs(ctx, base, args)
    case 'get':
      return apiCall(ctx, 'GET', `${base}/tickets/${requireId()}`)
    case 'spending_summary':
      return apiCall(ctx, 'GET', `${base}/tickets/${requireId()}/spending-summary`)
    case 'files_touched':
      return apiCall(ctx, 'GET', `${repositoryPath(ctx, args.projectId as string | undefined, args.repositoryId as string | undefined)}/code/provenance?ticketId=${requireId()}`)
    case 'list_attachments': {
      const ticketId = args.ticketId as string | undefined
      if (!ticketId) throw new Error('list_attachments requires a "ticketId" (numeric id or UUID).')
      return apiCall(ctx, 'GET', `${base}/tickets/${encodeURIComponent(ticketId)}/attachments`)
    }
    case 'get_attachment': {
      const ticketId = args.ticketId as string | undefined
      const attachmentId = args.attachmentId as string | undefined
      if (!ticketId) throw new Error('get_attachment requires a "ticketId".')
      if (!attachmentId) throw new Error('get_attachment requires an "attachmentId".')
      // The download endpoint streams binary files; decoding those as
      // text corrupts their content and can exhaust the model context.
      const list = await apiCall(ctx, 'GET', `${base}/tickets/${encodeURIComponent(ticketId)}/attachments`) as { attachments?: Array<{ id: string }> }
      const attachment = list.attachments?.find((entry) => entry.id === attachmentId)
      if (!attachment) throw new Error('Attachment not found. Use list_attachments to read current attachment ids.')
      return {
        attachment,
        path: `${base}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`,
        hint: 'Attachment metadata and download path; binary content is not inlined. Fetch the authenticated REST download or open the attachment in the app.',
      }
    }

    // ── spec addenda ───────────────────────────────────────────────
    case 'list_addenda':
      return apiCall(ctx, 'GET', `${base}/tickets/${requireId()}/addenda`)
    case 'add_addendum': {
      if (typeof args.body !== 'string' || !args.body.trim()) throw new Error('add_addendum requires a non-empty "body".')
      const r = await apiCall(ctx, 'POST', `${base}/tickets/${requireId()}/addenda`, {
        kind: args.kind,
        title: args.title,
        body: args.body,
        createdBy: ctx.originConversationId ? 'agent' : 'mcp',
        originConversationId: ctx.originConversationId ?? undefined,
      }) as Record<string, unknown>
      return {
        ...r,
        hint: 'The addendum is open: respect the user\'s explicit loop selection, including factory:implement; otherwise use Implement. Rail launches continue a same-spec pending delivery, and brief every AI step with the full delta and a fresh OpenSpec target. Do not use Revision or edit openspecChangeName. Do not edit the spec description to repeat it. If warnings are returned, rewrite the addendum with update_addendum so it states outcomes, not gates, artifact edits or host access a run cannot provide.',
      }
    }
    case 'update_addendum': {
      const addendumId = args.addendumId as string | undefined
      if (!addendumId) throw new Error('update_addendum requires an "addendumId".')
      return apiCall(ctx, 'PATCH', `${base}/tickets/${requireId()}/addenda/${encodeURIComponent(addendumId)}`, {
        kind: args.kind, title: args.title, body: args.body,
      })
    }
    case 'dismiss_addendum':
    case 'reopen_addendum': {
      const addendumId = args.addendumId as string | undefined
      if (!addendumId) throw new Error(`${action} requires an "addendumId".`)
      return apiCall(ctx, 'PATCH', `${base}/tickets/${requireId()}/addenda/${encodeURIComponent(addendumId)}`, {
        status: action === 'dismiss_addendum' ? 'dismissed' : 'open',
      })
    }
    case 'delete_addendum': {
      const addendumId = args.addendumId as string | undefined
      if (!addendumId) throw new Error('delete_addendum requires an "addendumId".')
      return apiCall(ctx, 'DELETE', `${base}/tickets/${requireId()}/addenda/${encodeURIComponent(addendumId)}`)
    }

    // ── writes (synchronous store mutations) ────────────────────────
    case 'create': {
      // Route through Quick Add Spec (POST /tickets/generate-spec) so an
      // MCP-created spec matches the app's "Add Spec → Quick" flow: the
      // specrails agent generates a structured spec (source 'propose-spec')
      // following the project's conventions, instead of a raw insert of
      // whatever the external LLM wrote. The user's request becomes the
      // `idea`. For a verbatim insert with no AI, use `from_prompt`.
      // generate-spec accepts none of labels/priority/status/assignee —
      // throwing turns the likeliest silent misuse into a self-correcting error.
      if (
        args.labels !== undefined ||
        args.priority !== undefined ||
        args.status !== undefined ||
        args.assignee !== undefined
      ) {
        throw new Error(
          'create generates the spec with AI and cannot set labels/priority directly — use commit_draft (you control everything) or update after generation.',
        )
      }
      const idea = [args.title, args.description]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .join('\n\n')
        .trim()
      if (!idea) throw new Error('create requires a "title" and/or "description" to use as the spec idea.')
      const r = await apiCall(ctx, 'POST', `${base}/tickets/generate-spec`, buildGenerateSpecBody(idea))
      return { ...(r as Record<string, unknown>), hint: WATCH_HINT }
    }
    case 'update':
      return apiCall(ctx, 'PATCH', `${base}/tickets/${requireId()}`, {
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        labels: args.labels,
        assignee: args.assignee,
        prerequisites: args.prerequisites,
        metadata: args.metadata,
        acceptanceCriteria: args.acceptanceCriteria,
        short_summary: args.short_summary,
        ...(args.intent === undefined ? {} : { intent: args.intent }),
        ...(args.repositoryIds === undefined ? {} : { repositoryIds: args.repositoryIds }),
      })
    case 'from_prompt':
      return apiCall(ctx, 'POST', `${base}/tickets/from-prompt`, {
        description: args.description,
        title: args.title,
        labels: args.labels,
        priority: args.priority,
        structured: args.structured,
        ...(args.repositoryIds === undefined ? {} : { repositoryIds: args.repositoryIds }),
        pendingSpecId: args.pendingSpecId,
      })
    case 'save_draft': {
      if (!args.conversationId) throw new Error('save_draft requires a "conversationId".')
      return apiCall(ctx, 'POST', `${base}/tickets/save-as-draft`, {
        conversationId: args.conversationId,
        title: args.title,
        description: args.description,
        labels: args.labels,
        editTicketId: args.editTicketId,
        ...(args.repositoryIds === undefined ? {} : { repositoryIds: args.repositoryIds }),
      })
    }
    case 'commit_draft': {
      // Agent-authored inserts (no Explore origin) default the Contract
      // Layer enrichment ON — the same post-persist pass the app's Add
      // Spec runs — so conversationally-refined specs land as "super
      // specs" without extra plumbing. Explicit `contractRefine` always
      // wins (false = the user declined it). Explore-origin flips
      // (conversationId/draftTicketId present) are NOT defaulted: the
      // origin conversation's stored contextScope governs there.
      const agentAuthored = !args.conversationId && args.draftTicketId === undefined
      const contractRefine = typeof args.contractRefine === 'boolean'
        ? args.contractRefine
        : agentAuthored
          ? true
          : undefined
      // The framing gate (critical-spec-framing): a spec the in-app agent
      // authored may not be persisted until the conversation holds a
      // problem frame the user has answered, and one frame authorises ONE
      // spec. Applied ONLY to first-party calls carrying a conversation —
      // an external MCP client cannot render the framing card and holds no
      // conversation here, so its behaviour is byte-identical to before.
      // Throwing lands in registerTieredTool's catch, producing the same
      // errorResult shape a tier refusal does.
      const framedConversationId = ctx.firstPartyAgent ? ctx.originConversationId : null
      const agentProvider = framedConversationId ? originConversationDefaults(ctx).provider : undefined
      if (framedConversationId) {
        const refusal = checkSpecFraming(ctx.desktopDb, framedConversationId)
        if (refusal) throw new Error(refusal)
      }
      // intent-mode: the answered intent rides into the spec unless the
      // call carries its own.
      const intent = args.intent ?? (framedConversationId ? answeredSpecIntent(ctx.desktopDb, framedConversationId) : null)
      const committed = await apiCall(ctx, 'POST', `${base}/tickets/from-draft`, {
        title: args.title,
        description: args.description,
        draftTicketId: args.draftTicketId,
        conversationId: args.conversationId,
        pendingSpecId: args.pendingSpecId,
        labels: args.labels,
        acceptanceCriteria: args.acceptanceCriteria,
        priority: args.priority,
        shortSummary: args.shortSummary,
        assignee: args.assignee,
        prerequisites: args.prerequisites,
        metadata: args.metadata,
        createLocal: args.createLocal,
        ...(args.repositoryIds === undefined ? {} : { repositoryIds: args.repositoryIds }),
        contractRefine,
        agentProvider,
        ...(intent ? { intent } : {}),
      })
      // Spend the frame only on a spec that actually landed: a refusal or
      // a failed write above throws before reaching here, so nothing is
      // consumed by an attempt.
      if (framedConversationId) recordSpecCommitted(ctx.desktopDb, framedConversationId)
      return committed
    }
    case 'cancel_ai_edit': {
      if (!args.requestId) throw new Error('cancel_ai_edit requires a "requestId".')
      return apiCall(
        ctx,
        'DELETE',
        `${base}/tickets/${requireId()}/ai-edit?requestId=${encodeURIComponent(args.requestId as string)}`,
      )
    }

    // ── destructive ────────────────────────────────────────────────
    case 'delete':
      return apiCall(ctx, 'DELETE', `${base}/tickets/${requireId()}`)
    case 'restore':
      return apiCall(ctx, 'POST', `${base}/tickets/${requireId()}/restore`)
    case 'smash_undo': {
      if (!args.smashedAt) throw new Error('smash_undo requires the "smashedAt" timestamp.')
      return apiCall(ctx, 'POST', `${base}/tickets/${requireId()}/smash/undo`, {
        smashedAt: args.smashedAt,
      })
    }
    case 'delete_epic_children':
      return apiCall(ctx, 'DELETE', `${base}/tickets/${requireId()}/children`)

    // ── ai-spawn (async 202 → WS) ──────────────────────────────────
    case 'generate': {
      if (!args.idea) throw new Error('generate requires an "idea".')
      const r = await apiCall(ctx, 'POST', `${base}/tickets/generate-spec`, buildGenerateSpecBody(args.idea as string))
      return { ...(r as Record<string, unknown>), hint: WATCH_HINT }
    }
    case 'ai_edit': {
      if (!args.instructions) throw new Error('ai_edit requires "instructions".')
      if (!args.description) throw new Error('ai_edit requires the current "description" baseline.')
      const r = await apiCall(ctx, 'POST', `${base}/tickets/${requireId()}/ai-edit`, {
        instructions: args.instructions,
        description: args.description,
        title: args.title,
        attachmentIds: args.attachmentIds,
        priorInstructions: args.priorInstructions,
        priorProposal: args.priorProposal,
      })
      return { ...(r as Record<string, unknown>), hint: WATCH_HINT }
    }
    case 'contract_refine': {
      const r = await apiCall(ctx, 'POST', `${base}/tickets/${requireId()}/contract-refine`, {
        aiEngine: args.aiEngine,
      })
      return { ...(r as Record<string, unknown>), hint: CONTRACT_REFINE_HINT }
    }
    case 'smash': {
      const r = await apiCall(ctx, 'POST', `${base}/tickets/${requireId()}/smash`, {
        mode: args.mode,
        model: args.model,
      })
      return { ...(r as Record<string, unknown>), hint: WATCH_HINT }
    }

    default:
      throw new Error(`Unknown action "${action}".`)
  }
}
