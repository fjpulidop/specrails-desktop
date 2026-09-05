import React from 'react'
import { premiumDescription, premiumCriteria } from '../../lib/__tests__/premium-spec-fixture'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { AddProjectDialog } from '../AddProjectDialog'
import { BlueprintPanel } from '../project-builder/BlueprintPanel'
import { BlueprintCommitForm } from '../project-builder/BlueprintCommitForm'
import { BuilderConversation } from '../project-builder/BuilderConversation'
import { BlueprintReadiness } from '../project-builder/BlueprintReadiness'
import { BuilderRecentBlueprints } from '../project-builder/BuilderRecentBlueprints'
import { BuilderGenerationProgress } from '../project-builder/BuilderGenerationProgress'
import { __resetPrerequisitesCacheForTest } from '../../hooks/usePrerequisites'
import { SharedWebSocketContext } from '../../hooks/useSharedWebSocket'
import type { Blueprint } from '../../lib/blueprint-draft'
import type { BuilderSession } from '../../hooks/useBuilderSession'

// Mutable agent-chat mock: each BuilderConversation test swaps builderMode in.
const mockAgentChat: { builderMode: { active: boolean; enter: () => void; exit: () => void; session: BuilderSession } } = {
  builderMode: { active: false, enter: vi.fn(), exit: vi.fn(), session: {} as BuilderSession },
}
vi.mock('../../context/AgentChatContext', () => ({
  useAgentChat: () => mockAgentChat,
}))

vi.mock('sonner', () => ({
  toast: { promise: vi.fn(), error: vi.fn(), success: vi.fn() },
}))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    startSetupWizard: vi.fn(),
    setActiveProjectId: vi.fn(),
    projects: [],
    activeProjectId: null,
    isLoading: false,
    addProject: vi.fn(),
    removeProject: vi.fn(),
    setupProjectIds: new Set(),
    completeSetupWizard: vi.fn(),
  }),
}))

function blueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'Recipes from your pantry', audience: 'cooks' },
    coreFlow: 'photo → recipes',
    platform: 'web',
    stack: { language: 'TypeScript', framework: 'Next.js', db: 'SQLite' },
    assumptions: ['no auth in M1'],
    milestones: [
      { id: 'm1', title: 'Walking skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] },
      { id: 'm2', title: 'Accounts', goal: 'auth', status: 'planned', plannedSpecs: ['login'] },
    ],
    specsComplete: true,
    m1Specs: [
      {
        kind: 'scaffold',
        title: 'Scaffold',
        shortSummary: 'Initialize a runnable, tested application foundation for the first product slice.',
        description: premiumDescription({ readme: true, subject: 'the project foundation' }),
        acceptanceCriteria: premiumCriteria('foundation'),
        priority: 'critical',
        labels: ['M1', 'foundation'],
      },
      {
        kind: 'feature',
        title: 'Upload',
        shortSummary: 'Let cooks upload a pantry photo for recipe suggestions.',
        description: premiumDescription({ subject: 'photo upload' }),
        acceptanceCriteria: premiumCriteria('upload'),
        priority: 'high',
        labels: ['M1'],
        dependsOnIndex: 0,
      },
    ],
    ...overrides,
  }
}

function mockFetchRoutes(routes: Record<string, unknown> = {}) {
  global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) return { ok: true, status: 200, json: async () => body }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

const wsValue = {
  registerHandler: vi.fn(),
  unregisterHandler: vi.fn(),
  connectionStatus: 'connected' as const,
}

function withWs(node: React.ReactElement) {
  return <SharedWebSocketContext.Provider value={wsValue}>{node}</SharedWebSocketContext.Provider>
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetPrerequisitesCacheForTest()
  mockFetchRoutes({
    '/api/available-providers': { claude: true, codex: false },
    '/api/setup-prerequisites': { ok: true, platform: 'darwin', prerequisites: [], missingRequired: [] },
    '/api/blueprint/conversations': { conversation: { id: 'conv-1' } },
  })
})

describe('AddProjectDialog chooser', () => {
  it('shows the Existing|New pre-screen when onOpenBuilder is wired', () => {
    render(<AddProjectDialog open onClose={vi.fn()} onOpenBuilder={vi.fn()} />)
    expect(screen.getByTestId('chooser-existing')).toBeInTheDocument()
    expect(screen.getByTestId('chooser-new')).toBeInTheDocument()
    // The existing-path form is NOT rendered on the pre-screen
    expect(screen.queryByPlaceholderText('/Users/me/my-project')).not.toBeInTheDocument()
  })

  it('Existing card continues into the byte-identical existing flow', async () => {
    const user = userEvent.setup()
    render(<AddProjectDialog open onClose={vi.fn()} onOpenBuilder={vi.fn()} />)
    await user.click(screen.getByTestId('chooser-existing'))
    expect(screen.getByPlaceholderText('/Users/me/my-project')).toBeInTheDocument()
  })

  it('New card closes the dialog and opens the Builder', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onOpenBuilder = vi.fn()
    render(<AddProjectDialog open onClose={onClose} onOpenBuilder={onOpenBuilder} />)
    await user.click(screen.getByTestId('chooser-new'))
    expect(onClose).toHaveBeenCalled()
    expect(onOpenBuilder).toHaveBeenCalled()
  })

  it('no chooser without onOpenBuilder (legacy path byte-identical)', () => {
    render(<AddProjectDialog open onClose={vi.fn()} />)
    expect(screen.queryByTestId('chooser-existing')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('/Users/me/my-project')).toBeInTheDocument()
  })
})

describe('BlueprintPanel', () => {
  it('renders all-pending dimensions with no blueprint', () => {
    render(<BlueprintPanel blueprint={null} />)
    expect(screen.getByTestId('blueprint-panel')).toBeInTheDocument()
    expect(screen.getByText('The blueprint fills in as you talk.')).toBeInTheDocument()
  })

  it('renders filled dimensions, spec cards, assumptions and later milestones', () => {
    render(<BlueprintPanel blueprint={blueprint()} />)
    expect(screen.getByTestId('dimension-product')).toHaveTextContent('Recipely')
    expect(screen.getByTestId('m1-spec-card-0')).toHaveTextContent('Scaffold')
    expect(screen.getByTestId('m1-spec-summary-0')).toHaveTextContent('Initialize a runnable, tested application foundation')
    expect(screen.getByTestId('m1-spec-priority-0')).toHaveTextContent('Critical')
    expect(screen.getByTestId('m1-spec-criteria-count-0')).toHaveTextContent('6 acceptance criteria')
    expect(screen.getByTestId('m1-spec-card-1')).toHaveTextContent('builds on #1')
    expect(screen.getByText('no auth in M1')).toBeInTheDocument()
    expect(screen.getByText('Accounts')).toBeInTheDocument()
  })

  it('clicking a spec card opens the detail modal; close dismisses it', async () => {
    const user = userEvent.setup()
    const bp = blueprint()
    bp.m1Specs[0] = {
      kind: 'scaffold',
      title: 'Scaffold',
      shortSummary: 'Create the verified foundation used by every later product capability.',
      description: premiumDescription({ readme: true, subject: 'the project foundation' }),
      acceptanceCriteria: premiumCriteria('foundation'),
      priority: 'critical',
      labels: ['M1', 'foundation'],
    }
    render(<BlueprintPanel blueprint={bp} milestoneLabel="M2" />)
    expect(screen.queryByTestId('blueprint-spec-modal')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('m1-spec-card-0'))
    const modal = screen.getByTestId('blueprint-spec-modal')
    expect(modal).toBeInTheDocument()
    expect(modal).toHaveTextContent('M2 · Spec 1')
    expect(screen.getByTestId('blueprint-spec-summary')).toHaveTextContent('Create the verified foundation')
    expect(screen.getByTestId('blueprint-spec-priority')).toHaveTextContent('Critical')
    // The final ticket preview includes every canonical description section.
    expect(modal).toHaveTextContent('Problem Statement')
    expect(modal).toHaveTextContent('Proposed Solution')
    expect(modal).toHaveTextContent('Out of Scope')
    expect(modal).toHaveTextContent('Technical Considerations')
    expect(modal).toHaveTextContent('Estimated Complexity')
    // Structured criteria are shown in full, not collapsed into a count.
    expect(screen.getAllByTestId(/^blueprint-spec-criterion-/)).toHaveLength(6)
    expect(modal).toHaveTextContent('When the persistence layer is unavailable (foundation)')
    expect(modal).toHaveTextContent('end-to-end tests cover the happy path')
    await user.click(screen.getByTestId('blueprint-spec-modal-close'))
    expect(screen.queryByTestId('blueprint-spec-modal')).not.toBeInTheDocument()
  })
})

describe('BlueprintCommitForm', () => {
  it('prefills name and derives the default location slug', async () => {
    render(
      <BlueprintCommitForm blueprint={blueprint()} onSubmit={vi.fn()} onBack={vi.fn()} submitting={false} error={null} />,
    )
    expect(screen.getByTestId('commit-name')).toHaveValue('Recipely')
    expect(screen.getByTestId('commit-location')).toHaveValue('~/projects/recipely')
  })

  it('hides the GitHub checkbox entirely when gh is not installed', async () => {
    render(
      <BlueprintCommitForm blueprint={blueprint()} onSubmit={vi.fn()} onBack={vi.fn()} submitting={false} error={null} />,
    )
    await waitFor(() => expect(screen.getByTestId('commit-provider-claude')).toBeInTheDocument())
    expect(screen.queryByTestId('commit-github')).not.toBeInTheDocument()
  })

  it('shows the checkbox disabled with an auth hint when gh is installed but not signed in', async () => {
    mockFetchRoutes({
      '/api/available-providers': { claude: true, codex: false },
      '/api/setup-prerequisites': {
        ok: true,
        platform: 'darwin',
        prerequisites: [{ key: 'gh', installed: true, executable: true, authenticated: false }],
        missingRequired: [],
      },
    })
    render(
      <BlueprintCommitForm blueprint={blueprint()} onSubmit={vi.fn()} onBack={vi.fn()} submitting={false} error={null} />,
    )
    await waitFor(() => expect(screen.getByTestId('commit-github')).toBeInTheDocument())
    expect(screen.getByTestId('commit-github')).toBeDisabled()
    expect(screen.getByText(/gh auth login/)).toBeInTheDocument()
  })

  it('enables the checkbox when gh is installed and authenticated', async () => {
    mockFetchRoutes({
      '/api/available-providers': { claude: true, codex: false },
      '/api/setup-prerequisites': {
        ok: true,
        platform: 'darwin',
        prerequisites: [{ key: 'gh', installed: true, executable: true, authenticated: true }],
        missingRequired: [],
      },
    })
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <BlueprintCommitForm blueprint={blueprint()} onSubmit={onSubmit} onBack={vi.fn()} submitting={false} error={null} />,
    )
    await waitFor(() => expect(screen.getByTestId('commit-github')).toBeInTheDocument())
    expect(screen.getByTestId('commit-github')).toBeEnabled()
    await user.click(screen.getByTestId('commit-github'))
    await user.click(screen.getByTestId('commit-submit'))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ createGithubRepo: true }))
  })

  it('submits the trimmed values', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <BlueprintCommitForm blueprint={blueprint()} onSubmit={onSubmit} onBack={vi.fn()} submitting={false} error={null} />,
    )
    await waitFor(() => expect(screen.getByTestId('commit-provider-claude')).toBeInTheDocument())
    await user.click(screen.getByTestId('commit-submit'))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Recipely', location: '~/projects/recipely', createGithubRepo: false }),
    )
  })

  it('renders a named validation error', () => {
    render(
      <BlueprintCommitForm blueprint={blueprint()} onSubmit={vi.fn()} onBack={vi.fn()} submitting={false} error="location_not_empty" />,
    )
    expect(screen.getByTestId('commit-error')).toHaveTextContent(/not empty/)
  })
})

describe('BuilderConversation (panel-hosted phases)', () => {
  function session(overrides: Partial<BuilderSession> = {}): BuilderSession {
    return {
      phase: 'chat', messages: [], streamBuffer: null, blueprint: null, busy: false,
      commitError: null, commitSteps: [], createdProjectId: null, launching: false, launched: false, submitting: false,
      conversationReady: true, conversationId: 'conv-1', dirty: false, canProposeCommit: false, specQualityDetail: null, showSurpriseMe: true,
      readiness: { ready: false, steps: [
        { key: 'blueprint', state: 'pending', params: { filled: 0, total: 5 } },
        { key: 'specs', state: 'pending', params: { count: 0, min: 5, max: 10 } },
        { key: 'audit', state: 'pending', params: { count: 0 } },
      ], issues: [] },
      snapshot: { status: 'idle' }, generation: { generating: false, specsStarted: 0 },
      recent: [], recentLoading: false, resume: vi.fn(async () => {}), discardRecent: vi.fn(async () => {}), repairSnapshot: vi.fn(async () => {}),
      provider: 'claude', model: null, models: [{ value: 'sonnet', label: 'Claude Sonnet' }],
      efforts: ['low', 'medium', 'high'], effort: 'medium', draft: '', setDraft: vi.fn(), setEffort: vi.fn(),
      setProvider: vi.fn(), setModel: vi.fn(),
      send: vi.fn(), surpriseMe: vi.fn(), approveBlueprint: vi.fn(), goToCommit: vi.fn(), backToChat: vi.fn(),
      submitCommit: vi.fn(), launchM1: vi.fn(async () => {}), openProject: vi.fn(), abortAndReset: vi.fn(),
      ...overrides,
    }
  }

  function ConversationHarness({
    base,
    exit,
    variant = 'floating',
  }: {
    base: BuilderSession
    exit: () => void
    variant?: 'floating' | 'inline'
  }) {
    const [draft, setDraftState] = React.useState(base.draft)
    const liveSession: BuilderSession = {
      ...base,
      draft,
      setDraft: (next) => {
        base.setDraft(next)
        setDraftState(next)
      },
    }
    mockAgentChat.builderMode = { active: true, enter: vi.fn(), exit, session: liveSession }
    return <BuilderConversation variant={variant} />
  }

  function renderWithMode(s: BuilderSession, exit = vi.fn(), variant: 'floating' | 'inline' = 'floating') {
    render(withWs(<ConversationHarness base={s} exit={exit} variant={variant} />))
    return exit
  }

  it('chat phase renders the mission-style composer with halo, selectors and surprise-me', () => {
    const s = session()
    renderWithMode(s)
    expect(screen.getByTestId('builder-conversation')).toBeInTheDocument()
    expect(screen.getByTestId('surprise-me')).toBeInTheDocument()
    expect(screen.getByTestId('builder-input')).toBeInTheDocument()
    // Coherence with the mission composer: provider + model selectors present,
    // halo mounted on the composer card itself.
    expect(screen.getByTestId('builder-provider-selector')).toBeInTheDocument()
    expect(screen.getByTestId('builder-model-selector')).toBeInTheDocument()
    expect(screen.getByTestId('builder-effort-selector')).toBeInTheDocument()
    expect(screen.getByTestId('builder-halo')).toBeInTheDocument()
    expect(screen.getByTestId('builder-input')).toHaveClass('resize-y')
    expect(screen.getByTestId('builder-send').querySelector('svg')).toHaveClass('lucide-send-horizontal')
  })

  it('blocks a legacy Kimi Builder session and explains the unavailable boundary', () => {
    const s = session({
      provider: 'kimi',
      model: 'k3',
      models: [{ value: 'k3', label: 'Kimi K3' }],
      efforts: [],
      draft: 'do not send',
    })
    renderWithMode(s)
    expect(screen.getByTestId('builder-provider-unavailable')).toHaveTextContent(/no-tools or read-only/i)
    expect(screen.getByTestId('builder-input')).toBeDisabled()
    expect(screen.getByTestId('builder-send')).toBeDisabled()
    expect(s.send).not.toHaveBeenCalled()
  })

  it('selecting an effort delegates to the builder session', async () => {
    const user = userEvent.setup()
    const s = session()
    renderWithMode(s)
    await user.click(screen.getByTestId('builder-effort-selector'))
    await user.click(screen.getByRole('option', { name: /high/i }))
    expect(s.setEffort).toHaveBeenCalledWith('high')
  })

  it('sending forwards to the session', async () => {
    const user = userEvent.setup()
    const s = session()
    renderWithMode(s)
    await user.type(screen.getByTestId('builder-input'), 'a recipes app')
    await user.click(screen.getByTestId('builder-send'))
    expect(s.send).toHaveBeenCalledWith('a recipes app')
    expect(s.setDraft).toHaveBeenLastCalledWith('')
  })

  it('Enter sends, while Shift+Enter keeps composing', async () => {
    const user = userEvent.setup()
    const s = session()
    renderWithMode(s)
    const input = screen.getByTestId('builder-input')
    await user.type(input, 'first line')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(s.send).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(s.send).toHaveBeenCalledOnce()
    expect(s.send).toHaveBeenCalledWith(expect.stringContaining('first line'))
  })

  it('does not erase the draft when a keyboard send is blocked', async () => {
    const user = userEvent.setup()
    const s = session({ busy: true, draft: 'keep this draft' })
    renderWithMode(s)
    const input = screen.getByTestId('builder-input')
    input.focus()
    await user.keyboard('{Enter}')
    expect(s.send).not.toHaveBeenCalled()
    expect(input).toHaveValue('keep this draft')
    expect(s.setDraft).not.toHaveBeenCalled()
  })

  it('removes the entry halo once the first work message exists', () => {
    renderWithMode(session({
      messages: [{ role: 'user', content: 'build a recipes app', createdAt: '2026-07-16T08:00:00.000Z' }],
      busy: true,
      showSurpriseMe: false,
    }))
    expect(screen.queryByTestId('builder-halo')).not.toBeInTheDocument()
    expect(screen.getByTestId('builder-composer-card')).toHaveAttribute('data-composer-position', 'docked')
  })

  it('shares the inline composer layout id from hero to docked state', () => {
    const exit = vi.fn()
    const empty = session()
    const view = render(withWs(<ConversationHarness base={empty} exit={exit} variant="inline" />))
    expect(screen.getByTestId('builder-composer-card')).toHaveAttribute('data-composer-position', 'hero')
    expect(screen.getByTestId('builder-composer-card')).toHaveAttribute('data-layout-id', 'builder-composer-dock')

    const active = session({
      messages: [{ role: 'user', content: 'start', createdAt: '2026-07-16T08:00:00.000Z' }],
      busy: true,
      showSurpriseMe: false,
    })
    view.rerender(withWs(<ConversationHarness base={active} exit={exit} variant="inline" />))
    expect(screen.getByTestId('builder-composer-card')).toHaveAttribute('data-composer-position', 'docked')
    expect(screen.getByTestId('builder-composer-card')).toHaveAttribute('data-layout-id', 'builder-composer-dock')
    expect(screen.queryByTestId('builder-halo')).not.toBeInTheDocument()
  })

  it('commit phase renders the mini-form in the conversation slot', () => {
    renderWithMode(session({ phase: 'commit', blueprint: blueprint() }))
    expect(screen.getByTestId('commit-form')).toBeInTheDocument()
  })

  it('locks the commit form and ignores Escape while the commit request is pending', async () => {
    const user = userEvent.setup()
    const s = session({ phase: 'commit', blueprint: blueprint(), submitting: true })
    renderWithMode(s)
    expect(screen.getByTestId('commit-submit')).toBeDisabled()
    screen.getByTestId('commit-name').focus()
    await user.keyboard('{Escape}')
    expect(s.backToChat).not.toHaveBeenCalled()
  })

  it('progress phase renders the step list', () => {
    renderWithMode(session({
      phase: 'progress',
      commitSteps: [{ step: 'git-init', status: 'running' }],
    }))
    expect(screen.getByTestId('commit-progress')).toBeInTheDocument()
  })

  it('github warning step renders the classified i18n message, raw stderr as tooltip', () => {
    renderWithMode(session({
      phase: 'progress',
      commitSteps: [
        { step: 'register', status: 'done' },
        { step: 'github', status: 'warning', detail: 'GraphQL: Name already exists on this account', code: 'gh_repo_exists' },
      ],
    }))
    const row = screen.getByText(/already exists on your account/)
    expect(row).toBeInTheDocument()
    expect(row).toHaveAttribute('title', 'GraphQL: Name already exists on this account')
  })

  it('github warning with an unknown code falls back to the generic message', () => {
    renderWithMode(session({
      phase: 'progress',
      commitSteps: [{ step: 'github', status: 'warning', detail: 'boom', code: 'gh_weird' }],
    }))
    expect(screen.getByText(/GitHub repository creation failed/)).toBeInTheDocument()
  })

  it('done phase offers Launch M1 and Open project', async () => {
    const user = userEvent.setup()
    const s = session({ phase: 'done', createdProjectId: 'proj-9' })
    renderWithMode(s)
    // Wave checkpoints: the done screen carries the stored auto-continue preference (default OFF).
    expect(screen.getByTestId('done-auto-advance')).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByTestId('done-auto-advance'))
    expect(screen.getByTestId('done-auto-advance')).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem('specrails-desktop:milestone-auto-advance')).toBe('true')
    await user.click(screen.getByTestId('launch-m1'))
    expect(s.launchM1).toHaveBeenCalled()
    await user.click(screen.getByTestId('open-project'))
    expect(s.openProject).toHaveBeenCalled()
  })

  it('clean Esc exit is silent (no confirm)', async () => {
    const user = userEvent.setup()
    const exitClean = renderWithMode(session({ dirty: false }))
    screen.getByTestId('builder-input').focus()
    await user.keyboard('{Escape}')
    expect(exitClean).toHaveBeenCalled()
  })

  it('dirty Esc exit shows the confirmation and only exits on discard', async () => {
    const user = userEvent.setup()
    const exit = renderWithMode(session({ dirty: true }))
    screen.getByTestId('builder-input').focus()
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('builder-exit-confirm')).toBeInTheDocument()
    expect(exit).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('builder-exit-cancel'))
    expect(screen.queryByTestId('builder-exit-confirm')).not.toBeInTheDocument()
    screen.getByTestId('builder-input').focus()
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('builder-exit-confirm-btn'))
    expect(exit).toHaveBeenCalled()
  })
})

// ─── harden-project-builder-snapshots: readiness, resume list, generation progress

describe('BlueprintReadiness', () => {
  const readyReport = {
    ready: true,
    steps: [
      { key: 'blueprint' as const, state: 'done' as const, params: { filled: 5, total: 5 } },
      { key: 'specs' as const, state: 'done' as const, params: { count: 8, min: 5, max: 10 } },
      { key: 'audit' as const, state: 'done' as const, params: { count: 0 } },
    ],
    issues: [],
  }

  it('renders the three steps with localized details and an enabled CTA when ready', async () => {
    const onPrimary = vi.fn()
    render(
      <BlueprintReadiness readiness={readyReport} snapshot={{ status: 'idle' }} busy={false} primaryLabel="Create specs" onPrimary={onPrimary} />,
    )
    expect(screen.getByTestId('readiness-step-blueprint')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('readiness-step-specs')).toHaveTextContent('8 specs · complete')
    expect(screen.getByTestId('readiness-step-audit')).toHaveTextContent('no issues')
    const cta = screen.getByTestId('builder-create-specs')
    expect(cta).toBeEnabled()
    await userEvent.click(cta)
    expect(onPrimary).toHaveBeenCalled()
    expect(screen.queryByTestId('readiness-hint')).toBeNull()
  })

  it('disabled CTA explains the FIRST blocker in plain language', () => {
    const report = {
      ready: false,
      steps: [
        { key: 'blueprint' as const, state: 'done' as const, params: { filled: 5, total: 5 } },
        { key: 'specs' as const, state: 'pending' as const, params: { count: 0, min: 5, max: 10 } },
        { key: 'audit' as const, state: 'pending' as const, params: { count: 0 } },
      ],
      issues: [],
    }
    render(<BlueprintReadiness readiness={report} snapshot={{ status: 'idle' }} busy={false} primaryLabel="Create specs" onPrimary={vi.fn()} />)
    expect(screen.getByTestId('builder-create-specs')).toBeDisabled()
    expect(screen.getByTestId('readiness-hint')).toHaveTextContent('Approve the blueprint and the Builder will generate the Milestone-1 backlog.')
  })

  it('lists localized audit issues per spec and offers "ask the Builder to fix" when completion was claimed', async () => {
    const onRepair = vi.fn()
    const report = {
      ready: false,
      steps: [
        { key: 'blueprint' as const, state: 'done' as const, params: { filled: 5, total: 5 } },
        { key: 'specs' as const, state: 'done' as const, params: { count: 8, min: 5, max: 10 } },
        { key: 'audit' as const, state: 'blocked' as const, params: { count: 2 } },
      ],
      issues: [
        { specIndex: 2, field: 'acceptanceCriteria', code: 'criteria_count', message: 'raw', params: { n: 3, count: 1, min: 6, max: 10 } },
        { specIndex: 4, field: 'labels', code: 'domain_label', message: 'raw', params: { n: 5, label: 'M1' } },
      ],
    }
    render(<BlueprintReadiness readiness={report} snapshot={{ status: 'accepted', repaired: false, repairAttempted: true, at: 'now' }} busy={false} primaryLabel="Create specs" onPrimary={vi.fn()} onRepair={onRepair} />)
    expect(screen.getByTestId('readiness-issues-toggle')).toHaveTextContent('2 audit issues')
    await userEvent.click(screen.getByTestId('readiness-issues-toggle'))
    expect(screen.getByTestId('readiness-issues')).toHaveTextContent('Spec 3 needs 6–10 acceptance criteria (has 1).')
    expect(screen.getByTestId('readiness-issues')).toHaveTextContent('Spec 5 needs a domain label besides M1.')
    await userEvent.click(screen.getByTestId('readiness-ask-fix'))
    expect(onRepair).toHaveBeenCalled()
  })

  it('hides "ask to fix" while the model has not claimed completion (nothing for the app to repair)', () => {
    const report = {
      ready: false,
      steps: [
        { key: 'blueprint' as const, state: 'done' as const, params: { filled: 5, total: 5 } },
        { key: 'specs' as const, state: 'pending' as const, params: { count: 3, min: 5, max: 10 } },
        { key: 'audit' as const, state: 'blocked' as const, params: { count: 1 } },
      ],
      issues: [{ specIndex: 0, field: 'title', code: 'required', message: 'raw', params: { n: 1 } }],
    }
    render(<BlueprintReadiness readiness={report} snapshot={{ status: 'idle' }} busy={false} primaryLabel="Create specs" onPrimary={vi.fn()} onRepair={vi.fn()} />)
    expect(screen.queryByTestId('readiness-ask-fix')).toBeNull()
  })

  it('a rejected snapshot shows the reason, the diagnostic, and a retry that calls onRepair', async () => {
    const onRepair = vi.fn()
    render(
      <BlueprintReadiness
        readiness={{ ...readyReport, ready: false }}
        snapshot={{ status: 'rejected', reason: 'truncated', detail: 'cut off after 3 spec title(s)', repairAttempted: true, at: 'now' }}
        busy={false}
        primaryLabel="Create specs"
        onPrimary={vi.fn()}
        onRepair={onRepair}
      />,
    )
    expect(screen.getByTestId('snapshot-rejected')).toHaveTextContent('The reply was cut off before the block closed')
    expect(screen.getByTestId('snapshot-rejected')).toHaveTextContent('An automatic repair was already attempted.')
    expect(screen.getByTestId('snapshot-rejected-detail')).toHaveTextContent('cut off after 3 spec title(s)')
    await userEvent.click(screen.getByTestId('snapshot-retry'))
    expect(onRepair).toHaveBeenCalled()
    // No hint competes with the rejection card.
    expect(screen.queryByTestId('readiness-hint')).toBeNull()
  })

  it('repairing state renders the in-flight pill and disables the retry surface', () => {
    render(
      <BlueprintReadiness readiness={{ ...readyReport, ready: false }} snapshot={{ status: 'repairing', kind: 'invalid_json', manual: false, attempt: 1 }} busy primaryLabel="Create specs" onPrimary={vi.fn()} onRepair={vi.fn()} />,
    )
    expect(screen.getByTestId('snapshot-repairing')).toHaveTextContent('Repairing the snapshot (the last block was not valid JSON)… · automatic')
    expect(screen.queryByTestId('snapshot-retry')).toBeNull()
    expect(screen.getByTestId('builder-create-specs')).toBeDisabled()
  })

  it('an accepted snapshot that needed repair says so', () => {
    render(<BlueprintReadiness readiness={readyReport} snapshot={{ status: 'accepted', repaired: true, repairAttempted: true, at: 'now' }} busy={false} primaryLabel="Create specs" onPrimary={vi.fn()} />)
    expect(screen.getByTestId('snapshot-repaired')).toHaveTextContent('Snapshot repaired automatically')
  })
})

describe('BuilderRecentBlueprints', () => {
  const item = {
    id: 'conv-old', title: 'Tetris', productName: 'WebTetris', platform: 'web', provider: 'claude', model: null,
    updatedAt: new Date().toISOString(), messageCount: 6, specCount: 8, specsComplete: true, dimensionsFilled: 5,
    hasSnapshot: true, pendingIssue: null as null,
  }

  it('renders nothing when there is nothing to resume', () => {
    const { container } = render(<BuilderRecentBlueprints items={[]} loading={false} onResume={vi.fn()} onDiscard={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists resumable blueprints with their summary and resumes on click', async () => {
    const onResume = vi.fn()
    render(<BuilderRecentBlueprints items={[item, { ...item, id: 'conv-2', productName: null, title: null, specCount: 0, specsComplete: false, dimensionsFilled: 3, pendingIssue: 'truncated' }]} loading={false} onResume={onResume} onDiscard={vi.fn()} />)
    expect(screen.getByTestId('builder-recent')).toHaveTextContent('Continue where you left off')
    expect(screen.getByTestId('builder-recent-conv-old')).toHaveTextContent('WebTetris')
    expect(screen.getByTestId('builder-recent-conv-old')).toHaveTextContent('8 specs ready')
    expect(screen.getByTestId('builder-recent-conv-2')).toHaveTextContent('Untitled blueprint')
    expect(screen.getByTestId('builder-recent-conv-2')).toHaveTextContent('3/5 dimensions')
    expect(screen.getByTestId('builder-recent-pending-issue')).toHaveTextContent('snapshot to repair')
    await userEvent.click(screen.getByTestId('builder-recent-resume-conv-old'))
    expect(onResume).toHaveBeenCalledWith('conv-old')
  })

  it('discard is a two-step inline confirm', async () => {
    const onDiscard = vi.fn()
    render(<BuilderRecentBlueprints items={[item]} loading={false} onResume={vi.fn()} onDiscard={onDiscard} />)
    await userEvent.click(screen.getByTestId('builder-recent-discard-conv-old'))
    expect(onDiscard).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('builder-recent-discard-cancel-conv-old'))
    expect(screen.getByTestId('builder-recent-discard-conv-old')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('builder-recent-discard-conv-old'))
    await userEvent.click(screen.getByTestId('builder-recent-discard-confirm-conv-old'))
    expect(onDiscard).toHaveBeenCalledWith('conv-old')
  })
})

describe('BuilderGenerationProgress', () => {
  it('shows the writing label with the live spec count', () => {
    render(<BuilderGenerationProgress specsStarted={5} snapshot={{ status: 'idle' }} />)
    expect(screen.getByTestId('builder-generation-progress')).toHaveAttribute('data-phase', 'generating')
    expect(screen.getByTestId('builder-generation-progress')).toHaveTextContent('Writing the Milestone-1 specs…')
    expect(screen.getByTestId('builder-generation-count')).toHaveTextContent('spec 5')
  })

  it('switches to the repair label while the app re-asks for the snapshot', () => {
    render(<BuilderGenerationProgress specsStarted={0} snapshot={{ status: 'repairing', kind: 'truncated', manual: false, attempt: 1 }} />)
    expect(screen.getByTestId('builder-generation-progress')).toHaveAttribute('data-phase', 'repairing')
    expect(screen.getByTestId('builder-generation-progress')).toHaveTextContent('Re-requesting the snapshot (the reply was cut off)…')
    expect(screen.queryByTestId('builder-generation-count')).toBeNull()
  })
})

describe('BuilderGenerationProgress (batched generation)', () => {
  it('renders the phase label, the turn pill and a real ratio from the descriptor', () => {
    render(<BuilderGenerationProgress specsStarted={0} snapshot={{ status: 'generating', generation: { phase: 'details', from: 3, to: 4, total: 8, turn: 3, totalTurns: 6 } }} />)
    const el = screen.getByTestId('builder-generation-progress')
    expect(el).toHaveAttribute('data-phase', 'generation-details')
    expect(el).toHaveTextContent('Writing specs 3–4 of 8 in full…')
    expect(screen.getByTestId('builder-generation-turn')).toHaveTextContent('turn 3/6')
    expect(screen.queryByTestId('builder-generation-count')).toBeNull()
  })

  it('audit, repair and outline phases have their own labels', () => {
    // Fresh mounts per phase: AnimatePresence mode="wait" keeps the exiting
    // label mounted during the swap, which is exactly the crossfade we want.
    const mount = (phase: 'audit' | 'repair' | 'outline', from: number, to: number) =>
      render(<BuilderGenerationProgress specsStarted={0} snapshot={{ status: 'generating', generation: { phase, from, to, total: 8, turn: 5, totalTurns: 6 } }} />)
    let view = mount('audit', 1, 8)
    expect(screen.getByTestId('builder-generation-progress')).toHaveTextContent('Auditing all 8 specs…')
    view.unmount()
    view = mount('repair', 5, 6)
    expect(screen.getByTestId('builder-generation-progress')).toHaveAttribute('data-phase', 'generation-repair')
    expect(screen.getByTestId('builder-generation-progress')).toHaveTextContent('Re-asking for specs 5–6…')
    view.unmount()
    mount('outline', 0, 0)
    expect(screen.getByTestId('builder-generation-progress')).toHaveTextContent('Outlining the Milestone-1 specs…')
  })
})

describe('BlueprintReadiness (writing state)', () => {
  it('renders the writing steps with a spinner and the batch hint, no issue list', () => {
    render(
      <BlueprintReadiness
        readiness={{
          ready: false,
          steps: [
            { key: 'blueprint', state: 'done', params: { filled: 5, total: 5 } },
            { key: 'specs', state: 'writing', params: { count: 8, written: 2, min: 5, max: 10 } },
            { key: 'audit', state: 'writing', params: { count: 0 } },
          ],
          issues: [],
        }}
        snapshot={{ status: 'generating', generation: { phase: 'details', from: 3, to: 4, total: 8, turn: 3, totalTurns: 6 } }}
        busy
        primaryLabel="Create"
        onPrimary={vi.fn()}
        onRepair={vi.fn()}
      />,
    )
    expect(screen.getByTestId('readiness-step-specs')).toHaveAttribute('data-state', 'writing')
    expect(screen.getByTestId('readiness-step-specs')).toHaveTextContent('2 of 8 written')
    expect(screen.getByTestId('readiness-step-audit')).toHaveTextContent('after the specs are written')
    expect(screen.getByTestId('readiness-step-specs').querySelector('svg')).toHaveClass('animate-spin')
    expect(screen.queryByTestId('readiness-issues')).toBeNull()
    expect(screen.getByText(/The Builder is writing every spec in full/)).toBeInTheDocument()
  })
})

describe('BlueprintPanel (outline entries)', () => {
  it('an unwritten spec shows writing… while generating and "not written yet" when idle, never 0 criteria', () => {
    const bp = { ...blueprint(), specsComplete: false, m1Specs: blueprint().m1Specs.map((spec, i) => (i === 0 ? spec : { ...spec, description: '', acceptanceCriteria: [] })) }
    const { rerender } = render(<BlueprintPanel blueprint={bp} snapshot={{ status: 'generating', generation: { phase: 'details', from: 2, to: 3, total: 5, turn: 2, totalTurns: 5 } }} />)
    expect(screen.getByTestId('m1-spec-criteria-count-0')).toHaveTextContent('6 acceptance criteria')
    expect(screen.getByTestId('m1-spec-unwritten-1')).toHaveTextContent('writing…')
    expect(screen.queryByText('0 acceptance criteria')).toBeNull()
    rerender(<BlueprintPanel blueprint={bp} snapshot={{ status: 'accepted', repaired: false, repairAttempted: true, at: 'now', generationHalted: true }} />)
    expect(screen.getByTestId('m1-spec-unwritten-1')).toHaveTextContent('not written yet')
  })
})

describe('BlueprintReadiness (halted generation)', () => {
  const steps = [
    { key: 'blueprint' as const, state: 'done' as const, params: { filled: 5, total: 5 } },
    { key: 'specs' as const, state: 'pending' as const, params: { count: 8, written: 4, min: 5, max: 10 } },
    { key: 'audit' as const, state: 'blocked' as const, params: { count: 4 } },
  ]

  it('offers Continue generating with the written/total detail and routes it to onRepair', async () => {
    const onRepair = vi.fn()
    render(
      <BlueprintReadiness
        readiness={{ ready: false, steps, issues: [] }}
        snapshot={{ status: 'accepted', repaired: false, repairAttempted: true, at: 'now', generationHalted: true }}
        busy={false}
        primaryLabel="Create"
        onPrimary={vi.fn()}
        onRepair={onRepair}
      />,
    )
    const halted = screen.getByTestId('snapshot-halted')
    expect(halted).toHaveTextContent('Spec generation stopped early')
    expect(halted).toHaveTextContent('4 of 8 specs written in full')
    await userEvent.click(screen.getByTestId('snapshot-resume'))
    expect(onRepair).toHaveBeenCalledTimes(1)
    // The generic first-blocker hint yields to the halted notice.
    expect(screen.queryByText(/Approve the blueprint and the Builder will generate/)).toBeNull()
  })

  it('hides the halted notice while a turn is busy and when nothing halted', () => {
    const { rerender } = render(
      <BlueprintReadiness
        readiness={{ ready: false, steps, issues: [] }}
        snapshot={{ status: 'accepted', repaired: false, repairAttempted: true, at: 'now', generationHalted: true }}
        busy
        primaryLabel="Create"
        onPrimary={vi.fn()}
        onRepair={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('snapshot-halted')).toBeNull()
    rerender(
      <BlueprintReadiness
        readiness={{ ready: false, steps, issues: [] }}
        snapshot={{ status: 'accepted', repaired: true, repairAttempted: true, at: 'now' }}
        busy={false}
        primaryLabel="Create"
        onPrimary={vi.fn()}
        onRepair={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('snapshot-halted')).toBeNull()
    expect(screen.getByTestId('snapshot-repaired')).toBeInTheDocument()
  })
})

describe('BuilderConversation (snapshot hardening)', () => {
  function session(overrides: Partial<BuilderSession> = {}): BuilderSession {
    return {
      phase: 'chat', messages: [], streamBuffer: null, blueprint: null, busy: false,
      commitError: null, commitErrorDetail: null, commitSteps: [], createdProjectId: null, launching: false, launched: false, submitting: false,
      conversationReady: true, conversationId: null, dirty: false, canProposeCommit: false, specQualityDetail: null, showSurpriseMe: true,
      readiness: { ready: false, steps: [], issues: [] }, snapshot: { status: 'idle' }, generation: { generating: false, specsStarted: 0 },
      recent: [], recentLoading: false, resume: vi.fn(async () => {}), discardRecent: vi.fn(async () => {}), repairSnapshot: vi.fn(async () => {}),
      provider: 'claude', model: null, models: [{ value: 'sonnet', label: 'Claude Sonnet' }],
      efforts: ['low', 'medium', 'high'], effort: 'medium', draft: '', setDraft: vi.fn(), setEffort: vi.fn(),
      setProvider: vi.fn(), setModel: vi.fn(),
      send: vi.fn(), surpriseMe: vi.fn(), approveBlueprint: vi.fn(), goToCommit: vi.fn(), backToChat: vi.fn(),
      submitCommit: vi.fn(), launchM1: vi.fn(async () => {}), openProject: vi.fn(), abortAndReset: vi.fn(),
      ...overrides,
    }
  }
  function renderWith(s: BuilderSession) {
    mockAgentChat.builderMode = { active: true, enter: vi.fn(), exit: vi.fn(), session: s }
    render(withWs(<BuilderConversation variant="floating" />))
  }

  it('the empty hero offers the resume list and resumes through the session', async () => {
    const resume = vi.fn(async () => {})
    renderWith(session({
      resume,
      recent: [{
        id: 'conv-old', title: 'Tetris', productName: 'WebTetris', platform: 'web', provider: 'claude', model: null,
        updatedAt: new Date().toISOString(), messageCount: 6, specCount: 8, specsComplete: true, dimensionsFilled: 5,
        hasSnapshot: true, pendingIssue: null,
      }],
    }))
    expect(screen.getByTestId('builder-recent')).toHaveTextContent('WebTetris')
    await userEvent.click(screen.getByTestId('builder-recent-resume-conv-old'))
    expect(resume).toHaveBeenCalledWith('conv-old')
  })

  it('offers a one-click Surprise me card after a settled Builder reply while the interview is open', async () => {
    const surpriseMe = vi.fn()
    const s = session({
      surpriseMe,
      messages: [
        { role: 'user', content: 'quiero un pong', createdAt: new Date().toISOString() },
        { role: 'assistant', content: 'Unas preguntas… o dime "sorpréndeme".', createdAt: new Date().toISOString() },
      ],
      readiness: { ready: false, steps: [{ key: 'blueprint', state: 'pending', params: { filled: 0, total: 5 } }], issues: [] },
    })
    renderWith(s)
    const card = screen.getByTestId('builder-decision-card')
    expect(card).toHaveAttribute('data-kind', 'surprise')
    expect(card).toHaveAttribute('data-mode', 'offer')
    expect(card).toHaveTextContent('Surprise me')
    expect(card).toHaveTextContent('Let the Builder decide the product')
    await userEvent.click(card)
    expect(surpriseMe).toHaveBeenCalledTimes(1)
  })

  it('a decision taken from a card stays a settled card in the thread instead of the prompt bubble', () => {
    renderWith(session({
      messages: [
        { role: 'user', content: 'quiero un pong', createdAt: '2026-09-04T21:58:41.000Z' },
        { role: 'assistant', content: 'Preguntas…', createdAt: '2026-09-04T21:58:50.000Z' },
        { role: 'user', content: 'Surprise me — propose sensible defaults…', createdAt: '2026-09-04T21:59:00.000Z', intent: 'surprise' },
        { role: 'assistant', content: '¡Perfecto! Propuesta completa.', createdAt: '2026-09-04T21:59:30.000Z' },
      ],
      busy: true,
    }))
    const settled = screen.getByTestId('builder-decision-card')
    expect(settled).toHaveAttribute('data-mode', 'settled')
    expect(settled).toHaveAttribute('data-kind', 'surprise')
    expect(settled).toHaveTextContent('Decision taken')
    expect(settled).toHaveTextContent('You let the Builder decide every blueprint dimension.')
    expect(screen.queryByText('Surprise me — propose sensible defaults…')).toBeNull()
    expect(settled.tagName).toBe('DIV')
  })

  it('offers Approve once the blueprint is decided and no spec exists; click approves; hidden once specs exist', async () => {
    const approveBlueprint = vi.fn()
    const base = {
      approveBlueprint,
      messages: [
        { role: 'user' as const, content: 'go', createdAt: new Date().toISOString() },
        { role: 'assistant' as const, content: '¿Aprobamos el blueprint?', createdAt: new Date().toISOString() },
      ],
      blueprint: { ...blueprint(), specsComplete: false, m1Specs: [] },
      readiness: {
        ready: false,
        steps: [
          { key: 'blueprint' as const, state: 'done' as const, params: { filled: 5, total: 5 } },
          { key: 'specs' as const, state: 'pending' as const, params: { count: 0, written: 0, min: 5, max: 10 } },
          { key: 'audit' as const, state: 'pending' as const, params: { count: 0 } },
        ],
        issues: [],
      },
    }
    renderWith(session(base))
    const card = screen.getByTestId('builder-decision-card')
    expect(card).toHaveAttribute('data-kind', 'approve')
    expect(card).toHaveTextContent('Approve & generate specs')
    expect(card).toHaveTextContent('Or type what you want to change')
    await userEvent.click(card)
    expect(approveBlueprint).toHaveBeenCalledTimes(1)
    cleanup()
    // Specs already exist (outline or complete): no approve card, no surprise card.
    renderWith(session({
      ...base,
      blueprint: blueprint(),
      readiness: { ...base.readiness, steps: [base.readiness.steps[0], { key: 'specs', state: 'done', params: { count: 5, written: 5, min: 5, max: 10 } }, base.readiness.steps[2]] },
    }))
    expect(screen.queryByTestId('builder-decision-card')).toBeNull()
  })

  it('hides the decision cards while a turn is in flight, after the user speaks, and on the hero', () => {
    const base = {
      messages: [
        { role: 'user' as const, content: 'go', createdAt: new Date().toISOString() },
        { role: 'assistant' as const, content: 'ok', createdAt: new Date().toISOString() },
      ],
      readiness: { ready: false, steps: [{ key: 'blueprint' as const, state: 'pending' as const, params: { filled: 2, total: 5 } }], issues: [] },
    }
    renderWith(session({ ...base, busy: true }))
    expect(screen.queryByTestId('builder-decision-card')).toBeNull()
    cleanup()
    renderWith(session({ ...base, messages: [...base.messages, { role: 'user', content: 'web', createdAt: new Date().toISOString() }] }))
    expect(screen.queryByTestId('builder-decision-card')).toBeNull()
    cleanup()
    renderWith(session({ ...base, messages: [] }))
    expect(screen.queryByTestId('builder-decision-card')).toBeNull()
  })

  it('a streaming snapshot block shows generation progress instead of the thinking chip', () => {
    renderWith(session({
      messages: [{ role: 'user', content: 'go', createdAt: new Date().toISOString() }],
      busy: true,
      streamBuffer: 'Generating…\n```blueprint-draft\n{"m1Specs":[{"title":"a"},{"title":"b"},{"title":"c"}',
      generation: { generating: true, specsStarted: 3 },
    }))
    expect(screen.getByTestId('builder-generation-progress')).toHaveTextContent('spec 3')
    // The raw open fence never reaches the bubble.
    expect(screen.queryByText(/blueprint-draft/)).toBeNull()
  })

  it('between batched generation turns the thread keeps the phase progress, not the thinking chip', () => {
    renderWith(session({
      messages: [{ role: 'user', content: 'go', createdAt: new Date().toISOString() }],
      busy: true,
      streamBuffer: null,
      generation: { generating: false, specsStarted: 0 },
      snapshot: { status: 'generating', generation: { phase: 'details', from: 5, to: 6, total: 8, turn: 4, totalTurns: 6 } },
    }))
    expect(screen.getByTestId('builder-generation-progress')).toHaveAttribute('data-phase', 'generation-details')
    expect(screen.getByTestId('builder-generation-turn')).toHaveTextContent('turn 4/6')
  })

  it('a repair turn shows the repairing phase in the thread', () => {
    renderWith(session({
      messages: [{ role: 'user', content: 'go', createdAt: new Date().toISOString() }],
      busy: true,
      streamBuffer: null,
      snapshot: { status: 'repairing', kind: 'quality', manual: false, attempt: 1 },
    }))
    expect(screen.getByTestId('builder-generation-progress')).toHaveAttribute('data-phase', 'repairing')
  })
})
