/**
 * Live, client-side loop validation for the builder — mirrors the server publish
 * gate (`validateLoopGraph`) and adds builder-only authoring warnings, so the
 * canvas can flag problems as the user edits instead of only at publish time.
 *
 * Pure (no React, no i18n): returns issue CODES; the panel maps code → message.
 */
import type { Node, Edge } from '@xyflow/react'
import type { LoopNodeData } from './loop-graph-rf'

export type IssueSeverity = 'error' | 'warning'
export type IssueCode =
  | 'NO_START'
  | 'MULTIPLE_START'
  | 'NO_END'
  | 'ORPHAN'
  | 'DECIDER_BRANCHES'
  | 'EMPTY_PROMPT'
  | 'EMPTY_COMMAND'
  | 'EMPTY_GOAL'
  | 'DEAD_END'

export interface LoopIssue {
  severity: IssueSeverity
  code: IssueCode
  /** The offending node, when the issue is node-specific. */
  nodeId?: string
}

function isEmpty(v: unknown): boolean {
  return typeof v !== 'string' || v.trim().length === 0
}

/** Nodes reachable from the (first) Start via directed edges. */
function reachable(nodes: Node<LoopNodeData>[], edges: Edge[]): Set<string> {
  const start = nodes.find((n) => n.data.kind === 'start')
  const seen = new Set<string>()
  if (!start) return seen
  const adj = new Map<string, string[]>()
  for (const e of edges) (adj.get(e.source) ?? adj.set(e.source, []).get(e.source))!.push(e.target)
  const queue = [start.id]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const t of adj.get(id) ?? []) if (!seen.has(t)) queue.push(t)
  }
  return seen
}

export function validateBuilderGraph(nodes: Node<LoopNodeData>[], edges: Edge[]): LoopIssue[] {
  const issues: LoopIssue[] = []
  const starts = nodes.filter((n) => n.data.kind === 'start')

  if (starts.length === 0) issues.push({ severity: 'error', code: 'NO_START' })
  for (const extra of starts.slice(1)) issues.push({ severity: 'error', code: 'MULTIPLE_START', nodeId: extra.id })
  if (!nodes.some((n) => n.data.kind === 'end')) issues.push({ severity: 'error', code: 'NO_END' })

  // Reachability (only meaningful with exactly one Start).
  if (starts.length === 1) {
    const seen = reachable(nodes, edges)
    for (const n of nodes) if (!seen.has(n.id)) issues.push({ severity: 'error', code: 'ORPHAN', nodeId: n.id })
  }

  const outBySource = new Map<string, Edge[]>()
  for (const e of edges) (outBySource.get(e.source) ?? outBySource.set(e.source, []).get(e.source))!.push(e)

  for (const n of nodes) {
    const out = outBySource.get(n.id) ?? []
    switch (n.data.kind) {
      case 'decider': {
        const branches = new Set(out.map((e) => e.sourceHandle ?? (e.data as { branch?: string } | undefined)?.branch))
        if (!branches.has('continue') || !branches.has('stop')) {
          issues.push({ severity: 'error', code: 'DECIDER_BRANCHES', nodeId: n.id })
        }
        if (isEmpty(n.data.goal)) issues.push({ severity: 'warning', code: 'EMPTY_GOAL', nodeId: n.id })
        break
      }
      case 'ai-step':
        if (isEmpty(n.data.prompt)) issues.push({ severity: 'warning', code: 'EMPTY_PROMPT', nodeId: n.id })
        if (out.length === 0) issues.push({ severity: 'warning', code: 'DEAD_END', nodeId: n.id })
        break
      case 'shell':
        if (isEmpty(n.data.command)) issues.push({ severity: 'warning', code: 'EMPTY_COMMAND', nodeId: n.id })
        if (out.length === 0) issues.push({ severity: 'warning', code: 'DEAD_END', nodeId: n.id })
        break
      case 'start':
        if (out.length === 0) issues.push({ severity: 'warning', code: 'DEAD_END', nodeId: n.id })
        break
      default:
        break
    }
  }
  return issues
}

/** Worst severity per node id, for the canvas ring colour. */
export function severityByNode(issues: LoopIssue[]): Map<string, IssueSeverity> {
  const map = new Map<string, IssueSeverity>()
  for (const i of issues) {
    if (!i.nodeId) continue
    if (i.severity === 'error' || !map.has(i.nodeId)) map.set(i.nodeId, i.severity)
  }
  return map
}
