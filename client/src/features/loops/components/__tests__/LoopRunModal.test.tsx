import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { LoopRunModal, type RunModalProject } from '../LoopRunModal'

const PROJECTS: RunModalProject[] = [
  { id: 'p1', name: 'Project One', providers: ['claude'] },
  { id: 'p2', name: 'Project Two', providers: ['claude', 'codex'] },
  { id: 'p3', name: 'Kimi Project', providers: ['kimi'] },
]

describe('LoopRunModal', () => {
  it('renders nothing when no loop is set', () => {
    render(<LoopRunModal loop={null} projects={PROJECTS} onClose={() => {}} onExecute={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists projects and executes with the chosen project', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('option', { name: 'Project One' })).toBeInTheDocument()
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
    fireEvent.change(within(dialog).getByTestId('run-project-select'), { target: { value: 'p2' } })
    expect(within(dialog).getByLabelText('Provider')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2', provider: 'claude' }))
  })

  it('offers a model picker and executes with the chosen model (default = provider default)', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    // p1 is claude → claude catalog, default Claude Sonnet.
    const modelSel = within(dialog).getByTestId('run-model-select') as HTMLSelectElement
    expect(within(modelSel).getByRole('option', { name: 'Claude Sonnet' })).toBeInTheDocument()
    expect(within(modelSel).getByRole('option', { name: 'Claude Opus' })).toBeInTheDocument()
    expect(modelSel.value).toBe('sonnet')
    // pick a non-default model
    fireEvent.change(modelSel, { target: { value: 'opus' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', model: 'opus' }))
  })

  it('swaps the model catalog + default when the provider changes', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    // Switch to p2 (claude+codex), then pick codex as the provider.
    fireEvent.change(within(dialog).getByTestId('run-project-select'), { target: { value: 'p2' } })
    fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'codex' } })
    const modelSel = within(dialog).getByTestId('run-model-select') as HTMLSelectElement
    // Codex catalog, default GPT-5.5; no Claude models present.
    expect(modelSel.value).toBe('gpt-5.5')
    expect(within(modelSel).getByRole('option', { name: 'GPT-5.5' })).toBeInTheDocument()
    expect(within(modelSel).queryByRole('option', { name: 'Claude Sonnet' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /Execute/i }))
    expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', model: 'gpt-5.5' }))
  })

  it('offers only Kimi low/high/max effort and submits a valid default', () => {
    const onExecute = vi.fn()
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={PROJECTS} onClose={() => {}} onExecute={onExecute} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('run-project-select'), { target: { value: 'p3' } })
    const effort = within(dialog).getByLabelText('Reasoning effort') as HTMLSelectElement
    expect(Array.from(effort.options, (option) => option.value)).toEqual(['low', 'high', 'max'])
    expect(effort.value).toBe('high')
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
    fireEvent.change(within(dialog).getByTestId('run-project-select'), { target: { value: 'p3' } })
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
    fireEvent.change(within(dialog).getByTestId('run-project-select'), { target: { value: 'p3' } })

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
    fireEvent.change(within(dialog).getByTestId('run-project-select'), { target: { value: 'p3' } })
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
