import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TemplatePreviewModal } from '../TemplatePreviewModal'
import type { LoopTemplateSummary } from '../../../lib/loops-api'

function tmpl(over: Partial<LoopTemplateSummary> = {}): LoopTemplateSummary {
  return {
    id: 'ship-and-green',
    name: 'Ship & Green',
    description: 'Implement and verify.',
    tags: ['CI', 'testing'],
    graph: {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}' } },
        { id: 'v', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: '{{cmd:verify}}' } },
        { id: 'd', type: 'decider', position: { x: 0, y: 3 }, data: { goal: 'all tests pass' } },
        { id: 'e', type: 'end', position: { x: 1, y: 3 }, data: { outcome: 'success' } },
      ],
      edges: [],
      config: { maxIterations: 10, timeoutMinutes: 30 },
    },
    ...over,
  }
}

describe('TemplatePreviewModal', () => {
  it('renders nothing open when template is null', () => {
    render(<TemplatePreviewModal template={null} onClose={() => {}} onUse={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the template name, description, tags, steps and limits', () => {
    render(<TemplatePreviewModal template={tmpl()} onClose={() => {}} onUse={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Ship & Green')).toBeInTheDocument()
    expect(within(dialog).getByText('Implement and verify.')).toBeInTheDocument()
    expect(within(dialog).getByText('CI')).toBeInTheDocument()
    // The authored prompts + decider goal are rendered verbatim.
    expect(within(dialog).getByText('{{cmd:implement}}')).toBeInTheDocument()
    expect(within(dialog).getByText('{{cmd:verify}}')).toBeInTheDocument()
    expect(within(dialog).getByText('all tests pass')).toBeInTheDocument()
    // Run limits are surfaced (10 iterations / 30 min).
    expect(within(dialog).getByText(/10/)).toBeInTheDocument()
  })

  it('fires onUse with the template id from the Use button', () => {
    const onUse = vi.fn()
    render(<TemplatePreviewModal template={tmpl()} onClose={() => {}} onUse={onUse} />)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Use template/i }))
    expect(onUse).toHaveBeenCalledWith('ship-and-green')
  })

  it('labels the CTA "Use template" in use mode (default)', () => {
    render(<TemplatePreviewModal template={tmpl()} onClose={() => {}} onUse={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /Use template/i })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Fork to edit/i })).not.toBeInTheDocument()
  })

  it('labels the CTA "Fork to edit" in fork mode (built-in factory loop)', () => {
    render(<TemplatePreviewModal template={tmpl()} mode="fork" onClose={() => {}} onUse={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: /Fork to edit/i })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Use template/i })).not.toBeInTheDocument()
  })

  it('fires onUse with the id from the Fork button in fork mode', () => {
    const onUse = vi.fn()
    render(<TemplatePreviewModal template={tmpl()} mode="fork" onClose={() => {}} onUse={onUse} />)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Fork to edit/i }))
    expect(onUse).toHaveBeenCalledWith('ship-and-green')
  })

  it('fires onClose from the Cancel button', () => {
    const onClose = vi.fn()
    render(<TemplatePreviewModal template={tmpl()} onClose={onClose} onUse={() => {}} />)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
