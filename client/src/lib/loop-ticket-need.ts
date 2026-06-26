import type { LoopGraph } from './loops-api'

/**
 * Whether a loop "needs a ticket" — it references a `{{spec.*}}` token or one of
 * the ticket-consuming commands (`{{cmd:implement|batch|ultracode}}`). Ticket-
 * needing loops run from a rail (the rail provides the spec); ticket-LESS loops
 * (CI watch, repo-wide lint — no spec/ticket reference) run standalone from the
 * Loops page "Run" action.
 */
const SPEC_TOKEN = /\{\{\s*spec\./
const TICKET_CMD = /\{\{\s*cmd:(implement|batch|ultracode)\b/

export function loopNeedsTicket(graph: LoopGraph | undefined): boolean {
  if (!graph) return false
  for (const node of graph.nodes) {
    const text = [node.data?.prompt, node.data?.command, node.data?.goal]
      .filter((v) => typeof v === 'string')
      .join('\n')
    if (SPEC_TOKEN.test(text) || TICKET_CMD.test(text)) return true
  }
  return false
}
