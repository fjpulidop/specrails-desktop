import { beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '../../../test-utils'
import { LoopAgentsEditor } from './LoopAgentsEditor'
import type { LoopGraph, LoopAgentConfig } from '../lib/loops-api'
const desktop = vi.hoisted(() => ({ activeProjectId: 'first' as string | null }))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => desktop }))
const recipe = (): LoopAgentConfig => ({ schemaVersion: 1, agents: { architect: { provider: 'claude' }, developer: { provider: 'codex' }, reviewer: { provider: 'claude' } }, fixer: { provider: 'codex' }, roles: { 'loop-decider': { provider: 'claude', access: 'read', artifacts: 'none', prompt: 'Decide from evidence' } }, rolePrompts: { architect: 'Plan the task', developer: 'Develop the task', reviewer: 'Review the task', fixer: 'Fix the task' } })
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response
beforeEach(() => {
  desktop.activeProjectId = 'first'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/runtime-providers' ? { providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }, { id: 'codex', kind: 'cli', cli: 'codex' }] } : { agents: recipe(), rolePromptDefaults: { architect: 'Core architect text', developer: 'Core developer text', reviewer: 'Core reviewer text', fixer: 'Core fixer text' }, guardrails: { supported: true, catalog: [] } })))
})
it('edits the loop definition and engine as a draft without persisting project settings', async () => {
  const changes = vi.fn()
  function Draft() { const [value, setValue] = useState(recipe()); return <LoopAgentsEditor value={value} selectedRole="developer" onChange={next => { changes(next); setValue(next) }} /> }
  render(<Draft />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import current project agents' })).toBeEnabled())
  fireEvent.change(screen.getByDisplayValue('Develop the task'), { target: { value: 'Our shared developer definition' } })
  const section = screen.getByText('developer', { selector: 'summary' }).parentElement!
  fireEvent.change(within(section).getByLabelText('Model'), { target: { value: 'loop-model' } })
  expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ rolePrompts: { developer: 'Our shared developer definition' }, agents: { developer: { model: 'loop-model' } } })
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})
it('does not import a response from a project that was switched while loading', async () => {
  let resolve!: (value: Response) => void
  const original = global.fetch
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => String(url).endsWith('/agent-runtime/config') ? new Promise<Response>(done => { resolve = done }) : original(url, init)))
  const change = vi.fn(), view = render(<LoopAgentsEditor value={recipe()} onChange={change} />)
  const button = await screen.findByRole('button', { name: 'Import current project agents' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  desktop.activeProjectId = 'second'
  view.rerender(<LoopAgentsEditor value={recipe()} onChange={change} />)
  await act(async () => resolve(response({ config: { ...recipe(), agents: { ...recipe().agents, developer: { provider: 'claude', model: 'first-project' } } } })))
  expect(change).not.toHaveBeenCalled()
})
it('imports definitions and the historical decider into a portable loop draft', async () => {
  const config = { ...recipe(), providers: [{ id: 'private-connection' }], verification: [{ command: 'private-check' }], roles: { auditor: { provider: 'claude', access: 'read', artifacts: 'none', prompt: 'old' } }, rolePrompts: { ...recipe().rolePrompts, auditor: 'Effective auditor definition' } }
  const original = global.fetch
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => String(url).endsWith('/agent-runtime/config') ? Promise.resolve(response({ config }))
    : String(url).endsWith('/agent-runtime/loop-roles') ? Promise.resolve(response({ roles: { decider: { provider: 'codex', model: 'saved-decision-model' } } })) : original(url, init)))
  const change = vi.fn()
  render(<LoopAgentsEditor value={recipe()} onChange={change} />)
  const button = await screen.findByRole('button', { name: 'Import current project agents' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await waitFor(() => expect(change).toHaveBeenCalledOnce())
  const imported = change.mock.calls[0][0]
  expect(imported.roles).toMatchObject({ auditor: { prompt: 'Effective auditor definition' }, 'loop-decider': { provider: 'codex', model: 'saved-decision-model' } })
  expect(imported).not.toHaveProperty('providers')
  expect(imported).not.toHaveProperty('verification')
  expect(config.roles.auditor.prompt).toBe('old')
})

const graphWith = (nodes: Array<[string, string, Record<string, unknown>]>): LoopGraph => ({
  nodes: nodes.map(([id, kind, params]) => ({ id, type: 'core', position: { x: 0, y: 0 }, data: { kind, params } })),
  edges: [], config: { maxIterations: 12, timeoutMinutes: 0 },
})
it('shows Freestyle agents and refreshes the visible roles when switching to Quick SDD', async () => {
  const config = recipe(), change = vi.fn()
  const freestyle = graphWith([['implement', 'prompt', {}], ['fix', 'prompt', {}], ['decide', 'decider', { roleId: 'loop-decider' }]])
  const view = render(<LoopAgentsEditor value={config} graph={freestyle} onChange={change} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import current project agents' })).toBeEnabled())
  expect(screen.queryByText('architect', { selector: 'summary' })).not.toBeInTheDocument()
  expect(screen.queryByText('reviewer', { selector: 'summary' })).not.toBeInTheDocument()
  expect(screen.getByText('developer', { selector: 'summary' })).toBeInTheDocument()
  expect(screen.getByText('fixer', { selector: 'summary' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'loop-decider' })).toBeInTheDocument()
  view.rerender(<LoopAgentsEditor value={config} graph={graphWith([['prepare', 'prompt', {}], ['apply', 'prompt', {}]])} onChange={change} />)
  expect(screen.getByText('architect', { selector: 'summary' })).toBeInTheDocument()
  expect(screen.queryByText('fixer', { selector: 'summary' })).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'loop-decider' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Also show agents not used in this loop'))
  expect(screen.getByText('reviewer', { selector: 'summary' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'loop-decider' })).toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
  expect(config.rolePrompts?.reviewer).toBe('Review the task')
})

it('shows only the selected phase agent and its policy, including after changing phases', async () => {
  const change = vi.fn(), view = render(<LoopAgentsEditor mode="step" selectedRole="architect" value={recipe()} onChange={change} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Use the Core definition' })).toBeEnabled())
  expect(screen.getByDisplayValue('Plan the task')).toBeInTheDocument()
  expect(screen.queryByDisplayValue('Develop the task')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Import current project agents' })).not.toBeInTheDocument()
  view.rerender(<LoopAgentsEditor mode="step" selectedRole="reviewer" value={recipe()} onChange={change} />)
  expect(screen.getByDisplayValue('Review the task')).toBeInTheDocument()
  expect(screen.queryByDisplayValue('Plan the task')).not.toBeInTheDocument()
  view.rerender(<LoopAgentsEditor mode="step" selectedRole="archive" value={recipe()} onChange={change} />)
  expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
  expect(screen.getByRole('checkbox')).toBeInTheDocument()
})

it('previews what an inherited definition resolves to and lets the user customize it or return to the engine default', async () => {
  const changes = vi.fn()
  function Draft() { const [value, setValue] = useState<LoopAgentConfig>({ ...recipe(), rolePrompts: { ...recipe().rolePrompts, architect: 'inherit' } }); return <LoopAgentsEditor mode="step" selectedRole="architect" value={value} onChange={next => { changes(next); setValue(next) }} /> }
  render(<Draft />)
  const preview = await screen.findByDisplayValue('Core architect text')
  expect(preview).toHaveAttribute('readonly')
  expect(screen.getByText('Follows the Core definition: every Core upgrade updates it automatically.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Customize for this loop' }))
  expect(changes.mock.calls.at(-1)?.[0].rolePrompts.architect).toBe('Core architect text')
  expect(screen.getByDisplayValue('Core architect text')).not.toHaveAttribute('readonly')
  fireEvent.click(screen.getByRole('button', { name: 'Use the Core definition' }))
  expect(changes.mock.calls.at(-1)?.[0].rolePrompts.architect).toBe('inherit')
})
it('allows a step to inherit the mission provider instead of fixing a provider', async () => {
  const changes = vi.fn()
  function Draft() { const [value, setValue] = useState(recipe()); return <LoopAgentsEditor value={value} selectedRole="developer" onChange={next => { changes(next); setValue(next) }} /> }
  render(<Draft />)
  const section = screen.getByText('developer', { selector: 'summary' }).parentElement!
  await within(section).findByRole('option', { name: 'Inherit mission provider' })
  fireEvent.change(within(section).getByLabelText('Provider'), { target: { value: 'inherit' } })
  expect(changes.mock.calls.at(-1)?.[0].agents.developer).toMatchObject({ provider: 'inherit' })
})
