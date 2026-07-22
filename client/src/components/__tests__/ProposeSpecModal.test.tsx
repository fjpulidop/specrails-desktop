import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../test-utils'
import { ProposeSpecModal } from '../ProposeSpecModal'
import type { LocalTicket } from '../../types'

// Mock RichAttachmentEditor with a plain textarea so placeholder/change/keydown queries work
vi.mock('../RichAttachmentEditor', () => ({
  RichAttachmentEditor: React.forwardRef(function MockEditor(
    props: { placeholder?: string; ariaLabel?: string; onChange?: () => void; onSubmit?: () => void },
    ref: React.Ref<{ getPlainText: () => string; getAttachmentIds: () => string[]; insertPill: () => void; focus: () => void; resetHeight: () => void; clear: () => void }>,
  ) {
    const inputRef = React.useRef<HTMLTextAreaElement>(null)
    React.useImperativeHandle(ref, () => ({
      getPlainText: () => inputRef.current?.value ?? '',
      getAttachmentIds: () => [],
      insertPill: () => {},
      focus: () => inputRef.current?.focus(),
      resetHeight: () => { if (inputRef.current) inputRef.current.style.height = '' },
      clear: () => { if (inputRef.current) inputRef.current.value = '' },
    }))
    return (
      <textarea
        ref={inputRef}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        onChange={(e) => { void e; props.onChange?.() }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onSubmit?.() }}
      />
    )
  }),
}))

const mockStartWithMessage = vi.fn().mockResolvedValue('conv-1')
const mockAbortStream = vi.fn()

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'proj-1', projects: [{ id: 'proj-1', name: 'Test Project' }] }),
}))

const mockRegisterExploreSpec = vi.fn()
const mockRegisterFastSpec = vi.fn()

vi.mock('../../hooks/useSpecGenTracker', () => ({
  useSpecGenTracker: () => ({
    registerFastSpec: mockRegisterFastSpec,
    registerExploreSpec: mockRegisterExploreSpec,
    specToOpen: null,
    clearSpecToOpen: vi.fn(),
  }),
}))

vi.mock('../../hooks/useSharedWebSocket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useSharedWebSocket')>()
  return {
    ...actual,
    useSharedWebSocket: () => ({
      registerHandler: vi.fn(),
      unregisterHandler: vi.fn(),
    }),
  }
})

vi.mock('../../hooks/useChat', () => ({
  useChatContext: () => ({
    conversations: [],
    activeTabIndex: 0,
    startWithMessage: mockStartWithMessage,
    sendMessage: vi.fn(),
    abortStream: mockAbortStream,
    confirmCommand: vi.fn(),
    dismissCommandProposal: vi.fn(),
    changeConversationModel: vi.fn(),
  }),
}))

const makeTicket = (overrides: Partial<LocalTicket> = {}): LocalTicket => ({
  id: 1,
  title: 'Test Ticket',
  description: '',
  status: 'backlog',
  priority: 'medium',
  labels: [],
  source: 'propose-spec',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

describe('ProposeSpecModal', () => {
  const onCloseMock = vi.fn()
  const onTicketCreatedMock = vi.fn()
  const emptyTickets: LocalTicket[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    mockStartWithMessage.mockResolvedValue('conv-1')
    mockRegisterExploreSpec.mockReset()
    mockRegisterFastSpec.mockReset()
    // Route the modal's default-spec-model fetch transparently so individual
    // tests can keep using mockResolvedValueOnce for the actual generate-spec
    // request without their first mock being consumed by the picker.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: 'sonnet',
            provider: 'claude',
            allowed: [
              { value: 'sonnet', label: 'Claude Sonnet' },
              { value: 'opus', label: 'Claude Opus' },
              { value: 'haiku', label: 'Claude Haiku' },
            ],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
  })

  it('does not render dialog when open=false', () => {
    render(<ProposeSpecModal open={false} onClose={onCloseMock} tickets={emptyTickets} />)
    expect(screen.queryByText('Add Spec')).not.toBeInTheDocument()
  })

  it('renders dialog with textarea when open=true', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    expect(screen.getByText('Add Spec')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/add a dark mode toggle/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /generate spec/i })).toBeInTheDocument()
  })

  it('does not auto-execute command on open', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    expect(mockStartWithMessage).not.toHaveBeenCalled()
  })

  it('disables Generate Spec button when textarea is empty', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const button = screen.getByRole('button', { name: /generate spec/i })
    expect(button).toBeDisabled()
  })

  it('enables Generate Spec button when textarea has content', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const textarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    fireEvent.change(textarea, { target: { value: 'Add dark mode' } })
    const button = screen.getByRole('button', { name: /generate spec/i })
    expect(button).not.toBeDisabled()
  })

  it('exposes a Quick / Explore / Raw segmented control with Quick selected by default', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    const quickTab = tabs.find((t) => t.textContent?.toLowerCase().includes('quick'))
    expect(quickTab).toHaveAttribute('aria-selected', 'true')
    expect(tabs.some((t) => t.textContent?.toLowerCase().includes('raw'))).toBe(true)
  })

  it('switches Kimi to Explore and disables Quick with a localized explanation', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: 'k3',
            provider: 'kimi',
            providers: ['kimi'],
            allowed: [{ value: 'k3', label: 'Kimi K3' }],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    render(<ProposeSpecModal open onClose={onCloseMock} tickets={emptyTickets} onExploreLaunch={vi.fn()} />)

    const quickTab = screen.getAllByRole('tab').find((tab) =>
      tab.textContent?.toLowerCase().includes('quick'),
    )!
    const exploreTab = screen.getAllByRole('tab').find((tab) =>
      tab.textContent?.toLowerCase().includes('explore'),
    )!
    await waitFor(() => {
      expect(quickTab).toBeDisabled()
      expect(quickTab).toHaveAttribute('title', 'unavailable for Kimi')
      expect(quickTab).toHaveTextContent('unavailable for Kimi')
      expect(exploreTab).toHaveAttribute('aria-selected', 'true')
    })
    expect(screen.getAllByRole('tab').find((tab) =>
      tab.textContent?.toLowerCase().includes('raw'),
    )).not.toBeDisabled()
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/tickets/generate-spec'),
      expect.anything(),
    )
  })

  it('clears Kimi-incompatible MCP/refine scopes before Explore handoff', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: 'k3',
            provider: 'kimi',
            providers: ['kimi'],
            allowed: [{ value: 'k3', label: 'Kimi K3' }],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    const onExploreLaunch = vi.fn()
    render(
      <ProposeSpecModal
        open
        onClose={onCloseMock}
        tickets={emptyTickets}
        onExploreLaunch={onExploreLaunch}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByRole('tab').find((tab) =>
        tab.textContent?.toLowerCase().includes('explore'),
      )).toHaveAttribute('aria-selected', 'true')
    })
    fireEvent.click(screen.getByTestId('context-scope-toggle'))
    const userMcp = screen.getByLabelText('My approved MCPs')
    const contractRefine = screen.getByLabelText('Enrich with Contract Layer')
    expect(userMcp).toBeDisabled()
    expect(userMcp).toHaveAttribute('aria-checked', 'false')
    expect(userMcp.parentElement).toHaveAttribute('title', 'Unavailable for Kimi')
    expect(contractRefine).toBeDisabled()
    expect(contractRefine).toHaveAttribute('aria-checked', 'false')

    // Desktop preset normally enables both booleans. The provider-aware
    // setter must retain supported project MCP scope while clearing them.
    fireEvent.click(screen.getByTestId('scope-stop-desktop'))
    const textarea = screen.getByPlaceholderText(/dark mode/i)
    fireEvent.change(textarea, { target: { value: 'Kimi explore scope' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(onExploreLaunch).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'kimi',
        contextScope: expect.objectContaining({
          mcp: true,
          userMcp: false,
          contractRefine: false,
        }),
      }))
    })
  })

  it('renames the action button to Continue in Explore mode', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const exploreTab = screen.getAllByRole('tab').find((t) => t.textContent?.toLowerCase().includes('explore'))!
    fireEvent.click(exploreTab)
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument()
  })

  it('shows Context Awareness and Fine-tune in both Quick and Explore', async () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    await waitFor(() => {
      expect(screen.getByTestId('context-scope-slider')).toBeInTheDocument()
    })
    expect(screen.getByTestId('context-scope-toggle')).toHaveTextContent(/fine-tune/i)
    expect(screen.getByTestId('scope-stop-max')).toBeInTheDocument()
    expect(screen.queryByTestId('scope-stop-desktop')).not.toBeInTheDocument()

    const exploreTab = screen.getAllByRole('tab').find((t) => t.textContent?.toLowerCase().includes('explore'))!
    fireEvent.click(exploreTab)

    expect(screen.getByTestId('context-scope-slider')).toBeInTheDocument()
    expect(screen.getByTestId('context-scope-toggle')).toHaveTextContent(/fine-tune/i)
    expect(screen.getByTestId('scope-stop-desktop')).toBeInTheDocument()
  })

  it('sends contractRefine in the Quick generate-spec body', async () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    await waitFor(() => expect(screen.getByTestId('context-scope-slider')).toBeInTheDocument())
    await waitFor(() => {
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/add-spec-quick-contract-refine-last'))).toBe(true)
    })
    fireEvent.click(screen.getByTestId('scope-stop-max'))

    const textarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    fireEvent.change(textarea, { target: { value: 'Quick contract layer' } })
    fireEvent.click(screen.getByRole('button', { name: /generate spec/i }))

    await waitFor(() => {
      const generateCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .find((c) => typeof c[0] === 'string' && c[0].includes('/tickets/generate-spec'))
      expect(generateCall).toBeTruthy()
      const body = JSON.parse((generateCall![1] as { body: string }).body)
      expect(body.contractRefine).toBe(true)
      expect(body.contextScope).toEqual(expect.objectContaining({ contractRefine: true, full: true }))
    })
  })

  it('hands off to onExploreLaunch when Continue is clicked in Explore mode', async () => {
    const onExploreLaunch = vi.fn()
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} onExploreLaunch={onExploreLaunch} />)
    const exploreTab = screen.getAllByRole('tab').find((t) => t.textContent?.toLowerCase().includes('explore'))!
    fireEvent.click(exploreTab)
    const textarea = screen.getByPlaceholderText(/dark mode/i)
    fireEvent.change(textarea, { target: { value: 'dark mode rough idea' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(onExploreLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ idea: 'dark mode rough idea' }),
      )
    })
    expect(onCloseMock).toHaveBeenCalled()
    // The Quick path's /generate-spec must NOT be invoked in Explore mode.
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/tickets/generate-spec'),
      expect.anything(),
    )
  })

  it('hands slider-derived contractRefine through to Explore launch payload', async () => {
    const onExploreLaunch = vi.fn()
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} onExploreLaunch={onExploreLaunch} />)
    const exploreTab = screen.getAllByRole('tab').find((t) => t.textContent?.toLowerCase().includes('explore'))!
    fireEvent.click(exploreTab)
    fireEvent.click(screen.getByTestId('scope-stop-max'))
    const textarea = screen.getByPlaceholderText(/dark mode/i)
    fireEvent.change(textarea, { target: { value: 'max context idea' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(onExploreLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          contextScope: expect.objectContaining({ contractRefine: true, mcp: false }),
        }),
      )
    })
  })

  it('resets state when reopened', async () => {
    const { rerender } = render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const textarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    fireEvent.change(textarea, { target: { value: 'Add dark mode' } })

    rerender(<ProposeSpecModal open={false} onClose={onCloseMock} tickets={emptyTickets} />)
    rerender(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)

    const newTextarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    expect(newTextarea).toHaveValue('')
  })

  it('submits via Cmd+Enter keyboard shortcut (Quick mode → /generate-spec)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ requestId: 'req-kbd' }),
    })
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const textarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    fireEvent.change(textarea, { target: { value: 'Keyboard test' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/tickets/generate-spec'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('uses fast mode when explore codebase is unchecked', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ model: 'sonnet', provider: 'claude', allowed: [{ value: 'sonnet', label: 'Claude Sonnet' }] }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ requestId: 'req-1' }) })
    })

    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    // Explore codebase defaults to unchecked — fast mode is the default path.
    const textarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    fireEvent.change(textarea, { target: { value: 'Fast spec' } })
    fireEvent.click(screen.getByRole('button', { name: /generate spec/i }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/tickets/generate-spec'),
        expect.objectContaining({ method: 'POST' }),
      )
    })
    // Should NOT use ChatManager in fast mode
    expect(mockStartWithMessage).not.toHaveBeenCalled()
  })

  it('sends the resolved model in the generate-spec body (Quick mode)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: 'opus',
            provider: 'claude',
            allowed: [
              { value: 'sonnet', label: 'Claude Sonnet' },
              { value: 'opus', label: 'Claude Opus' },
            ],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ requestId: 'req-model' }) })
    })

    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const textarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    fireEvent.change(textarea, { target: { value: 'idea with explicit model' } })

    // Wait for the picker to resolve before submitting so the body carries
    // the project default rather than the in-flight `null`.
    await waitFor(() => {
      expect(screen.getByText('Claude Opus')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /generate spec/i }))

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      const generateCall = calls.find((c) => typeof c[0] === 'string' && c[0].includes('/tickets/generate-spec'))
      expect(generateCall).toBeTruthy()
      const body = JSON.parse((generateCall![1] as { body: string }).body)
      expect(body.model).toBe('opus')
      expect(body.idea).toBe('idea with explicit model')
    })
  })

  it('passes the resolved model to onExploreLaunch (Explore mode)', async () => {
    const onExploreLaunch = vi.fn()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: 'haiku',
            provider: 'claude',
            allowed: [
              { value: 'sonnet', label: 'Claude Sonnet' },
              { value: 'haiku', label: 'Claude Haiku' },
            ],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} onExploreLaunch={onExploreLaunch} />)
    const exploreTab = screen.getAllByRole('tab').find((t) => t.textContent?.toLowerCase().includes('explore'))!
    fireEvent.click(exploreTab)
    const textarea = screen.getByPlaceholderText(/dark mode/i)
    fireEvent.change(textarea, { target: { value: 'rough idea' } })

    await waitFor(() => {
      expect(screen.getByText('Claude Haiku')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => {
      expect(onExploreLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ idea: 'rough idea', model: 'haiku' }),
      )
    })
  })

  it('hides scope-smash-hint for a codex project at Max and Desktop presets', async () => {
    // Override the fetch mock so the default-spec-model endpoint returns provider='codex'
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            model: 'codex-mini',
            provider: 'codex',
            allowed: [{ value: 'codex-mini', label: 'Codex Mini' }],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    await waitFor(() => expect(screen.getByTestId('context-scope-slider')).toBeInTheDocument())

    // Max preset — contractRefine=true but provider is codex → smash hint must NOT appear
    fireEvent.click(screen.getByTestId('scope-stop-max'))
    expect(screen.queryByTestId('scope-smash-hint')).not.toBeInTheDocument()

    // Switch to Explore mode — Desktop preset (also contractRefine=true) still no hint
    const exploreTab = screen.getAllByRole('tab').find((t) => t.textContent?.toLowerCase().includes('explore'))!
    fireEvent.click(exploreTab)
    await waitFor(() => expect(screen.getByTestId('scope-stop-desktop')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('scope-stop-desktop'))
    expect(screen.queryByTestId('scope-smash-hint')).not.toBeInTheDocument()
  })

  it('shows scope-smash-hint for a claude project at Max preset', async () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    await waitFor(() => expect(screen.getByTestId('context-scope-slider')).toBeInTheDocument())
    // Move to Max preset (contractRefine=true) — provider defaults to claude in beforeEach
    fireEvent.click(screen.getByTestId('scope-stop-max'))
    expect(screen.getByTestId('scope-smash-hint')).toBeInTheDocument()
  })

  it('registers fast spec with tracker when explore codebase is unchecked', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ model: 'sonnet', provider: 'claude', allowed: [{ value: 'sonnet', label: 'Claude Sonnet' }] }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ requestId: 'req-fast' }) })
    })

    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    const textarea = screen.getByPlaceholderText(/add a dark mode toggle/i)
    fireEvent.change(textarea, { target: { value: 'Fast spec' } })
    fireEvent.click(screen.getByRole('button', { name: /generate spec/i }))

    await waitFor(() => {
      expect(mockRegisterFastSpec).toHaveBeenCalledWith('req-fast', expect.objectContaining({ projectId: 'proj-1' }))
    })
  })

  // ─── Raw mode ("free") ──────────────────────────────────────────────────────

  const selectRawMode = () => {
    const rawTab = screen.getAllByRole('tab').find((t) => t.textContent?.toLowerCase().includes('raw'))!
    fireEvent.click(rawTab)
  }

  it('Raw mode hides the model/scope pickers and shows the priority group + title + Create button', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    selectRawMode()
    expect(screen.getByTestId('raw-priority-group')).toBeInTheDocument()
    expect(screen.getByTestId('raw-title-input')).toBeInTheDocument()
    expect(screen.queryByTestId('context-scope-slider')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument()
    // Submit is disabled until the body has text.
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled()
  })

  it('Raw mode auto-derives the title from the first non-empty line of the body', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    selectRawMode()
    const body = screen.getByLabelText('Raw spec body')
    fireEvent.change(body, { target: { value: 'Add a CSV export button\nin the reports page' } })
    expect((screen.getByTestId('raw-title-input') as HTMLInputElement).value).toBe('Add a CSV export button')
  })

  it('Raw mode posts to /tickets/from-prompt with description, default priority and structured=false', async () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    selectRawMode()
    const body = screen.getByLabelText('Raw spec body')
    fireEvent.change(body, { target: { value: 'Raw prompt body text' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() => {
      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .find((c) => typeof c[0] === 'string' && c[0].includes('/tickets/from-prompt'))
      expect(call).toBeTruthy()
      const payload = JSON.parse((call![1] as { body: string }).body)
      expect(payload.description).toBe('Raw prompt body text')
      expect(payload.priority).toBe('medium')
      expect(payload.structured).toBe(false)
    })
    expect(onCloseMock).toHaveBeenCalled()
    // The Quick path's /generate-spec must NOT fire in Raw mode.
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/tickets/generate-spec'),
      expect.anything(),
    )
    // Raw mode never hands off to Explore either.
    expect(mockStartWithMessage).not.toHaveBeenCalled()
  })

  it('Raw mode sends the selected priority and an explicit title override', async () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    selectRawMode()
    fireEvent.change(screen.getByLabelText('Raw spec body'), { target: { value: 'auto title here' } })
    fireEvent.change(screen.getByTestId('raw-title-input'), { target: { value: 'Explicit Title' } })
    const high = screen.getAllByRole('radio').find((r) => r.textContent?.toLowerCase() === 'high')!
    fireEvent.click(high)
    expect(high).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() => {
      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .find((c) => typeof c[0] === 'string' && c[0].includes('/tickets/from-prompt'))
      const payload = JSON.parse((call![1] as { body: string }).body)
      expect(payload.title).toBe('Explicit Title')
      expect(payload.priority).toBe('high')
    })
  })

  it('Raw mode adds a label via Enter and includes it in the payload', async () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    selectRawMode()
    fireEvent.change(screen.getByLabelText('Raw spec body'), { target: { value: 'body text' } })
    const labelInput = screen.getByTestId('raw-label-input')
    fireEvent.change(labelInput, { target: { value: 'urgent' } })
    fireEvent.keyDown(labelInput, { key: 'Enter' })
    expect(screen.getByText('urgent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() => {
      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .find((c) => typeof c[0] === 'string' && c[0].includes('/tickets/from-prompt'))
      const payload = JSON.parse((call![1] as { body: string }).body)
      expect(payload.labels).toEqual(['urgent'])
    })
  })

  it('Raw priority pills support arrow-key navigation', () => {
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    selectRawMode()
    const group = screen.getByTestId('raw-priority-group')
    const medium = screen.getAllByRole('radio').find((r) => r.textContent?.toLowerCase() === 'medium')!
    expect(medium).toHaveAttribute('aria-checked', 'true')
    // ArrowLeft from medium → high
    fireEvent.keyDown(medium, { key: 'ArrowLeft' })
    const high = screen.getAllByRole('radio').find((r) => r.textContent?.toLowerCase() === 'high')!
    expect(high).toHaveAttribute('aria-checked', 'true')
    expect(group).toBeInTheDocument()
  })

  it('shows a Raw error toast and does not close when from-prompt fails', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/default-spec-model')) {
        return Promise.resolve({ ok: true, json: async () => ({ model: 'sonnet', provider: 'claude', allowed: [{ value: 'sonnet', label: 'Claude Sonnet' }] }) })
      }
      if (typeof url === 'string' && url.includes('/tickets/from-prompt')) {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'boom' }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    render(<ProposeSpecModal open={true} onClose={onCloseMock} tickets={emptyTickets} />)
    selectRawMode()
    fireEvent.change(screen.getByLabelText('Raw spec body'), { target: { value: 'will fail' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() => {
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('/tickets/from-prompt'),
      )).toBe(true)
    })
    expect(onCloseMock).not.toHaveBeenCalled()
  })
})
