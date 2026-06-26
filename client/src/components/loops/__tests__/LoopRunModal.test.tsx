import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { LoopRunModal, type RunModalProject } from '../LoopRunModal'

const PROJECTS: RunModalProject[] = [
  { id: 'p1', name: 'Project One', providers: ['claude'] },
  { id: 'p2', name: 'Project Two', providers: ['claude', 'codex'] },
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

  it('disables Execute when there are no projects', () => {
    render(<LoopRunModal loop={{ id: 'l1', name: 'CI Watch' }} projects={[]} onClose={() => {}} onExecute={() => {}} />)
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Execute/i })).toBeDisabled()
  })
})
