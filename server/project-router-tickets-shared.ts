// Helpers shared by the ticket route registrars (project-router-tickets-*.ts):
// repository-scope validation at every authoring boundary, ticket-id path
// parameter guards with their historical 400 bodies, the provider resolution
// rule for ticket-bound structured actions, and best-effort Jira promotion of a
// newly created spec. Pure HTTP glue — no route is registered here except the
// repository-scope middleware, which registerTicketsRoutes installs first.
import type { Request, Response, NextFunction } from 'express'
import { validateTicketRepositoryIds, RepositoryValidationError } from './project-repositories'
import type { ProjectContext } from './project-registry'
import { getConversation } from './db'
import { validateRequestedProvider } from './provider-selection'
import type { Ticket } from './modules/specs/runtime/ticket-store'
import type { ProjectRoutesDeps } from './project-router-helpers'


type TicketBoundProviderResult =
  | { ok: true; provider: string }
  | { ok: false; status: 400 | 409; error: string }

/**
 * A NULL conversation provider is the intentional single-provider encoding:
 * it means "use this project's primary provider", never "use Claude".
 */
export function resolveConversationProvider(
  context: Pick<ProjectContext, 'db' | 'project'>,
  conversationId: string,
): string | null {
  const conversation = getConversation(context.db, conversationId)
  if (!conversation) return null
  return conversation.provider ?? context.project.provider ?? 'claude'
}

/**
 * Resolve a ticket-bound structured action without silently changing engines.
 * An origin conversation owns the action provider because its session/model
 * state is provider-specific. Explicit requests may confirm that provider but
 * cannot replace it; missing/stale origins fail closed.
 */
export function resolveTicketBoundProvider(
  context: Pick<ProjectContext, 'db' | 'project'>,
  ticket: Pick<Ticket, 'origin_conversation_id'>,
  requested: unknown,
): TicketBoundProviderResult {
  const requestedCheck = validateRequestedProvider(context.project, requested)
  if (!requestedCheck.ok) {
    return { ok: false, status: 400, error: requestedCheck.error }
  }
  if (!ticket.origin_conversation_id) {
    return { ok: true, provider: requestedCheck.provider }
  }

  const originProvider = resolveConversationProvider(context, ticket.origin_conversation_id)
  if (!originProvider) {
    return { ok: false, status: 409, error: 'ticket_origin_conversation_not_found' }
  }
  const originCheck = validateRequestedProvider(context.project, originProvider)
  if (!originCheck.ok) {
    return { ok: false, status: 409, error: originCheck.error }
  }
  const hasExplicitRequest = requested !== undefined && requested !== null && requested !== ''
  if (hasExplicitRequest && requestedCheck.provider !== originCheck.provider) {
    return {
      ok: false,
      status: 400,
      error: `provider '${requestedCheck.provider}' does not match ticket origin provider '${originCheck.provider}'`,
    }
  }
  return { ok: true, provider: originCheck.provider }
}

/**
 * Add Spec on a Jira-backed project: promote the freshly-created LOCAL ticket to
 * a Jira issue (best-effort, server-side). The per-spec `createLocal` escape
 * hatch keeps it local. On any failure the ticket simply stays local and a
 * non-fatal warning is broadcast — a spec is never lost to a Jira error.
 */
export async function maybePromoteSpecToJira(
  c: ProjectContext,
  ticketId: number,
  createLocal: boolean,
  broadcast: (m: unknown) => void,
): Promise<void> {
  // jiraSyncManager is always present in production (constructed per project);
  // guard defensively so partial test contexts and a disabled feature are no-ops.
  if (createLocal || !c.jiraSyncManager?.isActive()) return
  try {
    const r = await c.jiraSyncManager.promoteTicketToJira(ticketId)
    if (!r.ok) {
      broadcast({ type: 'jira.sync_error', projectId: c.project.id, reason: `Kept as a local spec — couldn't create it in Jira: ${r.error}` })
    }
  } catch (err) {
    console.error('[project-router] jira promote failed:', err)
  }
}

/** Paths whose request body may carry `repositoryIds` (validated before writes, uploads or AI). */
const REPOSITORY_SCOPED_POSTS = ['/:projectId/tickets', '/:projectId/tickets/generate-spec', '/:projectId/tickets/save-as-draft', '/:projectId/tickets/from-draft', '/:projectId/tickets/from-prompt']

/**
 * Install the repository-scope middleware. Must run before any ticket handler
 * so an invalid scope is rejected before writes, uploads or AI start; the
 * validated ids are left in `res.locals.repositoryIds`.
 */
export function registerRepositoryScopeValidation(deps: ProjectRoutesDeps): void {
  const { router, ctx } = deps
  // Validate scope at every authoring boundary before writes, uploads or AI.
  const validateRepositoryScope = (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.locals.repositoryIds = validateTicketRepositoryIds(ctx(req).project, req.body?.repositoryIds)
      next()
    } catch (err) {
      if (err instanceof RepositoryValidationError) res.status(err.status).json({ error: err.message, code: err.code })
      else next(err)
    }
  }
  router.post(REPOSITORY_SCOPED_POSTS, validateRepositoryScope)
  router.patch('/:projectId/tickets/:id', validateRepositoryScope)
}

/**
 * Bind the save-time repository scope resolver. Returns the fields to spread
 * into a persisted ticket (`{}` when the request carried no scope).
 */
export function createRepositoryScope(ctx: ProjectRoutesDeps['ctx']): (req: Request, res: Response) => { repositoryIds?: string[] } {
  return (req: Request, res: Response): { repositoryIds?: string[] } => {
    // Generation can outlive a membership change; validate again when saving.
    const ids = validateTicketRepositoryIds(ctx(req).project, res.locals.repositoryIds)
    return ids === undefined ? {} : { repositoryIds: ids }
  }
}

/**
 * Strict `:id` guard: digits only. Responds 400 `Invalid ticket ID` and
 * returns null when the parameter is not a numeric ticket id.
 */
export function requireTicketIdParam(req: Request, res: Response): string | null {
  const ticketId = req.params.id as string
  if (!/^\d+$/.test(ticketId)) { res.status(400).json({ error: 'Invalid ticket ID' }); return null }
  return ticketId
}

/**
 * Lenient `:id` guard used by the structured AI actions (parseInt semantics,
 * lowercase `invalid ticket id` body — both are part of the wire contract).
 */
export function requireParsedTicketIdParam(req: Request, res: Response): number | null {
  const ticketId = Number.parseInt(String(req.params.id ?? ''), 10)
  if (!Number.isFinite(ticketId)) {
    res.status(400).json({ error: 'invalid ticket id' }); return null
  }
  return ticketId
}
