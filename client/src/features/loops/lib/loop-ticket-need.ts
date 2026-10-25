import type { LoopDefinition, LoopGraph } from './loops-api'

/**
 * Whether a loop "needs a ticket" — it references a `{{spec.*}}` token or one of
 * the ticket-consuming commands (`{{cmd:implement|freestyle}}`, plus the legacy `{{cmd:batch}}`
 * alias of implement). Ticket-
 * needing loops run from a rail (the rail provides the spec); ticket-LESS loops
 * (CI watch, repo-wide lint — no spec/ticket reference) run standalone from the
 * Loops page "Run" action.
 */
const SPEC_TOKEN = /\{\{\s*spec\./
const TICKET_CMD = /\{\{\s*cmd:(implement|batch|freestyle)\b/

export function loopNeedsTicket(graph: LoopGraph | undefined): boolean {
  if (!graph) return false
  for (const node of graph.nodes) {
    if (node.type === 'core' && ['implementation', 'implementation-step'].includes(String(node.data?.kind))) return true
    const text = [node.data?.prompt, node.data?.command, node.data?.goal, node.type === 'core' ? JSON.stringify(node.data?.params ?? {}) : '']
      .filter((v) => typeof v === 'string')
      .join('\n')
    if (SPEC_TOKEN.test(text) || TICKET_CMD.test(text)) return true
  }
  return Object.values(graph.components ?? {}).some(component => loopNeedsTicket(component))
}

/**
 * The user's own loops a rail can run: published, spec-consuming, and not one of the
 * seeded rows that mirror a built-in (`builtinId`), which pickers already list as
 * built-ins — including them shows e.g. "Freestyle" twice.
 */
export function railRunnableCustomLoops(loops: LoopDefinition[]): LoopDefinition[] {
  return loops.filter((l) => !l.builtinId && l.status === 'published' && loopNeedsTicket(l.graph))
}
