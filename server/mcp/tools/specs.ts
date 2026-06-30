import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

// Mirror of the McpTier union (mcp-tiers) — `./types` re-imports but does not
// re-export it, so we restate the literal union to keep imports to zod + ./types.
type McpTier = 'read' | 'write' | 'ai-spawn' | 'destructive'

// Per-action danger classification for the specs (tickets) facade.
const DESTRUCTIVE_ACTIONS = new Set(['delete', 'smash_undo', 'delete_epic_children'])
// `create` routes through Quick Add Spec (generate-spec) so MCP-created specs
// match the app's "Add Spec → Quick" flow — hence ai-spawn, not write.
const AI_SPAWN_ACTIONS = new Set(['create', 'generate', 'ai_edit', 'contract_refine', 'smash'])
// `commit_draft` (POST /tickets/from-draft) may fire-and-forget a Contract
// Refine spawn as a side-effect, but the call itself is a synchronous store
// mutation (a write), so it is classified as `write`.
const WRITE_ACTIONS = new Set([
  'update', 'from_prompt', 'save_draft', 'commit_draft', 'cancel_ai_edit',
])

function resolveSpecsTier(action: string): McpTier {
  if (DESTRUCTIVE_ACTIONS.has(action)) return 'destructive'
  if (AI_SPAWN_ACTIONS.has(action)) return 'ai-spawn'
  if (WRITE_ACTIONS.has(action)) return 'write'
  return 'read'
}

const WATCH_HINT =
  'Returns 202 immediately; the actual result streams over the WebSocket. ' +
  'Use specrails_watch with the returned requestId/scheduled ref to await completion ' +
  '(WS events: spec_gen_*, ticket_ai_edit_*, explore.contract_refine_*, smash.*).'

export function specsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_specs',
      title: 'Specs (Tickets)',
      description:
        'Manage the spec/ticket backlog for a project (the local-tickets.json store). ' +
        'Actions: list, get, ' +
        'create (ai-spawn — THE way to add a spec: routes through Quick Add Spec, so the specrails agent generates a structured spec with AI from the user request, exactly matching the app\'s "Add Spec → Quick" flow; pass the request as title/description, it becomes the idea; async), ' +
        'update, delete (destructive), ' +
        'from_prompt (verbatim insert, no AI — use ONLY when you already have a complete finished spec to store as-is), ' +
        'save_draft (persist an Explore conversation as a draft), commit_draft (flip a draft to a real spec), ' +
        'generate (alias of create — Quick AI spec generation), ai_edit (ai-spawn, AI-edit a ticket title+description), ' +
        'cancel_ai_edit (abort an in-flight ai-edit), contract_refine (ai-spawn, append a Contract Layer — Claude-only), ' +
        'smash (ai-spawn, decompose a spec into N child sub-specs under an epic — Claude-only), ' +
        'smash_undo (destructive, reverse a prior SMASH), delete_epic_children (destructive, delete all children of an epic), ' +
        'spending_summary (per-ticket AI spend), files_touched (provenance of files an AI job touched for this ticket), ' +
        'list_attachments, get_attachment. The generate/ai_edit/contract_refine/smash actions are async (HTTP 202) — ' +
        'results arrive over the WebSocket, not the HTTP response.',
      hintTier: 'read',
      tier: (args) => resolveSpecsTier(args.action as string),
      inputSchema: {
        action: z
          .enum([
            'list',
            'get',
            'create',
            'update',
            'delete',
            'from_prompt',
            'save_draft',
            'commit_draft',
            'generate',
            'ai_edit',
            'cancel_ai_edit',
            'contract_refine',
            'smash',
            'smash_undo',
            'delete_epic_children',
            'spending_summary',
            'files_touched',
            'list_attachments',
            'get_attachment',
          ])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),

        // ── Ticket identity ──────────────────────────────────────────────
        id: z
          .number()
          .int()
          .optional()
          .describe('Numeric ticket id (get/update/delete/contract_refine/smash/smash_undo/delete_epic_children/spending_summary/files_touched/ai_edit)'),

        // ── list filters ─────────────────────────────────────────────────
        status: z
          .string()
          .optional()
          .describe('list: filter by status (CSV: draft|todo|in_progress|done|cancelled). create/update: set ticket status'),
        label: z.string().optional().describe('list: filter by label (CSV)'),
        q: z.string().optional().describe('list: free-text search over title + description'),

        // ── create / update / from_prompt / commit_draft fields ──────────
        title: z.string().optional().describe('Ticket title (required for create / commit_draft)'),
        description: z
          .string()
          .optional()
          .describe('Ticket description. For ai_edit this is the REQUIRED current baseline description'),
        priority: z
          .enum(['critical', 'high', 'medium', 'low'])
          .optional()
          .describe('Ticket priority (defaults to medium; may be null only for drafts)'),
        labels: z.array(z.string()).optional().describe('Labels array'),
        assignee: z.string().optional().describe('create/update: assignee'),
        prerequisites: z.array(z.number().int()).optional().describe('create/update: prerequisite ticket ids'),
        metadata: z.record(z.unknown()).optional().describe('create/update: free-form metadata object'),
        source: z.string().optional().describe('create: source tag'),
        acceptanceCriteria: z
          .array(z.string())
          .optional()
          .describe('update/commit_draft: acceptance-criteria bullets folded into the description'),
        shortSummary: z.string().optional().describe('commit_draft: explicit short summary (camelCase key)'),
        short_summary: z.string().optional().describe('update: explicit short summary (snake_case key; null clears)'),
        structured: z.boolean().optional().describe('from_prompt: lightly structure the verbatim prompt'),
        createLocal: z.boolean().optional().describe('commit_draft/generate: keep the spec local (skip Jira promote)'),

        // ── draft linkage ────────────────────────────────────────────────
        conversationId: z
          .string()
          .optional()
          .describe('save_draft (required) / commit_draft: origin Explore conversation id'),
        draftTicketId: z.number().int().optional().describe('commit_draft: explicit draft ticket id to flip in place'),
        editTicketId: z.number().int().optional().describe('save_draft: existing ticket id to demote to a draft in place'),
        pendingSpecId: z
          .string()
          .optional()
          .describe('generate/from_prompt/commit_draft: pending-spec UUID owning pre-creation attachments'),

        // ── generate (Quick AI spec) ─────────────────────────────────────
        idea: z.string().optional().describe('generate: the idea/prompt to turn into a spec (required)'),
        model: z.string().optional().describe('generate/smash: model override (validated against the provider catalog)'),
        aiEngine: z
          .string()
          .optional()
          .describe('generate: provider/engine override (must be an installed provider; defaults to primary)'),
        contextScope: z
          .record(z.unknown())
          .optional()
          .describe('generate: context-awareness flags {specrails,openspec,full,mcp,userMcp,contractRefine}'),
        contractRefine: z.boolean().optional().describe('generate: enrich the spec with a Contract Layer (Claude-only)'),
        attachmentIds: z.array(z.string()).optional().describe('generate: attachment ids (requires pendingSpecId)'),

        // ── ai_edit ──────────────────────────────────────────────────────
        instructions: z.string().optional().describe('ai_edit: natural-language editing instructions (required)'),
        priorInstructions: z.array(z.string()).optional().describe('ai_edit: prior refinement turns for an iterative edit'),
        priorProposal: z.string().optional().describe('ai_edit: the previous turn proposal to refine'),
        requestId: z.string().optional().describe('cancel_ai_edit: requestId of the in-flight ai-edit to abort (required)'),

        // ── smash ────────────────────────────────────────────────────────
        mode: z.enum(['simple', 'full']).optional().describe('smash: decomposition mode (default simple)'),
        smashedAt: z.string().optional().describe('smash_undo: the smashedAt timestamp of the SMASH to reverse (required)'),

        // ── attachments ──────────────────────────────────────────────────
        ticketId: z
          .string()
          .optional()
          .describe('list_attachments/get_attachment: ticket numeric id or pending-spec UUID'),
        attachmentId: z.string().optional().describe('get_attachment: attachment id (required)'),
      },
      async handler(ctx, args) {
        const base = projectPath(ctx, args.projectId as string | undefined)
        const action = args.action as string

        const requireId = (): number => {
          const id = args.id as number | undefined
          if (typeof id !== 'number' || !Number.isInteger(id)) {
            throw new Error(`Action "${action}" requires a numeric "id".`)
          }
          return id
        }

        switch (action) {
          // ── reads ──────────────────────────────────────────────────────
          case 'list': {
            const qs = new URLSearchParams()
            if (typeof args.status === 'string') qs.set('status', args.status)
            if (typeof args.label === 'string') qs.set('label', args.label)
            if (typeof args.q === 'string') qs.set('q', args.q)
            const suffix = qs.toString() ? `?${qs.toString()}` : ''
            return apiCall(ctx, 'GET', `${base}/tickets${suffix}`)
          }
          case 'get':
            return apiCall(ctx, 'GET', `${base}/tickets/${requireId()}`)
          case 'spending_summary':
            return apiCall(ctx, 'GET', `${base}/tickets/${requireId()}/spending-summary`)
          case 'files_touched':
            return apiCall(ctx, 'GET', `${base}/code/provenance?ticketId=${requireId()}`)
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
            return apiCall(
              ctx,
              'GET',
              `${base}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`,
            )
          }

          // ── writes (synchronous store mutations) ────────────────────────
          case 'create': {
            // Route through Quick Add Spec (POST /tickets/generate-spec) so an
            // MCP-created spec matches the app's "Add Spec → Quick" flow: the
            // specrails agent generates a structured spec (source 'propose-spec')
            // following the project's conventions, instead of a raw insert of
            // whatever the external LLM wrote. The user's request becomes the
            // `idea`. For a verbatim insert with no AI, use `from_prompt`.
            const idea = [args.title, args.description]
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .join('\n\n')
              .trim()
            if (!idea) throw new Error('create requires a "title" and/or "description" to use as the spec idea.')
            const r = await apiCall(ctx, 'POST', `${base}/tickets/generate-spec`, {
              idea,
              model: args.model,
              aiEngine: args.aiEngine,
              provider: args.provider,
              contractRefine: args.contractRefine,
            })
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
            })
          case 'from_prompt':
            return apiCall(ctx, 'POST', `${base}/tickets/from-prompt`, {
              description: args.description,
              title: args.title,
              labels: args.labels,
              priority: args.priority,
              structured: args.structured,
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
            })
          }
          case 'commit_draft':
            return apiCall(ctx, 'POST', `${base}/tickets/from-draft`, {
              title: args.title,
              description: args.description,
              draftTicketId: args.draftTicketId,
              conversationId: args.conversationId,
              pendingSpecId: args.pendingSpecId,
              labels: args.labels,
              acceptanceCriteria: args.acceptanceCriteria,
              priority: args.priority,
              shortSummary: args.shortSummary,
              createLocal: args.createLocal,
            })
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
            const r = await apiCall(ctx, 'POST', `${base}/tickets/generate-spec`, {
              idea: args.idea,
              model: args.model,
              aiEngine: args.aiEngine,
              contextScope: args.contextScope,
              contractRefine: args.contractRefine,
              attachmentIds: args.attachmentIds,
              pendingSpecId: args.pendingSpecId,
              createLocal: args.createLocal,
            })
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
            const r = await apiCall(ctx, 'POST', `${base}/tickets/${requireId()}/contract-refine`)
            return { ...(r as Record<string, unknown>), hint: WATCH_HINT }
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
      },
    },
  ]
}
