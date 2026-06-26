/**
 * Pure conversions between the persisted LoopGraph (server shape) and the
 * React Flow node/edge model used by the canvas builder. Kept separate from the
 * canvas component so it is unit-testable without rendering React Flow (which
 * needs DOM APIs absent under jsdom).
 *
 * All loop nodes map to a SINGLE React Flow custom node type ('loop'); the loop
 * node kind (start/ai-step/…) lives in `data.kind`, so one node component
 * renders every kind.
 */
import { MarkerType, type Node, type Edge } from '@xyflow/react'
import type { LoopGraph, LoopNode, LoopNodeType, LoopJoin, LoopBranch } from './loops-api'

function asBranch(v: unknown): LoopBranch | undefined {
  return v === 'continue' || v === 'stop' ? v : undefined
}

export interface LoopNodeData extends Record<string, unknown> {
  kind: LoopNodeType
}

/** Default config for a brand-new node of each kind. */
export function defaultNodeData(kind: LoopNodeType): LoopNodeData {
  switch (kind) {
    case 'ai-step':
      return { kind, prompt: '', provider: 'claude', model: '', effort: 'medium', maxTurns: 0 }
    case 'shell':
      return { kind, command: '' }
    case 'decider':
      return { kind, goal: '' }
    case 'condition':
      return { kind, join: 'AND' as LoopJoin }
    case 'end':
      return { kind, outcome: 'success' }
    case 'start':
    default:
      return { kind }
  }
}

export function newNodeId(): string {
  // Browser/jsdom both expose crypto.randomUUID.
  return (globalThis.crypto?.randomUUID?.() ?? `n-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
}

export function makeNode(kind: LoopNodeType, position: { x: number; y: number }): Node<LoopNodeData> {
  return { id: newNodeId(), type: 'loop', position, data: defaultNodeData(kind) }
}

export function graphToReactFlow(graph: LoopGraph): { nodes: Node<LoopNodeData>[]; edges: Edge[] } {
  const nodes: Node<LoopNodeData>[] = (graph.nodes ?? []).map((n) => ({
    id: n.id,
    type: 'loop',
    position: n.position ?? { x: 0, y: 0 },
    data: { kind: n.type, ...(n.data ?? {}) } as LoopNodeData,
  }))
  const typeById = new Map((graph.nodes ?? []).map((n) => [n.id, n.type]))
  const edges: Edge[] = (graph.edges ?? []).map((e) => {
    // A Decider has ONLY named source handles ('continue' / 'stop') — an edge
    // leaving it MUST set `sourceHandle` to one of them or React Flow can't find
    // the handle and the edge floats off the node's origin (visually detached).
    // New graphs carry `branch`; for legacy graphs authored before labeled
    // branches, infer it (edge to an End → 'stop', otherwise → 'continue') so the
    // edge always attaches. The handle is labeled on the node, so the edge needs
    // no text label — just colour-code the two branches.
    const branch: LoopBranch | undefined =
      e.branch ?? (typeById.get(e.source) === 'decider'
        ? (typeById.get(e.target) === 'end' ? 'stop' : 'continue')
        : undefined)
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: branch ?? undefined,
      // Orthogonal (right-angle) routing + an arrowhead so the flow direction is
      // unambiguous — far cleaner than the curvy default bezier on loop-backs.
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      label: e.join,
      data: { ...(e.join ? { join: e.join } : {}), ...(branch ? { branch } : {}) },
      ...(branch
        ? { style: { stroke: branch === 'stop' ? 'var(--color-accent-success)' : 'var(--color-accent-highlight)' } }
        : {}),
    }
  })
  return { nodes, edges }
}

export function reactFlowToGraph(
  nodes: Node<LoopNodeData>[],
  edges: Edge[],
  config: LoopGraph['config']
): LoopGraph {
  return {
    nodes: nodes.map((n) => {
      const { kind, ...rest } = n.data
      const loopNode: LoopNode = { id: n.id, type: kind, position: n.position }
      if (Object.keys(rest).length > 0) loopNode.data = rest
      return loopNode
    }),
    edges: edges.map((e) => {
      const join = (e.data as { join?: LoopJoin } | undefined)?.join
      // A connection drawn from a Decider handle carries the branch as
      // `sourceHandle`; a round-tripped edge carries it in `data.branch`.
      const branch = asBranch(e.sourceHandle) ?? asBranch((e.data as { branch?: unknown } | undefined)?.branch)
      return { id: e.id, source: e.source, target: e.target, ...(join ? { join } : {}), ...(branch ? { branch } : {}) }
    }),
    config,
  }
}
