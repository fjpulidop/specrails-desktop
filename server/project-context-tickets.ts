/**
 * Ticket-store access bound to one project.
 *
 * Owns resolving the project's ticket file (workspace store when relocated,
 * repo-relative store otherwise) and the read helpers the loop engine and
 * Intent hand-off use. Every call re-reads `project`, which the registry
 * updates in place when the repository catalog changes.
 */
import type { ProjectRow } from './desktop-db'
import { descriptionWithIntent } from './modules/specs/domain/intent'
import { descriptionWithNonGoals } from './modules/specs/domain/non-goals'
import { readStore } from './modules/specs/runtime/ticket-store'
import type { LoopSpec } from './modules/loops/runtime/loop-graph'
import { resolveProjectTicketsPath } from './workspace-resolution'

export interface ProjectTicketAccess {
  /** The ticket file the project's specs live in right now. */
  ticketStorePath: () => string
  /** The stored ticket as written (no launch-door additions): the Intent → Spec summary reads it. */
  readFlowTicket: (ticketId: number) => ReturnType<typeof readStore>['tickets'][string] | undefined
  /** Read a spec's fields for {{spec.*}} interpolation at launch. */
  getTicketSpec: (ticketId: number) => LoopSpec | undefined
}

export function createProjectTicketAccess(project: Pick<ProjectRow, 'slug' | 'path'>): ProjectTicketAccess {
  const ticketStorePath = (): string => {
    return resolveProjectTicketsPath({ slug: project.slug, path: project.path })
  }

  const readFlowTicket = (ticketId: number) => {
    try {
      return readStore(ticketStorePath()).tickets[String(ticketId)]
    } catch {
      return undefined
    }
  }

  const getTicketSpec = (ticketId: number): LoopSpec | undefined => {
    try {
      const t = readStore(ticketStorePath()).tickets[String(ticketId)]
      if (!t) return undefined
      // Expose every field a loop prompt can reference via `{{spec.*}}`.
      return {
        id: t.id,
        title: t.title,
        // The intent (intent-mode) leads and the non-goals (3.2) close the
        // description every loop prompt and Core run sees.
        description: descriptionWithIntent(descriptionWithNonGoals(t.description, t.nonGoals), t.intent),
        status: t.status,
        priority: t.priority,
        labels: t.labels,
        repositoryIds: t.repositoryIds,
        jira_key: t.jira_key ?? null,
        jira_url: t.jira_url ?? null,
        openspecChangeName: typeof t.metadata?.openspecChangeName === 'string' ? t.metadata.openspecChangeName : undefined,
        metadata: t.metadata,
      }
    } catch {
      return undefined
    }
  }

  return { ticketStorePath, readFlowTicket, getTicketSpec }
}
