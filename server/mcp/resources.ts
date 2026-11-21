import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SubscribeRequestSchema, UnsubscribeRequestSchema, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { fullGuide } from './guide'
import { serializeProject } from './tools/projects'
import type { McpToolContext, McpToolSpec } from './tools/types'
import { McpApiError } from './tools/types'
import { isToolResponse } from './tools/envelope'
import { collectStatus } from './tools/status'
import { collectBoard } from './tools/board'
import { getProject, listProjects } from '../desktop-db'
import type { WsMessage } from '../types'

/**
 * Read-only state exposed as MCP resources (never mutating, read tier):
 *
 *   specrails://guide, specrails://projects, specrails://projects/{projectId}
 *   specrails://status                     — the specrails_status snapshot
 *   specrails://projects/{projectId}/board — the specrails_board snapshot
 *   specrails://jobs/{jobId}               — a job with its latest events (any project)
 *   specrails://missions/{conversationId}  — a mission with its latest messages
 *
 * Clients may `resources/subscribe` to any of them: the app's own WebSocket
 * events that change a resource (job/run/rail updates, inbox triggers,
 * mission activity, spec changes) send `notifications/resources/updated`,
 * debounced per URI. Clients that do not subscribe poll specrails_status with
 * its etag instead.
 */

export const RESOURCE_DEBOUNCE_MS = 1_000
const JOB_EVENTS = 20

const json = (uri: URL, value: unknown): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
})

/** Run a catalog tool handler and return its payload (envelope metadata dropped). */
async function toolData(specs: readonly McpToolSpec[], ctx: McpToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const spec = specs.find((candidate) => candidate.name === name)
  if (!spec) throw new Error(`Tool ${name} is not registered.`)
  const result = await spec.handler({ ...ctx }, args)
  return isToolResponse(result) ? result.data : result
}

/** Find the project that owns a job id (active project first). */
async function findJob(ctx: McpToolContext, specs: readonly McpToolSpec[], jobId: string): Promise<unknown> {
  const projects = (ctx.registry.listContexts?.() ?? []).map((context) => context.project.id)
  for (const projectId of projects) {
    try {
      const data = await toolData(specs, ctx, 'specrails_jobs', { action: 'get', projectId, jobId, eventLimit: JOB_EVENTS }) as Record<string, unknown>
      return { projectId, ...data }
    } catch (err) {
      if (err instanceof McpApiError && err.status === 404) continue
      throw err
    }
  }
  throw new Error(`Unknown job "${jobId}" in the loaded projects.`)
}

export function registerResources(server: McpServer, ctx: McpToolContext, specs: readonly McpToolSpec[] = []): void {
  server.registerResource(
    'guide',
    'specrails://guide',
    { title: 'Specrails platform guide', description: 'Concepts, workflow and invariants for operating Specrails.', mimeType: 'text/markdown' },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, text: fullGuide() }],
    }),
  )

  server.registerResource(
    'projects',
    'specrails://projects',
    { title: 'Projects', description: 'All registered Specrails projects.', mimeType: 'application/json' },
    async (uri): Promise<ReadResourceResult> => json(uri, listProjects(ctx.desktopDb).map(serializeProject)),
  )

  server.registerResource(
    'status',
    'specrails://status',
    { title: 'App status', description: 'What runs, what needs the person, recent failures, spend today (the specrails_status snapshot, with its etag).', mimeType: 'application/json' },
    async (uri): Promise<ReadResourceResult> => json(uri, await collectStatus(ctx)),
  )

  server.registerResource(
    'project',
    new ResourceTemplate('specrails://projects/{projectId}', { list: undefined }),
    { title: 'Project', description: 'A single project by id.', mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> => {
      const projectId = String(variables.projectId)
      const project = getProject(ctx.desktopDb, projectId)
      if (!project) throw new Error(`Unknown projectId "${projectId}".`)
      return json(uri, serializeProject(project))
    },
  )

  server.registerResource(
    'board',
    new ResourceTemplate('specrails://projects/{projectId}/board', {
      list: async () => ({
        resources: listProjects(ctx.desktopDb).map((project) => ({
          uri: `specrails://projects/${project.id}/board`, name: `${project.name} board`, mimeType: 'application/json',
        })),
      }),
    }),
    { title: 'Project board', description: 'Backlog columns, rails and what is running (the specrails_board snapshot).', mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> => json(uri, await collectBoard({ ...ctx }, String(variables.projectId))),
  )

  server.registerResource(
    'job',
    new ResourceTemplate('specrails://jobs/{jobId}', { list: undefined }),
    { title: 'Job', description: `A job of any loaded project with its latest ${JOB_EVENTS} events.`, mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> => json(uri, await findJob(ctx, specs, String(variables.jobId))),
  )

  server.registerResource(
    'mission',
    new ResourceTemplate('specrails://missions/{conversationId}', { list: undefined }),
    { title: 'Mission', description: 'A mission (agent conversation) with its state and latest messages.', mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> =>
      json(uri, await toolData(specs, ctx, 'specrails_missions', { action: 'get', conversationId: String(variables.conversationId) })),
  )
}

// ── Subscriptions ────────────────────────────────────────────────────────────

const STATUS_TYPES = new Set([
  'queue', 'rail.job_started', 'rail.job_stopped', 'rail.job_completed', 'rail.pr_state', 'rail.updated', 'rail.removed', 'job.stuck',
  'loop.run_started', 'loop.run_paused', 'loop.run_resumed', 'loop.run_stopped', 'loop.run_completed',
  'agent_done', 'agent_error', 'agent_conversation_created', 'agent_run_failure', 'agent_pr_decision', 'mission.updated',
  'spending.invalidated', 'jira.outbox_changed', 'inbox.changed',
])
const BOARD_TYPES = new Set([
  'queue', 'ticket_created', 'ticket_updated', 'ticket_deleted',
  'rail.job_started', 'rail.job_stopped', 'rail.job_completed', 'rail.pr_state', 'rail.updated', 'rail.removed',
  'loop.run_started', 'loop.run_stopped', 'loop.run_completed',
])
/** High-volume stream frames never notify on their own. */
const NOISE = new Set(['log', 'agent_stream', 'agent_partial', 'chat_stream', 'spec_gen_stream', 'agent_refine_stream'])

/** The resource URIs a broadcast WebSocket message may have changed. Pure. */
export function resourceUrisFor(msg: WsMessage): string[] {
  const type = String((msg as { type?: unknown }).type ?? '')
  if (!type || NOISE.has(type)) return []
  const fields = msg as { projectId?: unknown; jobId?: unknown; conversationId?: unknown; chatId?: unknown }
  const uris: string[] = []
  if (STATUS_TYPES.has(type)) uris.push('specrails://status')
  if (typeof fields.projectId === 'string' && BOARD_TYPES.has(type)) uris.push(`specrails://projects/${fields.projectId}/board`)
  if (typeof fields.jobId === 'string' && fields.jobId) uris.push(`specrails://jobs/${fields.jobId}`)
  const conversationId = typeof fields.conversationId === 'string' ? fields.conversationId : null
  if (conversationId && (type.startsWith('agent') || type.startsWith('mission'))) uris.push(`specrails://missions/${conversationId}`)
  return uris
}

/** The session's subscriptions: call to dispose; `notify(uri)` sends a debounced update when `uri` is subscribed. */
export type ResourceSubscriptions = (() => void) & { notify(uri: string): void }

/**
 * Accepts `resources/subscribe` / `unsubscribe` for this MCP session and turns
 * matching app events into debounced `notifications/resources/updated`.
 * Returns the disposer (called when the session closes); its `notify` lets
 * other sources of change (the v2 event journal) share the same subscriptions.
 */
export function registerResourceSubscriptions(server: McpServer, ctx: McpToolContext, options: { debounceMs?: number } = {}): ResourceSubscriptions {
  const debounceMs = options.debounceMs ?? RESOURCE_DEBOUNCE_MS
  const subscribed = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } })
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribed.add(request.params.uri)
    return {}
  })
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribed.delete(request.params.uri)
    const timer = timers.get(request.params.uri)
    if (timer) { clearTimeout(timer); timers.delete(request.params.uri) }
    return {}
  })
  let disposed = false
  const notify = (uri: string) => {
    if (disposed || !subscribed.has(uri) || timers.has(uri)) return
    const timer = setTimeout(() => {
      timers.delete(uri)
      if (!subscribed.has(uri)) return
      server.server.sendResourceUpdated({ uri }).catch(() => { /* the session may have closed */ })
    }, debounceMs)
    timer.unref?.()
    timers.set(uri, timer)
  }
  const stop = ctx.eventBus.onMessage((msg) => {
    if (!subscribed.size) return
    for (const uri of resourceUrisFor(msg)) notify(uri)
  })
  const dispose = () => {
    disposed = true
    stop()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    subscribed.clear()
  }
  return Object.assign(dispose, { notify })
}
