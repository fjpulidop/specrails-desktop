import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../test-utils'
import { AiEngineSelector } from '../AiEngineSelector'

// ─── AiEngineSelector ────────────────────────────────────────────────────────
//
// Renders nothing (null) when providers.length <= 1.
// Renders a Radix Select trigger (data-testid="ai-engine-selector") when > 1.
// Shows providerLabel text for the current value and all options.
// Calls onChange when an option is selected.

describe('AiEngineSelector', () => {
  // ── Null / single-provider cases ────────────────────────────────────────

  it('renders nothing when providers is empty', () => {
    const { container } = render(
      <AiEngineSelector value="claude" providers={[]} onChange={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when providers has exactly one entry', () => {
    const { container } = render(
      <AiEngineSelector value="claude" providers={['claude']} onChange={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('queryByTestId returns null for single-provider', () => {
    const { queryByTestId } = render(
      <AiEngineSelector value="claude" providers={['claude']} onChange={vi.fn()} />,
    )
    expect(queryByTestId('ai-engine-selector')).toBeNull()
  })

  // ── Multi-provider render ────────────────────────────────────────────────

  it('renders the trigger when providers.length > 1', () => {
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('ai-engine-selector')).toBeInTheDocument()
  })

  it('trigger is a combobox role', () => {
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('shows the providerLabel of the current value in the trigger (claude → "Claude")', () => {
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toMatch(/claude/i)
  })

  it('shows the providerLabel of the current value in the trigger (codex → "Codex")', () => {
    render(
      <AiEngineSelector
        value="codex"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toMatch(/codex/i)
  })

  // ── aria-label ───────────────────────────────────────────────────────────

  it('applies default aria-label "AI engine" to the trigger', () => {
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('AI engine')).toBeInTheDocument()
  })

  it('applies custom ariaLabel when provided', () => {
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
        ariaLabel="Pick engine"
      />,
    )
    expect(screen.getByLabelText('Pick engine')).toBeInTheDocument()
  })

  // ── disabled ─────────────────────────────────────────────────────────────

  it('trigger is disabled when disabled prop is true', () => {
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
        disabled
      />,
    )
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('trigger is enabled by default', () => {
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox')).not.toBeDisabled()
  })

  it('does not call onChange when disabled trigger is clicked', () => {
    const onChange = vi.fn()
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={onChange}
        disabled
      />,
    )
    fireEvent.click(screen.getByRole('combobox'))
    expect(onChange).not.toHaveBeenCalled()
  })

  // ── Dropdown opens and lists options ────────────────────────────────────

  it('opens the dropdown and shows providerLabel for all providers', async () => {
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByRole('option', { name: /claude/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /codex/i })).toBeInTheDocument()
  })

  it('renders providerLabel text ("Claude") inside an option', async () => {
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="codex"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    const claudeOption = screen.getByRole('option', { name: /claude/i })
    expect(claudeOption.textContent).toMatch(/claude/i)
  })

  it('renders providerLabel text ("Codex") inside an option', async () => {
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    const codexOption = screen.getByRole('option', { name: /codex/i })
    expect(codexOption.textContent).toMatch(/codex/i)
  })

  // ── onChange callback ────────────────────────────────────────────────────

  it('calls onChange with "codex" when the codex option is selected', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /codex/i }))
    expect(onChange).toHaveBeenCalledWith('codex')
  })

  it('calls onChange with "claude" when the claude option is selected', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="codex"
        providers={['claude', 'codex']}
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /claude/i }))
    expect(onChange).toHaveBeenCalledWith('claude')
  })

  it('calls onChange once per selection', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex']}
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /codex/i }))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  // ── Three-provider case ──────────────────────────────────────────────────

  it('renders all three providers when providers has three entries', async () => {
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex', 'unknown-provider']}
        onChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
  })

  it('falls through to provider id as label for unknown provider', async () => {
    const user = userEvent.setup()
    render(
      <AiEngineSelector
        value="claude"
        providers={['claude', 'codex', 'my-custom-engine']}
        onChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('combobox'))
    // providerLabel falls back to the raw id string
    expect(screen.getByRole('option', { name: /my-custom-engine/i })).toBeInTheDocument()
  })

  // ── Auth badge (provider-auto-detection) ────────────────────────────────

  it('shows a not-signed-in badge for unauthenticated detected providers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        detected: ['claude', 'codex'],
        providers: {
          claude: { id: 'claude', authState: 'authenticated', usable: true, installed: true, executable: true, displayName: 'Claude' },
          codex: { id: 'codex', authState: 'unauthenticated', usable: true, installed: true, executable: true, displayName: 'Codex' },
        },
      }),
    } as unknown as Response)
    try {
      const user = userEvent.setup()
      render(
        <AiEngineSelector
          value="claude"
          providers={['claude', 'codex']}
          onChange={vi.fn()}
        />,
      )
      await user.click(screen.getByRole('combobox'))
      const codexOption = await screen.findByRole('option', { name: /codex/i })
      expect(codexOption.textContent).toMatch(/not signed in/i)
      const claudeOption = screen.getByRole('option', { name: /claude/i })
      expect(claudeOption.textContent).not.toMatch(/not signed in/i)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
