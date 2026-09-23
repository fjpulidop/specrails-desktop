/**
 * Dry-run preview: resolve every step's tokens (`{{cmd:*}}`, `{{spec.*}}`,
 * `{{const:*}}`) and return the EXACT prompt/command text that WOULD be sent —
 * without spawning anything. Lets the user debug a loop before burning tokens.
 *
 * Spec tokens are filled from a fixed SAMPLE spec (the real ticket is only known
 * at launch), so the preview is labelled "sample data" on the client. Commands +
 * constants resolve to their real run-time values.
 */
import { expandCommands } from './loop-command-catalog'
import { interpolateSpec, findStartNode, successors, type LoopGraph, type LoopNode, type LoopSpec } from './loop-graph'
import { resolveConstants } from './loop-constants'

export interface PreviewStep {
  nodeId: string
  kind: string
  label?: string
  /** The fully-resolved prompt (AI Step), command (Shell) or goal (Decider). */
  text: string
}

/** Stand-in ticket so `{{spec.*}}` resolves to something readable in the preview. */
export const SAMPLE_SPEC: LoopSpec = {
  id: 1,
  ticketIds: [1],
  title: 'Example spec',
  description: 'Example description',
  status: 'todo',
  priority: 'medium',
  labels: ['example'],
  jira_key: 'PROJ-1',
  jira_url: 'https://example.atlassian.net/browse/PROJ-1',
}

/** Reachable-first visit order (then any unreachable nodes), mirroring the run. */
function visitOrder(graph: LoopGraph): LoopNode[] {
  const start = findStartNode(graph)
  const ordered: LoopNode[] = []
  const seen = new Set<string>()
  const queue = start ? [start] : []
  while (queue.length) {
    const node = queue.shift()!
    if (seen.has(node.id)) continue
    seen.add(node.id)
    ordered.push(node)
    for (const next of successors(graph, node.id)) if (!seen.has(next.id)) queue.push(next)
  }
  for (const n of graph.nodes ?? []) if (!seen.has(n.id)) ordered.push(n)
  return ordered
}

export function previewLoop(
  graph: LoopGraph,
  opts: { provider: string; spec?: LoopSpec; constants: Record<string, string> }
): { steps: PreviewStep[] } {
  const spec = opts.spec ?? SAMPLE_SPEC
  const steps: PreviewStep[] = []
  for (const node of visitOrder(graph)) {
    const label = typeof node.data?.label === 'string' && node.data.label.trim() ? node.data.label.trim() : undefined
    let text: string | null = null
    if (node.type === 'ai-step') {
      text = resolveConstants(
        interpolateSpec(
          expandCommands(String(node.data?.prompt ?? ''), { provider: opts.provider, ticketIds: spec.ticketIds, specId: spec.id }),
          spec
        ),
        opts.constants
      )
    } else if (node.type === 'shell') {
      text = resolveConstants(interpolateSpec(String(node.data?.command ?? ''), spec), opts.constants)
    } else if (node.type === 'decider') {
      text = resolveConstants(interpolateSpec(String(node.data?.goal ?? ''), spec), opts.constants)
    }
    if (text !== null) steps.push({ nodeId: node.id, kind: node.type, label, text })
  }
  return { steps }
}
