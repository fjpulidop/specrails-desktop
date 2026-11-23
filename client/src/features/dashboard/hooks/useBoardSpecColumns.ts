/**
 * Derived ticket columns of the board: the spec column (user drag order or a
 * sorted mode), the Done column, labels for filters, the ticket lookup map and
 * the on-review specs whose open PR head a relaunch can continue.
 */
import { useEffect, useMemo } from 'react'
import type { RailState } from '../../rails/components/RailsBoard'
import type { LocalTicket, RailPrStateSnapshot } from '../../../types'
import type { SpecSortMode, SpecSortDir } from '../../specs/types/spec-sort'
import { applySpecSort } from '../../specs/lib/spec-sort'
import { ticketHasContinuablePr } from '../lib/board-rails'

export function useBoardSpecColumns(opts: {
  tickets: LocalTicket[]
  isLoading: boolean
  rails: RailState[]
  specOrderIds: number[] | null
  sortMode: SpecSortMode
  sortDir: SpecSortDir
  handleSortChange: (mode: SpecSortMode, dir: SpecSortDir) => void
  railPrDecisions: ReadonlyMap<number, RailPrStateSnapshot>
  railPrDecisionsHydrated: boolean
}) {
  const { tickets, isLoading, rails, specOrderIds, sortMode, sortDir, handleSortChange, railPrDecisions, railPrDecisionsHydrated } = opts

  const ticketMap = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets])

  const allTicketLabels = useMemo(() => {
    const set = new Set<string>()
    for (const t of tickets) for (const l of t.labels) set.add(l)
    return Array.from(set).sort()
  }, [tickets])

  const railTicketIds = useMemo(() => {
    const ids = new Set<number>()
    for (const r of rails) for (const id of r.ticketIds) ids.add(id)
    return ids
  }, [rails])

  // All spec-source tickets not in rails. `explore-draft` is the source of
  // tickets persisted via "Save as Draft" in ExploreSpecShell; they live on
  // the spec board until the user commits or discards them. `free-prompt` is
  // the source of Raw-mode specs (verbatim prompt, no AI at intake).
  const allSpecTickets = useMemo(() => {
    return tickets.filter(
      (t) =>
        (t.source === 'propose-spec' ||
          t.source === 'product-backlog' ||
          t.source === 'get-backlog-specs' ||
          t.source === 'explore-draft' ||
          t.source === 'specs-smash' ||
          t.source === 'free-prompt' ||
          // Specs created by an external LLM through the MCP server.
          t.source === 'mcp' ||
          // A spec created through the HTTP API without a named source (the
          // legacy 'hub' wire value, shared with specrails-core's tickets.json):
          // the rails and the live board show it, so the board must too.
          t.source === 'hub' ||
          // Day-0 specs committed by the Project Builder. The created_by
          // fallback keeps projects created before `project-builder` became a
          // first-class source visible without rewriting their ticket store.
          t.source === 'project-builder' ||
          (t.source === 'manual' && t.created_by === 'project-builder') ||
          // Jira-backed specs are materialized into local-tickets.json with
          // source:'jira' — they must show on the board like any other spec.
          t.source === 'jira' ||
          // Intent mode placeholder specs (labelled "In Intent" while open).
          t.source === 'flow') &&
        !railTicketIds.has(t.id),
    )
  }, [tickets, railTicketIds])

  // If a persisted "jira-key" sort survives into a project that has no
  // Jira-linked specs (disconnected, or never synced), the option is hidden in
  // the toolbar — fall back to default so the trigger never shows an unreachable
  // mode. Gated on !isLoading so a legit jira-key sort isn't reset before the
  // ticket list (and its jira_key fields) has loaded.
  useEffect(() => {
    if (isLoading) return
    if (sortMode === 'jira-key' && !allSpecTickets.some((t) => t.jira_key)) {
      handleSortChange('default', sortDir)
    }
  }, [isLoading, sortMode, sortDir, allSpecTickets, handleSortChange])

  // Active specs (not done). Default mode → user drag-order; sorted modes
  // → comparator applied to the unordered filtered list.
  const specTickets = useMemo(() => {
    const filtered = allSpecTickets.filter((t) => t.status !== 'done')
    if (sortMode !== 'default') return applySpecSort(filtered, sortMode, sortDir)
    if (!specOrderIds) return filtered
    const map = new Map(filtered.map((t) => [t.id, t]))
    const result: LocalTicket[] = []
    for (const id of specOrderIds) {
      const t = map.get(id)
      if (t) result.push(t)
    }
    for (const t of filtered) {
      if (!specOrderIds.includes(t.id)) result.push(t)
    }
    return result
  }, [allSpecTickets, specOrderIds, sortMode, sortDir])

  // Done specs own their sort/view controls inside the Done pane.
  const doneSpecTickets = useMemo(() => {
    return allSpecTickets.filter((t) => t.status === 'done')
  }, [allSpecTickets])

  const continuableReviewTicketIds = useMemo(() => {
    const ids = new Set<number>()
    if (!railPrDecisionsHydrated) return ids
    for (const ticket of tickets) {
      if (ticket.status === 'on_review' && ticketHasContinuablePr(ticket.id, railPrDecisions, tickets)) {
        ids.add(ticket.id)
      }
    }
    return ids
  }, [tickets, railPrDecisions, railPrDecisionsHydrated])

  return { ticketMap, allTicketLabels, specTickets, doneSpecTickets, continuableReviewTicketIds }
}
