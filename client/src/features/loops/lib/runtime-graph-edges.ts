// Edge labels of the runtime graph (pure). Core names each way out of a step
// by an outcome id (`next`, `failed`, `true`, ...); known ids read in the
// person's language, and labels that would share a spot are staggered.
import type { Edge, Node } from '@xyflow/react'

/** Outcome ids of Core's definitions that have a translated name (`jobs:loopExplorer.graphOutcome.<id>`). */
export const KNOWN_OUTCOMES = Object.freeze([
  'next', 'true', 'false', 'pass', 'fail', 'failed', 'invalid', 'blocked', 'continue', 'stop',
  'approved', 'rejected', 'timeout', 'error', 'done', 'skipped', 'retry', 'answered', 'declined',
] as const)
const KNOWN = new Set<string>(KNOWN_OUTCOMES)

/** The translation key of a known outcome id, or null (the id is then shown in words). */
export function outcomeLabelKey(outcome: string): `loopExplorer.graphOutcome.${string}` | null {
  return KNOWN.has(outcome) ? `loopExplorer.graphOutcome.${outcome}` : null
}

/** Horizontal room one label needs before a neighbour in the same gap moves to the next lane (px). */
const LABEL_ROOM = 96
const MAX_LANE = 2

/**
 * Give each labelled edge a `lane`: labels sit in the gap under their source's
 * rank, at the middle of the edge's horizontal run; two labels in the same gap
 * closer than LABEL_ROOM go to different lanes (stacked a line apart).
 */
export function edgeLabelLanes<E extends Edge>(edges: E[], nodes: ReadonlyArray<Pick<Node, 'id' | 'position'>>, nodeWidth: number): E[] {
  const at = new Map(nodes.map((node) => [node.id, node.position]))
  const anchors = edges.flatMap((edge, index) => {
    const source = at.get(edge.source)
    const target = at.get(edge.target)
    if (!edge.label || !source || !target) return []
    const sx = source.x + nodeWidth / 2
    const tx = target.x + nodeWidth / 2
    return [{ index, row: source.y, x: target.y > source.y ? (sx + tx) / 2 : sx }]
  })
  const lanes = new Map<number, number>()
  const rows = new Map<number, typeof anchors>()
  for (const anchor of anchors) rows.set(anchor.row, [...(rows.get(anchor.row) ?? []), anchor])
  for (const row of rows.values()) {
    const lastX: number[] = []
    for (const anchor of row.sort((a, b) => a.x - b.x)) {
      let lane = lastX.findIndex((x) => anchor.x - x >= LABEL_ROOM)
      if (lane === -1) lane = lastX.length <= MAX_LANE ? lastX.length : MAX_LANE
      lastX[lane] = anchor.x
      lanes.set(anchor.index, lane)
    }
  }
  return edges.map((edge, index) => lanes.has(index) ? { ...edge, data: { ...(edge.data ?? {}), lane: lanes.get(index) } } : edge)
}
