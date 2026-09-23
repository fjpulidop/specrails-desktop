import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import {
  AiEditShell,
  PlainComposer,
  WordDiffView,
  stripMarkers,
  computeWordDiff,
  type AiEditHistoryTurn,
} from '../AiEditShell'

function renderShell(overrides: Partial<React.ComponentProps<typeof AiEditShell>> = {}) {
  return render(
    <AiEditShell
      uiPhase="composing"
      eyebrow="AI Edit"
      targetLabel="sr-developer"
      headline="Refine your agent"
      streamingHeadline="Refining…"
      composer={<textarea data-testid="composer" />}
      canApply={false}
      onApply={vi.fn()}
      onDiscard={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  )
}

describe('AiEditShell minimize button', () => {
  it('does not render the minimize button when onMinimize is omitted', () => {
    renderShell()
    expect(screen.queryByTestId('ai-edit-minimize')).toBeNull()
  })

  it('renders the minimize button and fires onMinimize on click', () => {
    const onMinimize = vi.fn()
    renderShell({ onMinimize })
    fireEvent.click(screen.getByTestId('ai-edit-minimize'))
    expect(onMinimize).toHaveBeenCalledTimes(1)
  })

  it('minimize never opens the discard-confirm dialog (non-destructive)', () => {
    const onMinimize = vi.fn()
    const onDiscard = vi.fn()
    renderShell({ onMinimize, onDiscard, uiPhase: 'streaming' })
    fireEvent.click(screen.getByTestId('ai-edit-minimize'))
    expect(screen.queryByText(/Discard refinement/i)).toBeNull()
    expect(onDiscard).not.toHaveBeenCalled()
  })
})

describe('AiEditShell composing phase', () => {
  it('renders headline, eyebrow, description and the composer', () => {
    renderShell({ description: 'Implements features end to end' })
    expect(screen.getByRole('heading', { name: 'Refine your agent' })).toBeInTheDocument()
    expect(screen.getByText('AI Edit')).toBeInTheDocument()
    expect(screen.getByText('Implements features end to end')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('renders the target label as mono code by default', () => {
    renderShell()
    const label = screen.getByText('sr-developer')
    expect(label.tagName).toBe('CODE')
  })

  it('renders the target label as plain text when targetLabelMono is false', () => {
    renderShell({ targetLabelMono: false })
    const label = screen.getByText('sr-developer')
    expect(label.tagName).toBe('SPAN')
  })

  it('shows quick prompt chips and forwards a click to onChipSubmit', () => {
    const onChipSubmit = vi.fn()
    renderShell({ chips: ['Make it stricter', 'Add tests'], onChipSubmit })
    expect(screen.getByText('Quick prompts')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make it stricter' }))
    expect(onChipSubmit).toHaveBeenCalledWith('Make it stricter')
  })

  it('hides chips once history is non-empty', () => {
    renderShell({
      chips: ['Make it stricter'],
      onChipSubmit: vi.fn(),
      history: [{ role: 'user', content: 'first turn' }],
    })
    expect(screen.queryByText('Quick prompts')).toBeNull()
  })

  it('shows user turns and auto-test results under History, filtering assistant turns', () => {
    const history: AiEditHistoryTurn[] = [
      { role: 'user', content: 'tighten the prompt' },
      { role: 'assistant', content: 'done' },
      { role: 'system', kind: 'test_result', content: 'all green' },
    ]
    renderShell({ history })
    expect(screen.getByText('History')).toBeInTheDocument()
    expect(screen.getByText('tighten the prompt')).toBeInTheDocument()
    expect(screen.getByText('Auto-test result')).toBeInTheDocument()
    expect(screen.getByText('all green')).toBeInTheDocument()
    // assistant turns are filtered out of the focused column
    expect(screen.queryByText('Refinement ready — review the diff on the right.')).toBeNull()
  })

  it('toggles the current-body disclosure open and closed', () => {
    renderShell({ baseBody: 'You are sr-developer.' })
    const toggle = screen.getByRole('button', { name: /View current content/ })
    expect(screen.queryByText('You are sr-developer.')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('You are sr-developer.')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.queryByText('You are sr-developer.')).toBeNull()
  })

  it('uses a custom disclosure label when provided', () => {
    renderShell({ baseBody: 'body', baseBodyDisclosureLabel: 'View agent file' })
    expect(screen.getByRole('button', { name: /View agent file/ })).toBeInTheDocument()
  })

  it('renders the composer accessory below the composer', () => {
    renderShell({ composerAccessory: <div data-testid="accessory" /> })
    expect(screen.getByTestId('accessory')).toBeInTheDocument()
  })

  it('Escape closes directly without a confirm dialog', () => {
    const onClose = vi.fn()
    renderShell({ onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('header back button closes directly in composing', () => {
    const onClose = vi.fn()
    renderShell({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Back (Esc)' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('forwards unhandled key events to onKeyDown', () => {
    const onKeyDown = vi.fn()
    renderShell({ onKeyDown })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(onKeyDown.mock.calls[0][0].key).toBe('a')
  })

  it('restores focus to the previously focused element on unmount', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    const { unmount } = renderShell()
    unmount()
    expect(document.activeElement).toBe(button)
    button.remove()
  })
})

describe('AiEditShell streaming phase', () => {
  it('shows the streaming headline and the working indicator without streamingText', () => {
    renderShell({ uiPhase: 'streaming' })
    expect(screen.getByRole('heading', { name: 'Refining…' })).toBeInTheDocument()
    expect(screen.getByText('Working on your refinement…')).toBeInTheDocument()
  })

  it('renders streamingText with tool markers stripped', () => {
    renderShell({
      uiPhase: 'streaming',
      streamingText: 'Updating prompt<!--tool:Read--> now',
    })
    expect(screen.getByText(/Updating prompt now/)).toBeInTheDocument()
    expect(screen.queryByText(/tool:Read/)).toBeNull()
  })

  it('Escape opens the confirm dialog; Keep editing cancels it', () => {
    const onDiscard = vi.fn()
    const onClose = vi.fn()
    renderShell({ uiPhase: 'streaming', onDiscard, onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    const dialog = screen.getByRole('alertdialog', { name: 'Discard changes?' })
    expect(within(dialog).getByText('Discard refinement?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onDiscard).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('confirming the dialog calls onDiscard', () => {
    const onDiscard = vi.fn()
    renderShell({ uiPhase: 'streaming', onDiscard })
    fireEvent.keyDown(window, { key: 'Escape' })
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('AiEditShell error phase', () => {
  it('shows the error headline and message instead of the normal headline', () => {
    renderShell({ uiPhase: 'error', errorMessage: 'Server error (500)' })
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.getByText('Server error (500)')).toBeInTheDocument()
    expect(screen.queryByText('Refine your agent')).toBeNull()
  })
})

describe('AiEditShell reviewing phase (split layout)', () => {
  const reviewingProps = {
    uiPhase: 'reviewing' as const,
    history: [
      { role: 'user', content: 'make it shorter' },
      { role: 'assistant', content: 'ok' },
      { role: 'system', kind: 'test_result', content: 'PASS 3/3' },
    ] satisfies AiEditHistoryTurn[],
    diff: <div data-testid="diff-content">diff here</div>,
    canApply: true,
  }

  it('renders the conversation column and the diff pane with default labels', () => {
    renderShell(reviewingProps)
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument()
    const diffPane = screen.getByRole('region', { name: 'Diff preview' })
    expect(within(diffPane).getByText('Proposed changes')).toBeInTheDocument()
    expect(within(diffPane).getByText('word-level diff')).toBeInTheDocument()
    expect(screen.getByTestId('diff-content')).toBeInTheDocument()
  })

  it('renders a custom diff header label', () => {
    renderShell({ ...reviewingProps, diffHeaderLabel: 'sr-developer.md' })
    expect(screen.getByText('sr-developer.md')).toBeInTheDocument()
    expect(screen.queryByText('Proposed changes')).toBeNull()
  })

  it('renders user, assistant and test-result chat turns', () => {
    renderShell(reviewingProps)
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('make it shorter')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(
      screen.getByText('Refinement ready — review the diff on the right.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Auto-test result')).toBeInTheDocument()
    expect(screen.getByText('PASS 3/3')).toBeInTheDocument()
  })

  it('shows the Apply button when canApply and fires onApply on click', () => {
    const onApply = vi.fn()
    renderShell({ ...reviewingProps, onApply })
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('hides the Apply button when an apply conflict exists', () => {
    renderShell({ ...reviewingProps, applyConflict: 'disk_changed' })
    expect(screen.queryByRole('button', { name: /Apply.*⌘⏎/ })).toBeNull()
  })

  it('Cmd+Enter applies when canApply and there is no conflict', () => {
    const onApply = vi.fn()
    renderShell({ ...reviewingProps, onApply })
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Enter does not apply when canApply is false', () => {
    const onApply = vi.fn()
    renderShell({ ...reviewingProps, canApply: false, onApply })
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(onApply).not.toHaveBeenCalled()
  })

  it('Escape opens the discard confirm dialog while reviewing', () => {
    const onClose = vi.fn()
    renderShell({ ...reviewingProps, onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the disk_changed conflict banner with a working Force apply action', () => {
    const onForceApply = vi.fn()
    renderShell({ ...reviewingProps, applyConflict: 'disk_changed', onForceApply })
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent(
      'The file changed on disk while you were editing. Apply was blocked.',
    )
    fireEvent.click(within(banner).getByRole('button', { name: /Force apply/ }))
    expect(onForceApply).toHaveBeenCalledTimes(1)
  })

  it('omits the Force apply button when onForceApply is not provided', () => {
    renderShell({ ...reviewingProps, applyConflict: 'disk_changed' })
    expect(screen.queryByRole('button', { name: /Force apply/ })).toBeNull()
  })

  it('shows the name_changed conflict banner without a force action', () => {
    renderShell({ ...reviewingProps, applyConflict: 'name_changed' })
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('The AI changed the agent name.')
    expect(screen.queryByRole('button', { name: /Force apply/ })).toBeNull()
  })

  it('renders and fires the secondary action', () => {
    const onClick = vi.fn()
    renderShell({
      ...reviewingProps,
      secondaryAction: { label: 'Open in Studio', onClick },
    })
    fireEvent.click(screen.getByRole('button', { name: /Open in Studio/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders the composer accessory in the chat column', () => {
    renderShell({ ...reviewingProps, composerAccessory: <div data-testid="accessory" /> })
    expect(screen.getByTestId('accessory')).toBeInTheDocument()
  })
})

describe('AiEditShell applied phase', () => {
  it('shows the default applied notice and hides the Discard button', () => {
    renderShell({ uiPhase: 'applied', history: [] })
    expect(screen.getByText('Applied.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  })

  it('renders a custom appliedNotice instead of the default', () => {
    renderShell({
      uiPhase: 'applied',
      appliedNotice: <div data-testid="custom-notice">Saved to disk</div>,
    })
    expect(screen.getByTestId('custom-notice')).toBeInTheDocument()
    expect(screen.queryByText('Applied.')).toBeNull()
  })

  it('Escape closes directly when applied (no confirm dialog)', () => {
    const onClose = vi.fn()
    renderShell({ uiPhase: 'applied', onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('PlainComposer', () => {
  function renderComposer(overrides: Partial<React.ComponentProps<typeof PlainComposer>> = {}) {
    const props = {
      value: '',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      disabled: false,
      placeholder: 'Describe the changes you want…',
      ...overrides,
    }
    render(<PlainComposer {...props} />)
    return props
  }

  it('renders the placeholder and keyboard hints', () => {
    renderComposer()
    expect(
      screen.getByPlaceholderText('Describe the changes you want…'),
    ).toBeInTheDocument()
    expect(screen.getByText(/submit/)).toBeInTheDocument()
    expect(screen.getByText(/cancel/)).toBeInTheDocument()
  })

  it('forwards typing to onChange', () => {
    const { onChange } = renderComposer()
    fireEvent.change(screen.getByPlaceholderText('Describe the changes you want…'), {
      target: { value: 'hello' },
    })
    expect(onChange).toHaveBeenCalledWith('hello')
  })

  it('disables the send button when the value is blank', () => {
    renderComposer({ value: '   ' })
    expect(screen.getByRole('button', { name: 'Send (⌘⏎)' })).toBeDisabled()
  })

  it('submits via the send button when there is text', () => {
    const { onSubmit } = renderComposer({ value: 'tighten it' })
    fireEvent.click(screen.getByRole('button', { name: 'Send (⌘⏎)' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('submits on Cmd+Enter inside the textarea', () => {
    const { onSubmit } = renderComposer({ value: 'tighten it' })
    fireEvent.keyDown(screen.getByPlaceholderText('Describe the changes you want…'), {
      key: 'Enter',
      metaKey: true,
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not submit on plain Enter', () => {
    const { onSubmit } = renderComposer({ value: 'tighten it' })
    fireEvent.keyDown(screen.getByPlaceholderText('Describe the changes you want…'), {
      key: 'Enter',
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables textarea and send button while a turn is in flight', () => {
    renderComposer({ value: 'tighten it', disabled: true })
    expect(screen.getByPlaceholderText('Describe the changes you want…')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send (⌘⏎)' })).toBeDisabled()
  })
})

describe('WordDiffView', () => {
  it('renders eq, add and del hunks with their markers', () => {
    const { container } = render(
      <WordDiffView
        hunks={[
          { type: 'eq', text: 'keep ' },
          { type: 'add', text: 'new' },
          { type: 'del', text: 'old' },
        ]}
      />,
    )
    expect(screen.getByText('keep')).toBeInTheDocument()
    expect(container.querySelector('[data-hunk="add"]')).toHaveTextContent('new')
    expect(container.querySelector('[data-hunk="del"]')).toHaveTextContent('old')
  })
})

describe('stripMarkers', () => {
  it('removes tool markers and leaves other text intact', () => {
    expect(stripMarkers('a<!--tool:Read-->b<!--tool:Grep file.ts-->c')).toBe('abc')
    expect(stripMarkers('no markers')).toBe('no markers')
  })
})

describe('computeWordDiff', () => {
  it('returns a single eq hunk for identical text', () => {
    expect(computeWordDiff('same text', 'same text')).toEqual([
      { type: 'eq', text: 'same text' },
    ])
  })

  it('emits del + add hunks for a changed word', () => {
    const hunks = computeWordDiff('the quick fox', 'the slow fox')
    expect(hunks).toContainEqual({ type: 'del', text: 'quick' })
    expect(hunks).toContainEqual({ type: 'add', text: 'slow' })
    expect(hunks.filter((h) => h.type === 'eq').map((h) => h.text).join('')).toContain('the')
  })

  it('emits only add hunks when old text is empty-ish', () => {
    const hunks = computeWordDiff('', 'brand new')
    expect(hunks.some((h) => h.type === 'add' && h.text.includes('new'))).toBe(true)
    expect(hunks.some((h) => h.type === 'del' && h.text.trim() !== '')).toBe(false)
  })

  it('falls back to line diff for very large inputs', () => {
    const bigLine = Array.from({ length: 10_001 }, () => 'w').join(' ')
    const hunks = computeWordDiff(`${bigLine}\nfoo`, `${bigLine}\nbar`)
    expect(hunks).toEqual([
      { type: 'eq', text: `${bigLine}\n` },
      { type: 'del', text: 'foo\n' },
      { type: 'add', text: 'bar\n' },
    ])
  })
})
