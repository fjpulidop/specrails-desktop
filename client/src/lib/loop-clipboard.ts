/**
 * Pure clipboard (de)serialization for copy/paste of loop nodes. The DOM event
 * wiring (copy/paste listeners, the system clipboard) stays in the builder; this
 * module shapes the payload and clones nodes for paste — so it's unit-testable
 * without React Flow or a real clipboard.
 *
 * Cross-loop paste works because the payload travels through the system
 * clipboard as plain-text JSON, tagged with `specrailsNodes` so a paste of
 * unrelated clipboard text is ignored.
 */
import type { Node, Edge } from '@xyflow/react'
import type { LoopNodeData } from './loop-graph-rf'

const MARKER = 'specrailsNodes'

export interface NodeClipboard {
  nodes: Node<LoopNodeData>[]
  edges: Edge[]
}

/** Serialize the SELECTED nodes + the edges entirely between them. Null when
 *  nothing is selected (so the caller leaves the native copy alone). */
export function serializeSelection(
  nodes: Node<LoopNodeData>[],
  edges: Edge[]
): (NodeClipboard & { specrailsNodes: number }) | null {
  const selected = nodes.filter((n) => n.selected)
  if (selected.length === 0) return null
  const ids = new Set(selected.map((n) => n.id))
  const between = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return { specrailsNodes: 1, nodes: selected, edges: between }
}

/** Parse clipboard text back to a node payload, or null if it isn't ours. */
export function parseNodeClipboard(text: string): NodeClipboard | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const o = parsed as { [MARKER]?: unknown; nodes?: unknown; edges?: unknown } | null
  if (!o || o[MARKER] == null || !Array.isArray(o.nodes)) return null
  return { nodes: o.nodes as Node<LoopNodeData>[], edges: Array.isArray(o.edges) ? (o.edges as Edge[]) : [] }
}

/**
 * Clone a clipboard payload for pasting into a (possibly different) loop: mint
 * fresh node + edge ids, offset positions, select the pasted nodes, and drop any
 * node whose kind is in `excludeKinds` (used to skip a second Start) along with
 * the edges touching it. Edges whose endpoints aren't both present are dropped.
 */
export function cloneForPaste(
  payload: NodeClipboard,
  opts: { mintId: () => string; offset?: { x: number; y: number }; excludeKinds?: string[] }
): NodeClipboard {
  const offset = opts.offset ?? { x: 40, y: 40 }
  const exclude = new Set(opts.excludeKinds ?? [])
  const idMap = new Map<string, string>()
  const nodes = payload.nodes
    .filter((n) => !exclude.has(String((n.data as LoopNodeData)?.kind)))
    .map((n) => {
      const id = opts.mintId()
      idMap.set(n.id, id)
      return { ...n, id, position: { x: n.position.x + offset.x, y: n.position.y + offset.y }, selected: true }
    })
  const edges = payload.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({ ...e, id: opts.mintId(), source: idMap.get(e.source)!, target: idMap.get(e.target)!, selected: false }))
  return { nodes, edges }
}
