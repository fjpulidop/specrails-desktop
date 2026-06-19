import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { render } from '../../test-utils'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))

let mockRegisterHandler: ReturnType<typeof vi.fn>
let mockUnregisterHandler: ReturnType<typeof vi.fn>

vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: mockRegisterHandler,
    unregisterHandler: mockUnregisterHandler,
    connectionStatus: 'connected',
  }),
}))

import { SetupWizard } from '../SetupWizard'
import type { DesktopProject } from '../../hooks/useDesktop'

// Use a counter to ensure unique project IDs — avoids wizardCache cross-test contamination
let projectIdCounter = 0
function makeProject(overrides: Partial<DesktopProject> = {}): DesktopProject {
  const id = `proj-setup-${++projectIdCounter}`
  return {
    id,
    slug: 'my-project',
    name: 'My Project',
    path: '/home/user/my-project',
    db_path: `/home/.specrails/projects/${id}/jobs.sqlite`,
    added_at: '2024-01-01T00:00:00.000Z',
    last_seen_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRegisterHandler = vi.fn()
    mockUnregisterHandler = vi.fn()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
  })

  describe('Agent-selection step (initial)', () => {
    it('renders agent-selection step by default', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      expect(screen.getByText(/configure .*agents/i)).toBeInTheDocument()
    })

    it('shows wizard step indicator labels (Configure / Install / Done — no Enrich, no tier)', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      expect(screen.getByText('Configure')).toBeInTheDocument()
      // "Install" appears as both the step label and the CTA button — assert at least once.
      expect(screen.getAllByText('Install').length).toBeGreaterThanOrEqual(1)
      expect(screen.queryByText('Enrich')).not.toBeInTheDocument()
      expect(screen.getByText('Done')).toBeInTheDocument()
    })

    it('renders Skip for now button', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument()
    })

    it('calls onSkip when Skip is clicked', () => {
      const onSkip = vi.fn()
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={onSkip} />)
      fireEvent.click(screen.getByRole('button', { name: /skip for now/i }))
      expect(onSkip).toHaveBeenCalled()
    })

    it('does NOT render tier-selection chrome (Quick / Full / Coming soon)', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      expect(screen.queryByText('Quick Setup')).not.toBeInTheDocument()
      expect(screen.queryByText('Full Setup')).not.toBeInTheDocument()
      expect(screen.queryByText('Quick Install')).not.toBeInTheDocument()
      expect(screen.queryByText('Install & Enrich')).not.toBeInTheDocument()
    })

    it('renders a single Install CTA inside the centered wrapper', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      const wrapper = screen.getByTestId('install-cta-wrapper')
      expect(wrapper).toHaveClass('mx-auto')
      expect(wrapper).toContainElement(screen.getByRole('button', { name: /^install$/i }))
    })

    it('keeps "Skip for now" left-anchored in the footer', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      const skip = screen.getByText('Skip for now')
      expect(skip.className).toContain('absolute')
      expect(skip.className).toContain('left-')
      const wrapper = screen.getByTestId('install-cta-wrapper')
      expect(skip.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  describe('Transition to installing step', () => {
    it('transitions to installing step when Install button is clicked', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => {
        expect(screen.getByText(/installing specrails/i)).toBeInTheDocument()
      })
    })

    it('calls POST /setup/install when Install is clicked', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          `/api/projects/${project.id}/setup/install`,
          expect.objectContaining({ method: 'POST' })
        )
      })
    })

    it('sends tier:"quick" in the install-config payload (server-facing legacy field)', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => {
        const cfgCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).endsWith('/setup/install-config'),
        )
        expect(cfgCall).toBeTruthy()
        const body = JSON.parse((cfgCall![1] as { body: string }).body)
        expect(body.tier).toBe('quick')
      })
    })

    it('shows "Waiting for output..." when no log lines yet', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => {
        expect(screen.getByText(/waiting for output/i)).toBeInTheDocument()
      })
    })
  })

  describe('WebSocket registration', () => {
    it('registers WebSocket handler on mount', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      expect(mockRegisterHandler).toHaveBeenCalledWith(
        `setup-${project.id}`,
        expect.any(Function)
      )
    })

    it('unregisters WebSocket handler on unmount', () => {
      const project = makeProject()
      const { unmount } = render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      unmount()
      expect(mockUnregisterHandler).toHaveBeenCalledWith(`setup-${project.id}`)
    })
  })

  describe('WebSocket message handling', () => {
    function getWsHandler() {
      return mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void
    }

    it('appends log lines on setup_log message', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())

      const handler = getWsHandler()
      act(() => {
        handler({ type: 'setup_log', projectId: project.id, line: 'Installing packages...' })
      })

      await waitFor(() => {
        expect(screen.getByText('Installing packages...')).toBeInTheDocument()
      })
    })

    it('ignores messages from different projectId', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())

      const handler = getWsHandler()
      act(() => {
        handler({ type: 'setup_log', projectId: 'OTHER-PROJECT', line: 'Should not appear' })
      })

      expect(screen.queryByText('Should not appear')).toBeNull()
    })

    it('transitions to complete on setup_install_done', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())

      const handler = getWsHandler()
      act(() => {
        handler({
          type: 'setup_install_done',
          projectId: project.id,
          summary: { agents: 4, specrailsCommands: 8, opsxCommands: 3, legacySrRemoved: 0 },
        })
      })

      await waitFor(() => {
        expect(screen.getByText(/welcome to/i)).toBeInTheDocument()
      })
    })

    it('offers an optional Jira step on the complete screen and "do it later" continues to the project', async () => {
      const project = makeProject()
      const onComplete = vi.fn()
      render(<SetupWizard project={project} onComplete={onComplete} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())
      act(() => {
        getWsHandler()({
          type: 'setup_install_done',
          projectId: project.id,
          summary: { agents: 4, specrailsCommands: 8, opsxCommands: 3, legacySrRemoved: 0 },
        })
      })
      await waitFor(() => expect(screen.getByTestId('setup-jira-cta')).toBeInTheDocument())

      // Opt into the Jira sub-screen, then bail with "do it later" → go to project.
      fireEvent.click(screen.getByRole('button', { name: /configure jira/i }))
      await waitFor(() => expect(screen.getByTestId('jira-wizard')).toBeInTheDocument())
      fireEvent.click(screen.getByTestId('jira-later'))
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('shows error step on setup_error message', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())

      const handler = getWsHandler()
      act(() => {
        handler({ type: 'setup_error', projectId: project.id, error: 'npx failed' })
      })

      await waitFor(() => {
        expect(screen.getByText('Setup failed')).toBeInTheDocument()
        expect(screen.getByText('npx failed')).toBeInTheDocument()
      })
    })
  })

  describe('Error step', () => {
    async function renderErrorStep() {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())
      const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void
      act(() => {
        handler({ type: 'setup_error', projectId: project.id, error: 'Connection timed out' })
      })
      await waitFor(() => expect(screen.getByText('Setup failed')).toBeInTheDocument())
      return { handler, project }
    }

    it('renders Retry and Skip setup buttons', async () => {
      await renderErrorStep()
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /skip setup/i })).toBeInTheDocument()
    })

    it('shows error message in error step', async () => {
      await renderErrorStep()
      expect(screen.getByText('Connection timed out')).toBeInTheDocument()
    })

    it('goes back to installing when Retry is clicked', async () => {
      await renderErrorStep()
      fireEvent.click(screen.getByRole('button', { name: /retry/i }))
      await waitFor(() => {
        expect(screen.queryByText('Setup failed')).toBeNull()
      })
    })
  })

  describe('Back navigation', () => {
    it('agent-selection step does not show a Back button', () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument()
    })

    it('installing step shows a Back button', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument()
      })
    })

    it('Back button in installing step returns to agent-selection', async () => {
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
      await waitFor(() => {
        expect(screen.getByText(/configure .*agents/i)).toBeInTheDocument()
      })
    })
  })

  describe('Complete step', () => {
    async function renderCompleteStep(summaryOverride: Partial<{
      agents: number
      specrailsCommands: number
      opsxCommands: number
      legacySrRemoved: number
      failed: boolean
      provider: string
    }> = {}) {
      const summary = {
        agents: 4,
        specrailsCommands: 8,
        opsxCommands: 3,
        legacySrRemoved: 0,
        ...summaryOverride,
      }
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())
      const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void
      act(() => {
        handler({ type: 'setup_install_done', projectId: project.id, summary })
      })
      await waitFor(() => expect(screen.getByText(/welcome to/i)).toBeInTheDocument())
      return { handler, project }
    }

    it('shows a per-provider success card instead of detail counts', async () => {
      await renderCompleteStep({ agents: 7, specrailsCommands: 12, opsxCommands: 5 })
      const card = screen.getByTestId('setup-summary-card')
      expect(card).toHaveAttribute('data-status', 'installed')
      expect(within(card).getByText('Claude')).toBeInTheDocument()
      expect(within(card).getByText('Installed')).toBeInTheDocument()
      // The misleading per-engine detail counts are gone.
      expect(screen.queryByText('7')).not.toBeInTheDocument()
      expect(screen.queryByText('12')).not.toBeInTheDocument()
      expect(screen.queryByText('/specrails:*')).not.toBeInTheDocument()
      expect(screen.queryByText('/opsx:*')).not.toBeInTheDocument()
    })

    it('never shows Personas / Spec tile labels', async () => {
      await renderCompleteStep()
      expect(screen.queryByText('Personas')).not.toBeInTheDocument()
      expect(screen.queryByText('Spec')).not.toBeInTheDocument()
    })

    it('renders an error variant when a provider summary is flagged failed', async () => {
      await renderCompleteStep({ failed: true })
      const card = screen.getByTestId('setup-summary-card')
      expect(card).toHaveAttribute('data-status', 'failed')
      expect(within(card).getByText('Install failed')).toBeInTheDocument()
    })

    it('renders Continue to project button', async () => {
      await renderCompleteStep()
      expect(screen.getByRole('button', { name: /continue to project/i })).toBeInTheDocument()
    })

    it('calls onComplete when Continue is clicked', async () => {
      const onComplete = vi.fn()
      const project = makeProject()
      render(<SetupWizard project={project} onComplete={onComplete} onSkip={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing specrails/i)).toBeInTheDocument())
      const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void
      act(() => {
        handler({
          type: 'setup_install_done',
          projectId: project.id,
          summary: { agents: 1, specrailsCommands: 5, opsxCommands: 2, legacySrRemoved: 0 },
        })
      })
      await waitFor(() => expect(screen.getByRole('button', { name: /continue to project/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /continue to project/i }))
      expect(onComplete).toHaveBeenCalled()
    })

    it('shows project name in complete step', async () => {
      await renderCompleteStep()
      expect(screen.getAllByText('My Project').length).toBeGreaterThanOrEqual(1)
    })

    it('renders specrails docs link', async () => {
      await renderCompleteStep()
      const docsLink = document.querySelector('a[href="https://specrails.dev/docs"]')
      expect(docsLink).toBeTruthy()
    })

    it('no longer renders the legacy cleanup notice (detail counts removed)', async () => {
      await renderCompleteStep({ legacySrRemoved: 2 })
      expect(screen.queryByText(/removed 2 legacy/i)).not.toBeInTheDocument()
    })
  })

  // ─── Multi-provider (4-step) flow ─────────────────────────────────────────────
  describe('Multi-provider flow', () => {
    function makeMultiProject() {
      return makeProject({ provider: 'claude', providers: ['claude', 'codex'] })
    }

    it('shows a Configure step per provider and a Next CTA on the first', () => {
      render(<SetupWizard project={makeMultiProject()} onComplete={vi.fn()} onSkip={vi.fn()} />)
      // Header reflects the first provider being configured.
      expect(screen.getByText(/configure claude agents/i)).toBeInTheDocument()
      // Step indicator shows both provider labels + Install + Done.
      expect(screen.getByText('Claude')).toBeInTheDocument()
      expect(screen.getByText('Codex')).toBeInTheDocument()
      // First provider's CTA advances to the next provider rather than installing.
      expect(screen.getByRole('button', { name: /next: codex/i })).toBeInTheDocument()
    })

    it('advances to the second provider then installs both sequentially', async () => {
      const project = makeMultiProject()
      render(<SetupWizard project={project} onComplete={vi.fn()} onSkip={vi.fn()} />)

      // Step 1 → Step 2 (configure Codex)
      fireEvent.click(screen.getByRole('button', { name: /next: codex/i }))
      await waitFor(() => expect(screen.getByText(/configure codex agents/i)).toBeInTheDocument())

      // Step 2 → Install (the last provider's CTA reads "Install")
      fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
      await waitFor(() => expect(screen.getByText(/installing claude/i)).toBeInTheDocument())

      const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void

      // First provider finishes → wizard kicks off the second provider's install.
      act(() => {
        handler({ type: 'setup_install_done', projectId: project.id, summary: { agents: 4, specrailsCommands: 8, opsxCommands: 3, legacySrRemoved: 0, tier: 'quick', provider: 'claude' } })
      })
      await waitFor(() => expect(screen.getByText(/installing codex/i)).toBeInTheDocument())

      // Second provider finishes → complete screen with BOTH summaries.
      act(() => {
        handler({ type: 'setup_install_done', projectId: project.id, summary: { agents: 5, specrailsCommands: 9, opsxCommands: 2, legacySrRemoved: 0, tier: 'quick', provider: 'codex' } })
      })
      await waitFor(() => expect(screen.getByText(/welcome to/i)).toBeInTheDocument())
      expect(screen.getByText(/installed for 2 engines/i)).toBeInTheDocument()
      // Per-provider success cards present (name + "Installed", no detail counts).
      const cards = screen.getAllByTestId('setup-summary-card')
      expect(cards).toHaveLength(2)
      expect(within(cards[0]).getByText('Claude')).toBeInTheDocument()
      expect(within(cards[1]).getByText('Codex')).toBeInTheDocument()
      cards.forEach((c) => expect(within(c).getByText('Installed')).toBeInTheDocument())
    })
  })
})
