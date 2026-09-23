import * as path from 'path'
import { resolveHome } from '../../../../artifact-registry'
import { type TicketNamingInput } from '../../runtime/pr-naming'
import { getLinkByLocalId } from '../../../../jira/jira-db'
import { type RailPrDeliveryRow } from '../../runtime/rail-pr-store'
import { readStore, resolveTicketStoragePath } from '../../../specs/runtime/ticket-store'
import { resolveProjectExecution } from '../../../../workspace-resolution'
import { listChainsTouchingDelivery } from '../../../builder/runtime/milestone-chain-store'
import { PrDecisionDeps } from './contracts'


export function parsePrNumber(prUrl: string): number | null {
  const m = /\/pull\/(\d+)/.exec(prUrl)
  return m ? parseInt(m[1], 10) : null
}


export function batchWorktreeRoot(slug: string): string {
  // Mirrors rail-isolated-launch's worktreesRoot — derivable, never stored.
  return path.join(resolveHome(), '.specrails', 'projects', slug, 'worktrees')
}


/** Naming + body data for a PR's ticket, resolved at create-pr time. */
export interface PrTicketData extends TicketNamingInput {
  description?: string | null
}


/**
 * Load the PR's ticket data (title/labels/description) from the ticket store,
 * with the Jira key resolved PER TICKET: the authoritative `jira_links` row
 * prevails over the ticket's `jira_key` field (JIRA ALWAYS PREVAILS), no HTTP.
 * Tolerant of a missing/corrupt store or link table — degrades to bare local
 * ids, never throws, never blocks PR creation.
 */
export function loadPrTicketData(deps: PrDecisionDeps, ticketIds: number[]): PrTicketData[] {
  let tickets: Record<string, { title?: string; description?: string; labels?: string[]; jira_key?: string | null }> = {}
  try {
    tickets = readStore(resolveTicketFile(deps)).tickets as typeof tickets
  } catch {
    /* tolerated — the PR falls back to bare ticket refs */
  }
  return ticketIds.map((id) => {
    const t = tickets[String(id)]
    let jiraKey: string | null = t?.jira_key ?? null
    try {
      const link = getLinkByLocalId(deps.db, id)
      if (link && !link.tombstoned && link.jiraKey) jiraKey = link.jiraKey
    } catch {
      /* tolerated — fall back to the ticket field */
    }
    return {
      ticketId: id,
      title: t?.title ?? null,
      labels: t?.labels ?? null,
      description: t?.description ?? null,
      jiraKey,
    }
  })
}


export function resolveTicketFile(deps: PrDecisionDeps): string {
  if (deps.ticketFile) return deps.ticketFile
  const exec = resolveProjectExecution({ slug: deps.project.slug, path: deps.project.path })
  return exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(deps.project.path)
}


/** Local-integration target: a chain-launched (stacked) delivery integrates
 *  into the chain's integration branch, never into its feature base. */
export function mergeLocalTargetBranch(deps: PrDecisionDeps, row: RailPrDeliveryRow): string {
  if (deps.repositoryChildOf) return deps.repositoryIntegrationBranch ?? row.base_branch
  try {
    for (const chain of listChainsTouchingDelivery(deps.db, row.id)) {
      if (chain.integration_branch) return chain.integration_branch
    }
  } catch { /* fall through */ }
  return row.base_branch
}
