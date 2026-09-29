import { expect, it } from 'vitest'
import { parseRuntimeTopology } from '../runtime-topology'
const topology = { entry: 'map', nodes: [{ id: 'map', kind: 'map', label: 'Review', component: 'review', ends: { next: 'end', failed: null } }, { id: 'end', kind: 'end', label: 'Done', ends: {} }], components: { review: { entry: 'read', nodes: [{ id: 'read', kind: 'prompt', label: 'Read', ends: { next: null } }] } } }
it('retains authored outcomes and component references without executable inputs', () => {
  expect(parseRuntimeTopology({ ...topology, prompt: 'not public topology' })).toEqual(topology)
})
it.each([null, {}, { ...topology, entry: 'missing' }, { ...topology, nodes: [...topology.nodes, topology.nodes[0]] }, { ...topology, nodes: [{ ...topology.nodes[0], ends: { next: 'outside' } }] }, { ...topology, components: [] }])('rejects malformed topology without inferring connections', value => {
  expect(parseRuntimeTopology(value)).toBeNull()
})
