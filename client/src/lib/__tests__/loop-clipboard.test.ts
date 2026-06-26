import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import { serializeSelection, parseNodeClipboard, cloneForPaste } from '../loop-clipboard'
import type { LoopNodeData } from '../loop-graph-rf'

function node(id: string, kind: LoopNodeData['kind'], selected = false): Node<LoopNodeData> {
  return { id, type: 'loop', position: { x: 10, y: 20 }, data: { kind }, selected }
}

describe('loop-clipboard', () => {
  it('serializeSelection keeps only selected nodes + edges between them', () => {
    const nodes = [node('a', 'ai-step', true), node('b', 'shell', true), node('c', 'end', false)]
    const edges: Edge[] = [
      { id: 'e1', source: 'a', target: 'b' }, // both selected → kept
      { id: 'e2', source: 'b', target: 'c' }, // c not selected → dropped
    ]
    const payload = serializeSelection(nodes, edges)!
    expect(payload.specrailsNodes).toBe(1)
    expect(payload.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(payload.edges.map((e) => e.id)).toEqual(['e1'])
  })

  it('serializeSelection returns null when nothing is selected', () => {
    expect(serializeSelection([node('a', 'ai-step', false)], [])).toBeNull()
  })

  it('parseNodeClipboard accepts our payload, rejects foreign/garbage text', () => {
    const good = JSON.stringify({ specrailsNodes: 1, nodes: [node('a', 'ai-step')], edges: [] })
    expect(parseNodeClipboard(good)?.nodes).toHaveLength(1)
    expect(parseNodeClipboard('hello world')).toBeNull()
    expect(parseNodeClipboard(JSON.stringify({ nodes: [] }))).toBeNull() // no marker
    expect(parseNodeClipboard('')).toBeNull()
  })

  it('cloneForPaste mints new ids, offsets, remaps edges, selects pasted nodes', () => {
    const payload = {
      nodes: [node('a', 'ai-step'), node('b', 'shell')],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'continue' } as Edge],
    }
    let n = 0
    const out = cloneForPaste(payload, { mintId: () => `new-${++n}`, offset: { x: 40, y: 40 } })
    expect(out.nodes.map((x) => x.id)).toEqual(['new-1', 'new-2'])
    expect(out.nodes[0].position).toEqual({ x: 50, y: 60 })
    expect(out.nodes.every((x) => x.selected)).toBe(true)
    // edge remapped to the NEW node ids, keeps sourceHandle, gets a fresh id
    expect(out.edges[0]).toMatchObject({ source: 'new-1', target: 'new-2', sourceHandle: 'continue' })
    expect(out.edges[0].id).toBe('new-3')
  })

  it('cloneForPaste drops excluded kinds (e.g. a second Start) and their edges', () => {
    const payload = {
      nodes: [node('s', 'start'), node('a', 'ai-step')],
      edges: [{ id: 'e1', source: 's', target: 'a' } as Edge],
    }
    let n = 0
    const out = cloneForPaste(payload, { mintId: () => `n${++n}`, excludeKinds: ['start'] })
    expect(out.nodes.map((x) => x.data.kind)).toEqual(['ai-step'])
    expect(out.edges).toHaveLength(0) // edge touched the dropped start
  })
})
