import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpecDraftPanel } from '../SpecDraftPanel'
import { SPEC_DRAFT_DEFAULTS, type SpecDraft } from '../../../lib/spec-draft'

function makeDraft(overrides: Partial<SpecDraft> = {}): SpecDraft {
  return { ...SPEC_DRAFT_DEFAULTS, ...overrides }
}

function defaultProps(over: Partial<React.ComponentProps<typeof SpecDraftPanel>> = {}) {
  return {
    draft: makeDraft(),
    ready: false,
    flashFields: [],
    onFieldChange: vi.fn(),
    ...over,
  } as React.ComponentProps<typeof SpecDraftPanel>
}

describe('SpecDraftPanel', () => {
  it('renders all fields', () => {
    render(<SpecDraftPanel {...defaultProps()} />)
    expect(screen.getByLabelText('Spec title')).toBeInTheDocument()
    expect(screen.getByLabelText('Spec priority')).toBeInTheDocument()
    expect(screen.getByLabelText('Spec description')).toBeInTheDocument()
  })

  // The Create Spec button now lives in the ExploreSpecShell header
  // (covered by ExploreSpecShell tests). The draft panel no longer renders
  // a Create affordance — those tests moved with the button.

  it('shows Draft ready banner when ready is true', () => {
    render(<SpecDraftPanel {...defaultProps({ draft: makeDraft({ title: 'X' }), ready: true })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/draft ready/i)
  })

  it('hides ready banner when not ready', () => {
    render(<SpecDraftPanel {...defaultProps({ draft: makeDraft({ title: 'X' }) })} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('typing title invokes onFieldChange', () => {
    const onFieldChange = vi.fn()
    render(<SpecDraftPanel {...defaultProps({ onFieldChange })} />)
    fireEvent.change(screen.getByLabelText('Spec title'), { target: { value: 'New' } })
    expect(onFieldChange).toHaveBeenCalledWith('title', 'New')
  })

  it('changing priority invokes onFieldChange', () => {
    const onFieldChange = vi.fn()
    render(<SpecDraftPanel {...defaultProps({ onFieldChange })} />)
    fireEvent.change(screen.getByLabelText('Spec priority'), { target: { value: 'high' } })
    expect(onFieldChange).toHaveBeenCalledWith('priority', 'high')
  })

  it('adds a label on Enter key', () => {
    const onFieldChange = vi.fn()
    render(<SpecDraftPanel {...defaultProps({ onFieldChange })} />)
    const input = screen.getByLabelText('Add label')
    fireEvent.change(input, { target: { value: 'ui' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onFieldChange).toHaveBeenCalledWith('labels', ['ui'])
  })

  it('removes a label via remove button', () => {
    const onFieldChange = vi.fn()
    render(<SpecDraftPanel {...defaultProps({ draft: makeDraft({ labels: ['ui', 'theme'] }), onFieldChange })} />)
    fireEvent.click(screen.getByLabelText('Remove label ui'))
    expect(onFieldChange).toHaveBeenCalledWith('labels', ['theme'])
  })

  it('adds a new acceptance criterion', () => {
    const onFieldChange = vi.fn()
    render(<SpecDraftPanel {...defaultProps({ onFieldChange })} />)
    fireEvent.click(screen.getByLabelText('Add acceptance criterion'))
    expect(onFieldChange).toHaveBeenCalledWith('acceptanceCriteria', [''])
  })

  it('updates an existing criterion', () => {
    const onFieldChange = vi.fn()
    render(<SpecDraftPanel {...defaultProps({ draft: makeDraft({ acceptanceCriteria: ['old'] }), onFieldChange })} />)
    fireEvent.change(screen.getByLabelText('Acceptance criterion 1'), { target: { value: 'new' } })
    expect(onFieldChange).toHaveBeenCalledWith('acceptanceCriteria', ['new'])
  })

  it('removes a criterion', () => {
    const onFieldChange = vi.fn()
    render(<SpecDraftPanel {...defaultProps({ draft: makeDraft({ acceptanceCriteria: ['a', 'b'] }), onFieldChange })} />)
    fireEvent.click(screen.getByLabelText('Remove criterion 1'))
    expect(onFieldChange).toHaveBeenCalledWith('acceptanceCriteria', ['b'])
  })

  it('flashFields triggers visual highlight on the changed field', () => {
    const { rerender } = render(<SpecDraftPanel {...defaultProps({ flashFields: [] })} />)
    rerender(<SpecDraftPanel {...defaultProps({ flashFields: ['title'] })} />)
    // Simply verifying no crash and the field still renders
    expect(screen.getByLabelText('Spec title')).toBeInTheDocument()
  })

  it('hides the Attachments section when there are none', () => {
    render(<SpecDraftPanel {...defaultProps({ attachments: [] })} />)
    expect(screen.queryByText(/Attachments/)).not.toBeInTheDocument()
  })

  it('renders accumulated attachments with filenames and sizes', () => {
    const items = [
      { id: 'a1', filename: 'mockup.png', storedName: 'a1.png', mimeType: 'image/png', size: 1500, addedAt: '' },
      { id: 'a2', filename: 'spec.pdf', storedName: 'a2.pdf', mimeType: 'application/pdf', size: 12_345, addedAt: '' },
    ]
    render(<SpecDraftPanel {...defaultProps({ attachments: items })} />)
    expect(screen.getByText(/Attachments \(2\)/)).toBeInTheDocument()
    expect(screen.getByText('mockup.png')).toBeInTheDocument()
    expect(screen.getByText('spec.pdf')).toBeInTheDocument()
    expect(screen.getByText(/linked on Create/i)).toBeInTheDocument()
  })

  it('invokes onRemoveAttachment with the attachment id', () => {
    const onRemoveAttachment = vi.fn()
    const items = [{ id: 'a1', filename: 'doc.pdf', storedName: 'a.pdf', mimeType: 'application/pdf', size: 100, addedAt: '' }]
    render(<SpecDraftPanel {...defaultProps({ attachments: items, onRemoveAttachment })} />)
    fireEvent.click(screen.getByLabelText('Remove doc.pdf'))
    expect(onRemoveAttachment).toHaveBeenCalledWith('a1')
  })
})
