// Composition for the project rules inventory (feedback-2026-10 task 4.4).
// The project-rules module owns parsing, the Core inventory run and the HTTP
// adapter; this file binds them to the request's project, ticket store and
// broadcast.
import type { Request } from 'express'
import { corePhase3Capabilities } from './modules/agent-runtime/runtime/core-capabilities'
import { registerProjectRulesHttp } from './modules/project-rules/adapters/http'
import { rulesInventoryRuns } from './modules/project-rules/runtime/rules-inventory-runs'
import { mutateStore, type Ticket } from './modules/specs/runtime/ticket-store'
import type { ProjectRoutesDeps } from './project-router-helpers'
import type { LocalTicket, TicketCreatedMessage } from './types'

export function registerRulesRoutes({ router, ctx, ticketPath }: ProjectRoutesDeps): void {
  // Phase-3 Core capabilities for the settings UI (each surface gates on its own flag).
  router.get('/:projectId/core/phase3-capabilities', async (_req, res) => {
    res.json(await corePhase3Capabilities())
  })
  registerProjectRulesHttp(router, (req: Request) => {
    const context = ctx(req)
    return {
      project: { id: context.project.id, slug: context.project.slug, path: context.project.path },
      supported: async () => (await corePhase3Capabilities()).rulesInventory,
      createRuleSpec: (fields) => {
        const now = new Date().toISOString()
        let created: Ticket | undefined
        const store = mutateStore(ticketPath(req), (s) => {
          const id = s.next_id++
          created = {
            id,
            title: fields.title,
            description: fields.description,
            status: 'todo',
            priority: 'medium',
            labels: fields.labels,
            assignee: null,
            prerequisites: [],
            metadata: {},
            comments: [],
            origin_conversation_id: null,
            is_epic: false,
            parent_epic_id: null,
            execution_order: null,
            short_summary: null,
            nonGoals: fields.nonGoals,
            created_at: now,
            updated_at: now,
            created_by: 'rules-inventory',
            source: 'rules',
          }
          s.tickets[String(id)] = created
        })
        context.ticketWatcher.notifyDesktopWrite(store.revision)
        const message: TicketCreatedMessage = { type: 'ticket_created', ticket: created as unknown as LocalTicket, projectId: context.project.id, timestamp: now }
        context.broadcast(message)
        return created
      },
    }
  }, rulesInventoryRuns)
}
