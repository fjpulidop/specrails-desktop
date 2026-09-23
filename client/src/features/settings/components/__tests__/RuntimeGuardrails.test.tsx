import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { render, screen, within } from '../../../../test-utils'
import { RuntimeGuardrails } from '../RuntimeGuardrails'
import { isGuardrailsCatalogResponse, setGuardrail, type GuardrailDescriptor } from '../../lib/agent-runtime'

const catalog: GuardrailDescriptor[] = [
  { id: 'plan-validation', phase: 'architect' },
  { id: 'genuine-blocking-question', phase: 'architect' },
  { id: 'frozen-plan-writes', phase: 'developer' },
  { id: 'verify-idle-timeout', phase: 'host' },
]
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
function mockCatalog(body: unknown, ok = true) {
  global.fetch = vi.fn().mockImplementation(async () => response(body, ok))
}

/** Mirrors the section: the switches mutate the SAME config the Save button persists. */
function Harness({ initial, onChange }: { initial?: Record<string, boolean>; onChange: (next: Record<string, boolean> | undefined) => void }) {
  const [guardrails, setGuardrails] = useState<Record<string, boolean> | undefined>(initial)
  return <RuntimeGuardrails projectId="p1" guardrails={guardrails} onChange={(next) => { setGuardrails(next); onChange(next) }} />
}

beforeEach(() => { vi.clearAllMocks() })

describe('RuntimeGuardrails', () => {
  it('renders the catalog grouped by phase with every guardrail on by default', async () => {
    mockCatalog({ supported: true, catalog })
    render(<Harness onChange={() => {}} />)
    expect(await screen.findByText('4 of 4 active')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/guardrails', expect.anything())
    expect(within(screen.getByTestId('guardrails-phase-architect')).getAllByRole('switch')).toHaveLength(2)
    expect(within(screen.getByTestId('guardrails-phase-developer')).getAllByRole('switch')).toHaveLength(1)
    expect(within(screen.getByTestId('guardrails-phase-host')).getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'Validated task plan' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('A vague or incomplete plan is the #1 reason a small developer model writes stubs.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).not.toBeInTheDocument()
  })

  it('stores only false entries: off writes the key, on deletes it, reset clears everything', async () => {
    mockCatalog({ supported: true, catalog })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Harness onChange={onChange} />)
    const plan = await screen.findByRole('switch', { name: 'Validated task plan' })
    await user.click(plan)
    expect(onChange).toHaveBeenLastCalledWith({ 'plan-validation': false })
    expect(plan).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('3 of 4 active')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Stop hanging tests' }))
    expect(onChange).toHaveBeenLastCalledWith({ 'plan-validation': false, 'verify-idle-timeout': false })
    await user.click(plan)
    expect(onChange).toHaveBeenLastCalledWith({ 'verify-idle-timeout': false })
    expect(plan).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(screen.getByText('4 of 4 active')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).not.toBeInTheDocument()
  })

  it('reflects a persisted false entry as off', async () => {
    mockCatalog({ supported: true, catalog })
    render(<Harness initial={{ 'frozen-plan-writes': false }} onChange={() => {}} />)
    expect(await screen.findByText('3 of 4 active')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Planning artifacts are frozen' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument()
  })

  it('renders disabled with a note when Core does not support guardrails', async () => {
    mockCatalog({ supported: false, catalog })
    render(<Harness onChange={() => {}} />)
    expect(await screen.findByText(/does not expose configurable guardrails/)).toHaveAttribute('role', 'status')
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled()
    expect(screen.queryByTestId('guardrails-active')).not.toBeInTheDocument()
  })

  it('treats a malformed or failed catalog response as unsupported instead of crashing', async () => {
    mockCatalog({ config: {}, configured: false }, false)
    render(<Harness onChange={() => {}} />)
    expect(await screen.findByText(/does not expose configurable guardrails/)).toHaveAttribute('role', 'status')
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
  })

  it('renders an id from a newer Core with the id as title and a generic description', async () => {
    mockCatalog({ supported: true, catalog: [...catalog, { id: 'future-rule', phase: 'developer' }] })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Harness onChange={onChange} />)
    const future = await screen.findByRole('switch', { name: 'future-rule' })
    expect(screen.getByText('A guardrail added by a newer Core; this app has no description for it yet.')).toBeInTheDocument()
    await user.click(future)
    expect(onChange).toHaveBeenLastCalledWith({ 'future-rule': false })
  })

  it('collapses and expands like the phase cards', async () => {
    mockCatalog({ supported: true, catalog })
    const user = userEvent.setup()
    render(<Harness onChange={() => {}} />)
    await screen.findByText('4 of 4 active')
    await user.click(screen.getByRole('button', { name: 'Collapse: Guardrails' }))
    expect(screen.getByRole('switch', { name: 'Validated task plan', hidden: true })).not.toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Open: Guardrails' }))
    expect(screen.getByRole('switch', { name: 'Validated task plan' })).toBeVisible()
  })

  it('exposes pure helpers', () => {
    expect(isGuardrailsCatalogResponse({ supported: true, catalog })).toBe(true)
    expect(isGuardrailsCatalogResponse({ supported: true, catalog: [{ id: 'x', phase: 'nope' }] })).toBe(false)
    expect(isGuardrailsCatalogResponse(null)).toBe(false)
    expect(setGuardrail(undefined, 'a', false)).toEqual({ a: false })
    expect(setGuardrail({ a: false }, 'a', true)).toBeUndefined()
    expect(setGuardrail({ a: false, b: false }, 'a', true)).toEqual({ b: false })
  })
})
