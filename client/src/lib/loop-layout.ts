/**
 * Pure auto-layout for the loop builder canvas. Kept out of the React component
 * so it is unit-testable without rendering React Flow.
 *
 * The loop graphs are small (≤ ~10 nodes) and essentially layered (a spine with
 * one loop-back), so a dependency-free BFS layering is plenty — no dagre/elk.
 *
 * Modes:
 *  - 'vertical'   → layered top→bottom (the canonical default).
 *  - 'horizontal' → layered left→right.
 *  - 'grid'       → snap each node's CURRENT position to an orthogonal grid
 *                   (tidies a hand-dragged mess without re-ranking).
 */
import type { Node } from '@xyflow/react'
import type { LoopNodeData } from './loop-graph-rf'

export type LayoutMode = 'vertical' | 'horizontal' | 'grid'

const ROW_GAP = 130 // distance between ranks (down for vertical / right for horizontal)
const CROSS_GAP = 240 // distance between siblings sharing a rank
const GRID = 20

interface MiniEdge { source: string; target: string }

/** BFS depth from the Start node (min distance). Back-edges to already-ranked
 *  nodes are ignored, so a loop doesn't blow the ranking up. Disconnected nodes
 *  are parked after the deepest rank. */
function rankFromStart(nodes: Node<LoopNodeData>[], edges: MiniEdge[]): Map<string, number> {
  const start = nodes.find((n) => n.data.kind === 'start') ?? nodes[0]
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    const list = adj.get(e.source)
    if (list) list.push(e.target)
    else adj.set(e.source, [e.target])
  }
  const rank = new Map<string, number>()
  if (!start) return rank
  const queue: Array<[string, number]> = [[start.id, 0]]
  while (queue.length) {
    const [id, r] = queue.shift()!
    if (rank.has(id)) continue
    rank.set(id, r)
    for (const t of adj.get(id) ?? []) if (!rank.has(t)) queue.push([t, r + 1])
  }
  let max = 0
  for (const v of rank.values()) max = Math.max(max, v)
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, ++max)
  return rank
}

/** Recompute node positions for the given mode. Returns NEW node objects (the
 *  React Flow nodes array is replaced; edges are untouched). */
export function layoutLoop(
  nodes: Node<LoopNodeData>[],
  edges: MiniEdge[],
  mode: LayoutMode
): Node<LoopNodeData>[] {
  if (mode === 'grid') {
    return nodes.map((n) => ({
      ...n,
      position: { x: Math.round(n.position.x / GRID) * GRID, y: Math.round(n.position.y / GRID) * GRID },
    }))
  }

  const rank = rankFromStart(nodes, edges)
  const byRank = new Map<number, Node<LoopNodeData>[]>()
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0
    const group = byRank.get(r)
    if (group) group.push(n)
    else byRank.set(r, [n])
  }

  const out: Node<LoopNodeData>[] = []
  for (const [r, group] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    group.forEach((n, i) => {
      // Centre each rank's siblings around 0 on the cross axis.
      const cross = (i - (group.length - 1) / 2) * CROSS_GAP
      const position = mode === 'vertical' ? { x: cross, y: r * ROW_GAP } : { x: r * ROW_GAP, y: cross }
      out.push({ ...n, position })
    })
  }
  // Preserve the caller's node order (React Flow keys by id, but keeping order
  // avoids needless reconciliation churn).
  const indexById = new Map(nodes.map((n, i) => [n.id, i]))
  return out.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0))
}
