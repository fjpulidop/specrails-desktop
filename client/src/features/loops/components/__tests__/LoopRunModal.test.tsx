import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { resetLaunchForecastCache } from '../../../../lib/launch-forecast'
import { OPEN_BUDGET_PANEL_EVENT } from '../../../../lib/app-settings-events'
import { LoopRunModal, type RunModalProject } from '../LoopRunModal'

const PROJECTS: RunModalProject[] = [
  { id: 'p1', name: 'Project One', providers: ['claude'] },
  { id: 'p2', name: 'Project Two', providers: ['claude', 'codex'] },
  { id: 'p3', name: 'Kimi Project', providers: ['kimi'] },
]

const openSelect = (trigger: HTMLElement) =>
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
/** Opens a picker and clicks the option with that accessible name. */
const pick = (trigger: HTMLElement, name: string) => {
  openSelect(trigger)
  fireEvent.click(screen.getByRole('option', { name }))
}

describe('LoopRunModal', () => {
  it('renders nothing when no loop is set', () => {
    render(<LoopRunModal loop={null} projects={PROJECTS} onClose={() => {}} onExecute={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists projects and executes with the chosen project', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByTestId('run-project-select')).toHaveTextContent('Project One')
    openSelect(within(dialog).getByTestId('run-project-select'))
    expect(screen.getByRole('option', { name: 'Project One' })).toHaveAttribute('data-state', 'checked')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
  })

  it('shows a provider picker only for multi-provider projects', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    // Default project p1 has a single provider → no provider select.
    expect(within(dialog).queryByLabelText('Provider')).not.toBeInTheDocument()
    // Switch to p2 (two providers) → provider select appears.
    pick(within(dialog).getByTestId('run-project-select'), 'Project Two')
    expect(within(dialog).getByLabelText('Provider')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2', provider: 'claude' }))
  })

  it('offers a model picker and executes with the chosen model (default = provider default)', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    // p1 is claude → claude catalog, default Sonnet.
    const modelSel = within(dialog).getByTestId('run-model-select')
    expect(modelSel).toHaveTextContent('Claude Sonnet 5.5')
    openSelect(modelSel)
    expect(screen.getByRole('option', { name: 'Claude Sonnet 5.5' })).toHaveAttribute('data-state', 'checked')
    // pick a non-default model
    fireEvent.click(screen.getByRole('option', { name: 'Claude Opus 5.5' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', model: 'opus' }))
  })

  it('swaps the model catalog + default when the provider changes', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    // Switch to p2 (claude+codex), then pick codex as the provider.
    pick(within(dialog).getByTestId('run-project-select'), 'Project Two')
    pick(within(dialog).getByLabelText('Provider'), 'Codex')
    const modelSel = within(dialog).getByTestId('run-model-select')
    // Codex catalog, default GPT-6.2 Sol; no Claude models present.
    expect(modelSel).toHaveTextContent('GPT-6.2 Sol')
    openSelect(modelSel)
    expect(screen.getByRole('option', { name: 'GPT-6.2 Sol' })).toHaveAttribute('data-state', 'checked')
    expect(screen.queryByRole('option', { name: 'Claude Sonnet 5.5' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', model: 'gpt-6.2-sol' }))
  })

  it('offers only Kimi low/high/max effort and submits a valid default', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    pick(within(dialog).getByTestId('run-project-select'), 'Kimi Project')
    const effort = within(dialog).getByLabelText('Reasoning effort')
    expect(effort).toHaveTextContent('high')
    openSelect(effort)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['low', 'high', 'max'])
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(within(dialog).getByTestId('run-model-select')).toHaveValue('k3')
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p3',
      model: 'k3',
      effort: 'high',
    }))
  })

  it('clears and omits effort when Kimi switches away from K3', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    pick(within(dialog).getByTestId('run-project-select'), 'Kimi Project')
    expect(within(dialog).getByLabelText('Reasoning effort')).toBeInTheDocument()

    fireEvent.change(within(dialog).getByTestId('run-model-select'), {
      target: { value: 'kimi-for-coding' },
    })
    fireEvent.blur(within(dialog).getByTestId('run-model-select'))
    expect(within(dialog).queryByLabelText('Reasoning effort')).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith({
      projectId: 'p3',
      provider: undefined,
      model: 'kimi-for-coding',
      effort: undefined,
    })
  })

  it('submits a custom Kimi alias byte-for-byte and omits effort', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    pick(within(dialog).getByTestId('run-project-select'), 'Kimi Project')

    const model = within(dialog).getByTestId('run-model-select')
    fireEvent.change(model, { target: { value: 'Moonshot-Team/Private_Coder:v2' } })
    fireEvent.blur(model)
    expect(within(dialog).queryByLabelText('Reasoning effort')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))

    expect(onExecute).toHaveBeenCalledWith({
      projectId: 'p3',
      provider: undefined,
      model: 'Moonshot-Team/Private_Coder:v2',
      effort: undefined,
    })
  })

  it('restores K3 instead of executing a flag-like Kimi alias', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    pick(within(dialog).getByTestId('run-project-select'), 'Kimi Project')
    const model = within(dialog).getByTestId('run-model-select')
    fireEvent.change(model, { target: { value: '--yolo' } })
    fireEvent.blur(model)
    expect(model).toHaveValue('k3')

    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ model: 'k3' }))
  })

  it('disables Execute when there are no projects', () => {
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={[]} onClose={() => {}} onExecute={() => {}} />)
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Execute/i })).toBeDisabled()
  })
})

describe('LoopRunModal launch forecast', () => {
  it('forecasts the loop for the chosen project and engine, and follows a project change', async () => {
    const { TooltipProvider } = await import('../../../../components/ui/tooltip')
    const { resetLaunchForecastCache } = await import('../../../../lib/launch-forecast')
    resetLaunchForecastCache()
    const body = { time: { p25Ms: 360_000, medianMs: 450_000, p75Ms: 540_000, sampleCount: 6 }, cost: null, minSamples: 5, budget: null }
    const calls: string[] = []
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url))
      return String(url).includes('/launch-forecast') ? { ok: true, json: async () => body } : { ok: true, json: async () => ({}) }
    }) as typeof fetch
    render(<TooltipProvider><LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={() => {}} /></TooltipProvider>)
    expect(await screen.findByText('Usually 6–9 min for runs like this')).toBeInTheDocument()
    expect(calls.find((u) => u.includes('/launch-forecast'))).toMatch(/\/api\/projects\/p1\/launch-forecast\?loopId=l1&provider=claude$/)
    pick(screen.getByTestId('run-project-select'), 'Kimi Project')
    await vi.waitFor(() => expect(calls.some((u) => /\/projects\/p3\/launch-forecast\?loopId=l1&provider=kimi$/.test(u))).toBe(true))
  })
})

describe('LoopRunModal with the daily limit reached', () => {
  beforeEach(() => resetLaunchForecastCache())
  const forecast = { time: { p25Ms: 360_000, medianMs: 450_000, p75Ms: 540_000, sampleCount: 6 }, cost: null, minSamples: 5, budget: { scope: 'project', budgetUsd: 10, spentUsd: 10, exhausted: false, resetsAt: null } }

  it('does not execute while the budget is reached: Raise limit opens the spend limits panel', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes('/launch-forecast') ? { ok: true, json: async () => forecast } : { ok: true, json: async () => ({}) }) as typeof fetch
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    await screen.findByRole('button', { name: 'Daily limit reached' })
    fireEvent.click(screen.getByRole('button', { name: /Execute/i }))
    const confirm = await screen.findByTestId('launch-over-budget-dialog')
    expect(onExecute).not.toHaveBeenCalled()
    const opened = vi.fn()
    window.addEventListener(OPEN_BUDGET_PANEL_EVENT, opened)
    try {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Raise limit' }))
      expect(opened).toHaveBeenCalledTimes(1)
    } finally { window.removeEventListener(OPEN_BUDGET_PANEL_EVENT, opened) }
    expect(onExecute).not.toHaveBeenCalled()
  })
})
