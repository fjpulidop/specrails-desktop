// Ticket (spec) routes on the shared project router. This file is the
// composition point only: each sub-resource registers its own routes from a
// focused project-router-tickets-*.ts file, and this function fixes the order.
//
// Registration order is part of the contract (Express matches first-registered):
//   1. Repository-scope middleware precedes every authoring handler.
//   2. Trash routes precede GET /tickets/:id (`trash` is not a ticket id) and the
//      two-segment DELETE routes that `/tickets/trash/:id` would otherwise lose to
//      (`/:id/children`, `/:id/ai-edit`, `/:ticketId/attachments`).
//   All other ticket paths differ by literal segment or segment count, so the
//   remaining groups cannot shadow each other.
import type { ProjectRoutesDeps } from './project-router-helpers'
import { registerRepositoryScopeValidation } from './project-router-tickets-shared'
import { registerTicketTrashRoutes } from './project-router-tickets-trash'
import { registerTicketCrudRoutes } from './project-router-tickets-crud'
import { registerTicketAuthoringRoutes } from './project-router-tickets-authoring'
import { registerTicketDraftRoutes } from './project-router-tickets-drafts'
import { registerTicketAiActionRoutes } from './project-router-tickets-ai-actions'
import { registerTicketAddendaRoutes } from './project-router-tickets-addenda'
import { registerTicketAiEditRoutes } from './project-router-tickets-ai-edit'
import { registerTicketAttachmentRoutes } from './project-router-tickets-attachments'
import { registerTicketBulkRoutes } from './project-router-tickets-bulk'

export function registerTicketsRoutes(deps: ProjectRoutesDeps): void {
  registerRepositoryScopeValidation(deps)
  registerTicketTrashRoutes(deps)
  registerTicketCrudRoutes(deps)
  registerTicketAuthoringRoutes(deps)
  registerTicketDraftRoutes(deps)
  registerTicketAiActionRoutes(deps)
  registerTicketAddendaRoutes(deps)
  registerTicketAiEditRoutes(deps)
  registerTicketAttachmentRoutes(deps)
  registerTicketBulkRoutes(deps)
}
