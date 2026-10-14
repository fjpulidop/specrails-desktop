import { expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '../../../test-utils'
import { LoopTurnLimits } from './LoopTurnLimits'
import type { LoopGraph, LoopAgentConfig } from '../lib/loops-api'

const agents = (): LoopAgentConfig => ({
  schemaVersion: 1,
  agents: { architect: { provider: 'inherit' }, developer: { provider: 'inherit' }, reviewer: { provider: 'inherit' } },
  fixer: { provider: 'inherit' },
  roles: {
    plan: { provider: 'inherit', access: 'read', artifacts: 'all' },
    build: { provider: 'inherit', maxTurns: 300, access: 'write', artifacts: 'tasks-checkboxes', prompt: 'Build it' },
  },
} as LoopAgentConfig)
const step = (id: string, label: string, roleId: string) => ({ id, type: 'core', position: { x: 0, y: 0 }, data: { kind: 'role-turn', label, params: { roleId } } })
const graph = { nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }, step('architect', 'Architect', 'plan'), step('developer', 'Developer', 'build'), { id: 'verify', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'verify', params: {} } }], edges: [], config: {} } as unknown as LoopGraph

it('lists each AI step with its role and edits the shared role ceiling', () => {
  const changes = vi.fn()
  function Draft() { const [value, setValue] = useState(agents()); return <LoopTurnLimits graph={graph} value={value} onChange={next => { changes(next); setValue(next) }} /> }
  render(<Draft />)
  expect(screen.getByText('Turn limits')).toBeInTheDocument()
  expect(screen.queryByText('Verify')).toBeNull()
  const developer = screen.getByLabelText('Maximum turns for Developer (role build)')
  expect(developer).toHaveValue(300)
  const architect = screen.getByLabelText('Maximum turns for Architect (role plan)')
  expect(architect).toHaveValue(null)
  expect(architect).toHaveAttribute('placeholder', '100')
  fireEvent.change(developer, { target: { value: '1000' } })
  expect(changes.mock.calls.at(-1)?.[0].roles.build).toEqual({ provider: 'inherit', maxTurns: 1000, access: 'write', artifacts: 'tasks-checkboxes', prompt: 'Build it' })
  fireEvent.change(developer, { target: { value: '' } })
  expect(changes.mock.calls.at(-1)?.[0].roles.build.maxTurns).toBeUndefined()
})

it('renders nothing for a loop without agent steps', () => {
  const { container } = render(<LoopTurnLimits graph={{ ...graph, nodes: [graph.nodes[0]] }} value={agents()} onChange={vi.fn()} />)
  expect(container).toBeEmptyDOMElement()
})
