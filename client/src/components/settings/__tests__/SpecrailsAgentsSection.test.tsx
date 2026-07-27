import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m) } }))

import { SpecrailsAgentsSection } from '../SpecrailsAgentsSection'

const CATALOG = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    models: [
      { value: 'sonnet', label: 'Claude Sonnet', default: true },
      { value: 'opus', label: 'Claude Opus' },
      { value: 'haiku', label: 'Claude Haiku' },
    ],
    defaultModel: 'sonnet',
    baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
    perAgentModels: true,
    supportsEffort: true,
    customModelAliases: false,
    effortsByModel: { sonnet: ['low', 'medium', 'high', 'xhigh'], opus: ['low', 'medium', 'high', 'xhigh'], haiku: ['low', 'medium', 'high', 'xhigh'] },
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    models: [{ value: 'gpt-5.5', label: 'GPT-5.5', default: true }],
    defaultModel: 'gpt-5.5',
    baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
    perAgentModels: false,
    supportsEffort: true,
    customModelAliases: false,
    effortsByModel: { 'gpt-5.5': ['low', 'medium', 'high'] },
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    models: [{ value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', default: true }],
    defaultModel: 'gemini-3.5-flash',
    baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
    perAgentModels: false,
    supportsEffort: false,
    customModelAliases: false,
    effortsByModel: { 'gemini-3.5-flash': [] },
  },
  {
    id: 'kimi',
    displayName: 'Kimi Code',
    models: [{ value: 'k3', label: 'Kimi K3', default: true }],
    defaultModel: 'k3',
    baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
    perAgentModels: true,
    supportsEffort: true,
    customModelAliases: true,
    effortsByModel: { k3: ['low', 'high', 'max'] },
  },
]

const DETECTION = {
  detected: ['claude', 'codex', 'gemini'],
  providers: {
    claude: { id: 'claude', displayName: 'Claude Code', installed: true, executable: true, version: '2.1.0', authState: 'authenticated', usable: true },
    codex: { id: 'codex', displayName: 'Codex CLI', installed: true, executable: true, authState: 'unauthenticated', usable: true },
    gemini: { id: 'gemini', displayName: 'Gemini CLI', installed: true, executable: true, authState: 'unknown', usable: true },
  },
}

function mockFetch(opts: {
  settings?: Record<string, unknown>
  patch?: { ok: boolean; body?: unknown }
  onPatch?: (body: unknown) => void
}) {
  const settings = { version: 1, providers: opts.settings ?? {} }
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/providers/detected')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => DETECTION })
    }
    if (u.includes('/api/agent-defaults')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { providers: Record<string, unknown> }
        opts.onPatch?.(body)
        if (opts.patch && !opts.patch.ok) {
          return Promise.resolve({ ok: false, status: 400, json: async () => (opts.patch?.body ?? { message: 'bad' }) })
        }
        const merged = { version: 1, providers: { ...settings.providers, ...body.providers } }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ settings: merged, catalog: CATALOG }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ settings, catalog: CATALOG }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  }) as never
}

beforeEach(() => {
  toastError.mockClear()
})

describe('SpecrailsAgentsSection', () => {
  it('renders one card per provider with detection badges', async () => {
    mockFetch({})
    render(<SpecrailsAgentsSection />)
    await screen.findByTestId('agent-defaults-card-claude')
    expect(screen.getByTestId('agent-defaults-card-codex')).toBeTruthy()
    expect(screen.getByTestId('agent-defaults-card-gemini')).toBeTruthy()
    expect(screen.getByTestId('agent-defaults-card-kimi')).toBeTruthy()
    // kimi is not detected → badge + disabled toggle
    expect(screen.getByText('Not detected')).toBeTruthy()
    expect((screen.getByTestId('agent-defaults-mode-custom-kimi') as HTMLButtonElement).disabled).toBe(true)
    // codex detected but unauthenticated → amber badge
    expect(screen.getByText('Not signed in')).toBeTruthy()
  })

  it('switching a provider to Custom PATCHes and reveals the pipeline + agent rows', async () => {
    const patches: unknown[] = []
    mockFetch({ onPatch: (b) => patches.push(b) })
    render(<SpecrailsAgentsSection />)
    fireEvent.click(await screen.findByTestId('agent-defaults-mode-custom-claude'))
    await waitFor(() => expect(patches.length).toBe(1))
    expect(patches[0]).toEqual({ providers: { claude: { custom: true } } })
    // Body revealed: pipeline selectors + the baseline trio rows
    expect(await screen.findByTestId('agent-defaults-model-claude')).toBeTruthy()
    expect(screen.getByTestId('agent-defaults-effort-claude')).toBeTruthy()
    expect(screen.getByTestId('agent-defaults-agent-claude-sr-architect')).toBeTruthy()
    expect(screen.getByTestId('agent-defaults-agent-claude-sr-developer')).toBeTruthy()
    expect(screen.getByTestId('agent-defaults-agent-claude-sr-reviewer')).toBeTruthy()
  })

  it('codex shows the inherit note instead of per-agent rows; gemini hides the effort selector', async () => {
    mockFetch({
      settings: {
        codex: { custom: true },
        gemini: { custom: true },
      },
    })
    render(<SpecrailsAgentsSection />)
    await screen.findByTestId('agent-defaults-card-codex')
    expect(await screen.findByText('Codex sub-agents inherit the pipeline model and effort by design.')).toBeTruthy()
    expect(screen.queryByTestId('agent-defaults-agent-codex-sr-architect')).toBeNull()
    expect(screen.getByTestId('agent-defaults-model-gemini')).toBeTruthy()
    expect(screen.queryByTestId('agent-defaults-effort-gemini')).toBeNull()
  })

  it('reverts and toasts when the PATCH fails', async () => {
    mockFetch({ patch: { ok: false, body: { message: 'invalid_model' } } })
    render(<SpecrailsAgentsSection />)
    fireEvent.click(await screen.findByTestId('agent-defaults-mode-custom-claude'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // Reverted: the pipeline body is gone again
    await waitFor(() => expect(screen.queryByTestId('agent-defaults-model-claude')).toBeNull())
  })

  it('reset restores defaults with a wholesale custom:false PATCH', async () => {
    const patches: Array<{ providers: Record<string, unknown> }> = []
    mockFetch({
      settings: { claude: { custom: true, pipelineModel: 'opus', agentModels: { 'sr-reviewer': 'haiku' } } },
      onPatch: (b) => patches.push(b as { providers: Record<string, unknown> }),
    })
    render(<SpecrailsAgentsSection />)
    fireEvent.click(await screen.findByTestId('agent-defaults-reset-claude'))
    await waitFor(() => expect(patches.length).toBe(1))
    expect(patches[0]).toEqual({ providers: { claude: { custom: false } } })
  })

  it('shows the load-failed message when the initial GET breaks', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('net')) as never
    render(<SpecrailsAgentsSection />)
    expect(await screen.findByText('Could not load the agent defaults.')).toBeTruthy()
  })
})
