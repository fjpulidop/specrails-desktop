import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '../../../test-utils'
import { EngineChip, PHASE_GROUPS, PIPELINE_PHASES, PhaseCard, PipelineStepper, phaseNumber, type PipelineStep } from '../PipelineStepper'

const steps: PipelineStep[] = [
  { id: 'architect', engine: { kind: 'ai', label: 'Claude', model: 'sonnet', effort: 'high' } },
  { id: 'developer', engine: { kind: 'ai', label: 'lan-box', model: 'qwen3', local: true } },
  { id: 'verification', engine: { kind: 'host', command: 'npm test' } },
  { id: 'fixer', engine: { kind: 'inherit-developer' } },
  { id: 'reviewer', engine: { kind: 'ai', label: 'Gemini', model: null } },
  { id: 'verifier', engine: { kind: 'inherit' } },
  { id: 'decider', engine: { kind: 'host', command: null } },
]

describe('PipelineStepper', () => {
  it('renders the seven phases as two groups (core pipeline 1–5, loop steps 1–2) with their engine chips', () => {
    render(<PipelineStepper steps={steps} active={null} onSelect={() => {}} />)
    const core = within(screen.getByRole('list', { name: 'Core pipeline' })).getAllByRole('listitem')
    const loop = within(screen.getByRole('list', { name: 'Loop steps' })).getAllByRole('listitem')
    expect(core).toHaveLength(5)
    expect(loop).toHaveLength(2)
    expect(core.map((item) => within(item).getByRole('button').getAttribute('aria-label'))).toEqual([
      '1. Architect', '2. Developer', '3. Verification', '4. Fixer', '5. Reviewer',
    ])
    expect(loop.map((item) => within(item).getByRole('button').getAttribute('aria-label'))).toEqual(['1. Verifier', '2. Decider'])
    const chips = screen.getAllByTestId('engine-chip').map((chip) => chip.textContent)
    expect(chips).toEqual(['Claude · sonnet · high', 'lan-box · qwen3', 'Host · npm test', 'Inherits developer', 'Gemini', 'Inherits primary', 'Host · no command'])
    expect(PIPELINE_PHASES).toEqual(['architect', 'developer', 'verification', 'fixer', 'reviewer', 'verifier', 'decider'])
    expect(PHASE_GROUPS).toEqual({ core: ['architect', 'developer', 'verification', 'fixer', 'reviewer'], loop: ['verifier', 'decider'] })
    expect(phaseNumber('reviewer')).toBe(5)
    expect(phaseNumber('decider')).toBe(2)
  })

  it('labels each group with its heading and hint, and separates them with a rail-loop divider instead of a step arrow', () => {
    render(<PipelineStepper steps={steps} active={null} onSelect={() => {}} />)
    const core = within(screen.getByTestId('phase-group-heading-core'))
    expect(core.getByText('Core pipeline')).toBeInTheDocument()
    expect(core.getByText('Runs inside every implement: plan, build, verify, fix, review.')).toBeInTheDocument()
    const loop = within(screen.getByTestId('phase-group-heading-loop'))
    expect(loop.getByText('Loop steps')).toBeInTheDocument()
    expect(loop.getByText(/AI steps of the rail's loop around the run/)).toBeInTheDocument()
    expect(loop.getByText('rail loop')).toBeInTheDocument()
    expect(screen.getByTestId('phase-group-divider')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-group-core')).toHaveAccessibleName('Core pipeline')
    expect(screen.getByTestId('pipeline-group-loop')).toHaveAccessibleName('Loop steps')
  })

  it('shows the fixer engine when it has its own, else that it inherits the developer', () => {
    const own = steps.map((step) => step.id === 'fixer' ? { ...step, engine: { kind: 'ai' as const, label: 'Claude', model: 'opus', effort: 'high' } } : step)
    const { rerender } = render(<PipelineStepper steps={own} active={null} onSelect={() => {}} />)
    expect(within(screen.getByRole('button', { name: '4. Fixer' })).getByTestId('engine-chip')).toHaveTextContent('Claude · opus · high')
    rerender(<PipelineStepper steps={steps} active={null} onSelect={() => {}} />)
    expect(within(screen.getByRole('button', { name: '4. Fixer' })).getByTestId('engine-chip')).toHaveTextContent('Inherits developer')
  })

  it('marks the active step and selects a phase on click', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<PipelineStepper steps={steps} active="developer" onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: '2. Developer' })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: '1. Architect' })).not.toHaveAttribute('aria-current')
    await user.click(screen.getByRole('button', { name: '1. Verifier' }))
    expect(onSelect).toHaveBeenCalledWith('verifier')
  })

  it('PhaseCard is a group named after the phase whose header toggles the body', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<PhaseCard phase="reviewer" engine={{ kind: 'ai', label: 'Codex', model: 'gpt-5.5' }} open active={false} onToggle={onToggle}><input aria-label="Model" /></PhaseCard>)
    const card = within(screen.getByRole('group', { name: 'Reviewer' }))
    expect(card.getByLabelText('Model')).toBeVisible()
    expect(card.getByTestId('engine-chip')).toHaveTextContent('Codex · gpt-5.5')
    await user.click(card.getByRole('button', { name: 'Collapse: 5. Reviewer' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<PhaseCard phase="reviewer" engine={{ kind: 'ai', label: 'Codex', model: 'gpt-5.5' }} open={false} active onToggle={onToggle}><input aria-label="Model" /></PhaseCard>)
    expect(card.getByRole('button', { name: 'Open: 5. Reviewer' })).toHaveAttribute('aria-expanded', 'false')
    expect(card.getByLabelText('Model')).not.toBeVisible()
  })

  it('EngineChip renders the host and inherit shapes', () => {
    render(<><EngineChip engine={{ kind: 'host' }} /><EngineChip engine={{ kind: 'inherit' }} /><EngineChip engine={{ kind: 'inherit-developer' }} /></>)
    const chips = screen.getAllByTestId('engine-chip').map((chip) => chip.textContent)
    expect(chips).toEqual(['Host · no command', 'Inherits primary', 'Inherits developer'])
  })
})
