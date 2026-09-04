import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useBuilderSession, SURPRISE_ME_PROMPT } from '../useBuilderSession'
import { SharedWebSocketContext } from '../useSharedWebSocket'
import { coerceBlueprint, type Blueprint } from '../../lib/blueprint-draft'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const setActiveProjectId = vi.fn()
vi.mock('../useDesktop', () => ({
  useDesktop: () => ({ setActiveProjectId }),
}))

function blueprint(): Blueprint {
  const description = (readme: boolean) => [
    '## Problem Statement', `Users need a complete workflow.${readme ? ' The repository already contains a README.' : ''}`,
    '', '## Proposed Solution', 'Build the end-to-end behavior with explicit boundaries and persisted state.',
    '', '## Out of Scope', '- Collaboration', '- Advanced analytics',
    '', '## Technical Considerations', '- Cover failure states', '- Add automated tests',
    '', '## Estimated Complexity', 'Medium — the slice crosses multiple layers.',
  ].join('\n')
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'p', audience: 'a' },
    coreFlow: 'flow',
    platform: 'web',
    stack: { language: 'ts', framework: 'next', db: 'sqlite' },
    assumptions: [],
    milestones: [{ id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'planned', plannedSpecs: [] }],
    specsComplete: true,
    m1Specs: Array.from({ length: 5 }, (_, index) => ({
      kind: index === 0 ? 'scaffold' : 'feature',
      title: index === 0 ? 'Scaffold the project' : `Deliver slice ${index}`,
      shortSummary: `Deliver a complete testable slice ${index}.`,
      description: description(index === 0),
      acceptanceCriteria: [
        'The happy path completes successfully.',
        'Invalid input produces an actionable error.',
        'An empty state renders deliberately.',
        'Automated tests cover failure behavior.',
      ],
      priority: 'medium',
      labels: ['M1', index === 0 ? 'foundation' : 'workflow'],
      ...(index > 0 ? { dependsOnIndex: index - 1 } : {}),
    })),
  }
}

const wsValue = {
  registerHandler: vi.fn(),
  unregisterHandler: vi.fn(),
  connectionStatus: 'connected' as const,
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <SharedWebSocketContext.Provider value={wsValue}>{children}</SharedWebSocketContext.Provider>
}

function lastHandler(): (msg: unknown) => void {
  return wsValue.registerHandler.mock.calls.at(-1)![1] as (msg: unknown) => void
}

function mockFetch(routes: Record<string, { status?: number; body?: unknown }> = {}) {
  global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [fragment, res] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        const status = res.status ?? 200
        return { ok: status < 300, status, json: async () => res.body ?? {} }
      }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

/** Lazy creation: the conversation row exists only after the first send. */
async function openConversation(result: { current: { send: (t: string) => void; conversationId: string | null } }) {
  act(() => result.current.send('start'))
  await waitFor(() => expect(result.current.conversationId).toBe('conv-1'))
}

function requestBodyFor(fragment: string): Record<string, unknown> {
  const call = vi.mocked(global.fetch).mock.calls.find(([input]) => String(input).includes(fragment))
  expect(call, `fetch call containing ${fragment}`).toBeDefined()
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch({ '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } } })
})

describe('useBuilderSession', () => {
  it('does nothing while disabled', () => {
    renderHook(() => useBuilderSession(false, { onFinished: vi.fn() }), { wrapper })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(wsValue.registerHandler).not.toHaveBeenCalled()
  })

  it('registers the WS handler and loads the resume list when enabled — no eager conversation row', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations?resumable=1'))
    expect(vi.mocked(global.fetch).mock.calls.some(([input, init]) => String(input) === '/api/blueprint/conversations' && (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
    expect(wsValue.registerHandler).toHaveBeenCalled()
    expect(result.current.conversationId).toBeNull()
    expect(result.current.phase).toBe('chat')
    expect(result.current.showSurpriseMe).toBe(true)
    expect(result.current.snapshot).toEqual({ status: 'idle' })
  })

  it('creates the conversation on the first send (single-flight) with the selected provider, then posts the turn', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    act(() => result.current.send('a tetris game'))
    await waitFor(() => expect(result.current.conversationId).toBe('conv-1'))
    const creates = vi.mocked(global.fetch).mock.calls.filter(([input, init]) => String(input) === '/api/blueprint/conversations' && (init as RequestInit | undefined)?.method === 'POST')
    expect(creates).toHaveLength(1)
    expect(JSON.parse(String((creates[0][1] as RequestInit).body))).toEqual({ provider: 'claude' })
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations/conv-1/send', expect.anything()))
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: 'a tetris game' })
    expect(result.current.busy).toBe(true)
  })

  it('blueprint.done stores the snapshot and enables the commit CTA; dirty flips', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    expect(result.current.dirty).toBe(false)
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'Plan.', blueprint: blueprint(), snapshot: { status: 'accepted', claimsComplete: true } })
    })
    expect(result.current.blueprint?.product.name).toBe('Recipely')
    expect(result.current.canProposeCommit).toBe(true)
    expect(result.current.dirty).toBe(true)
    expect(result.current.busy).toBe(false)
    expect(result.current.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Plan.' })
    expect(result.current.snapshot).toMatchObject({ status: 'accepted', repaired: false })
    expect(result.current.readiness.ready).toBe(true)
    expect(result.current.readiness.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  })

  it('keeps a partial or shallow generation out of the commit flow, with a localized readiness hint', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    const partial = blueprint()
    partial.specsComplete = false
    partial.m1Specs = [{ ...partial.m1Specs[0], description: 'Initialize the app.' }]
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'Partial.', blueprint: partial, snapshot: { status: 'accepted' } })
    })
    expect(result.current.canProposeCommit).toBe(false)
    expect(result.current.specQualityDetail).toBe('The Builder has not marked the batch as complete yet.')
    const specs = result.current.readiness.steps.find((s) => s.key === 'specs')
    expect(specs).toMatchObject({ state: 'blocked', params: { count: 1, min: 5, max: 10 } })
  })

  it('a WS frame for a foreign conversation is ignored before and after creation', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: null, fullText: 'ghost', blueprint: blueprint() })
    })
    expect(result.current.blueprint).toBeNull()
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-2', fullText: 'ghost', blueprint: blueprint() })
    })
    expect(result.current.blueprint).toBeNull()
  })

  it('a block-only reply appends no empty bubble; a rejected snapshot is surfaced with its reason', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({
        type: 'blueprint.done', conversationId: 'conv-1', fullText: '', blueprint: null, rawBlueprint: null,
        snapshot: { status: 'rejected', reason: 'truncated', detail: 'cut after 3 specs', repairAttempted: true },
      })
    })
    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(result.current.snapshot).toMatchObject({ status: 'rejected', reason: 'truncated', detail: 'cut after 3 specs', repairAttempted: true })
    expect(result.current.busy).toBe(false)
  })

  it('blueprint.repairing keeps the turn busy and a no-block done falls back to idle', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.repairing', conversationId: 'conv-1', kind: 'quality', attempt: 1, manual: false })
    })
    expect(result.current.busy).toBe(true)
    expect(result.current.snapshot).toEqual({ status: 'repairing', kind: 'quality', manual: false, attempt: 1 })
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'nothing', blueprint: null, rawBlueprint: null, snapshot: { status: 'none' } })
    })
    expect(result.current.snapshot).toEqual({ status: 'idle' })
    expect(result.current.busy).toBe(false)
  })

  it('a repaired acceptance is flagged so the panel can say "repaired automatically"', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'ok', blueprint: blueprint(), snapshot: { status: 'accepted', repaired: true, repairAttempted: true, claimsComplete: true } })
    })
    expect(result.current.snapshot).toMatchObject({ status: 'accepted', repaired: true, repairAttempted: true })
  })

  it('legacy blueprint.done without a snapshot field still parses the settled text', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    const fenced = 'Plan.\n```blueprint-draft\n' + JSON.stringify(blueprint()) + '\n```'
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: fenced, blueprint: null })
    })
    expect(result.current.blueprint?.product.name).toBe('Recipely')
    expect(result.current.snapshot).toMatchObject({ status: 'accepted' })
  })

  it('generation progress is derived from the stream buffer while a block is open', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.stream', conversationId: 'conv-1', delta: 'Generating…\n```blueprint-draft\n{"m1Specs":[{"title":"a"},{"title":"b"}' })
    })
    expect(result.current.generation).toEqual({ generating: true, specsStarted: 2 })
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'Generating…', blueprint: blueprint(), snapshot: { status: 'accepted' } })
    })
    expect(result.current.generation).toEqual({ generating: false, specsStarted: 0 })
  })

  it('keeps raw invalid model fields uncommittable and submits them without laundering defaults', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    const raw = JSON.parse(JSON.stringify(blueprint())) as Record<string, unknown> & {
      m1Specs: Array<Record<string, unknown>>
    }
    raw.m1Specs[1].priority = 'urgent'
    raw.m1Specs[1].dependsOnIndex = -1
    const normalized = coerceBlueprint(raw)
    expect(normalized?.m1Specs[1]).toMatchObject({ priority: 'medium' })
    expect(normalized?.m1Specs[1].dependsOnIndex).toBeUndefined()

    act(() => {
      lastHandler()({
        type: 'blueprint.done', conversationId: 'conv-1', fullText: 'Generated.',
        blueprint: normalized, rawBlueprint: raw,
      })
    })
    expect(result.current.canProposeCommit).toBe(false)
    expect(result.current.specQualityDetail).toBe('Spec 2 needs a valid priority.')

    act(() => result.current.submitCommit({
      name: 'Raw payload', location: '/tmp/raw-payload', providers: ['claude'], createGithubRepo: false,
    }))
    await waitFor(() => expect(requestBodyFor('/api/blueprint/commit')).toBeDefined())
    const body = requestBodyFor('/api/blueprint/commit') as { blueprint: { m1Specs: Array<Record<string, unknown>> }; conversationId?: string }
    expect(body.blueprint.m1Specs[1]).toMatchObject({ priority: 'urgent', dependsOnIndex: -1 })
    // The commit links the conversation so the resume list stops offering it.
    expect(body.conversationId).toBe('conv-1')
  })

  it('surpriseMe sends the fixed prompt', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    act(() => result.current.surpriseMe())
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: SURPRISE_ME_PROMPT })
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations/conv-1/send', expect.anything()))
  })

  it('loads the provider effort catalog and sends the selected effort', async () => {
    mockFetch({
      '/api/blueprint/models?provider=claude': {
        body: {
          models: [{ value: 'sonnet', label: 'Claude Sonnet', default: true }],
          efforts: ['low', 'medium', 'high', 'xhigh'],
        },
      },
      '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
    })
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.efforts).toEqual(['low', 'medium', 'high', 'xhigh']))
    act(() => result.current.setEffort('high'))
    await waitFor(() => expect(result.current.effort).toBe('high'))
    act(() => result.current.send('use deeper reasoning'))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/send'), expect.anything()))
    expect(requestBodyFor('/send')).toEqual({ text: 'use deeper reasoning', reasoning_effort: 'high' })
  })

  it('omits reasoning_effort for a provider without an effort knob', async () => {
    mockFetch({
      '/api/blueprint/models?provider=claude': {
        body: { models: [{ value: 'sonnet', label: 'Claude Sonnet' }], efforts: ['low', 'medium', 'high'] },
      },
      '/api/blueprint/models?provider=gemini': {
        body: { models: [{ value: 'gemini-pro', label: 'Gemini Pro' }], efforts: [] },
      },
      '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
    })
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await waitFor(() => expect(result.current.efforts).toEqual(['low', 'medium', 'high']))
    act(() => result.current.setProvider('gemini'))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/models?provider=gemini'))
    await waitFor(() => expect(result.current.efforts).toEqual([]))
    act(() => result.current.send('gemini turn'))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/send'), expect.anything()))
    expect(requestBodyFor('/send')).toEqual({ text: 'gemini turn' })
    // Provider chosen before the row existed rides the lazy create.
    const create = vi.mocked(global.fetch).mock.calls.find(([input, init]) => String(input) === '/api/blueprint/conversations' && (init as RequestInit | undefined)?.method === 'POST')!
    expect(JSON.parse(String((create[1] as RequestInit).body))).toEqual({ provider: 'gemini' })
  })

  it('clears Kimi effort when the builder model switches away from K3', async () => {
    mockFetch({
      '/api/blueprint/models?provider=claude': {
        body: {
          models: [{ value: 'sonnet', label: 'Claude Sonnet' }],
          defaultModel: 'sonnet',
          efforts: ['low', 'medium', 'high'],
        },
      },
      '/api/blueprint/models?provider=kimi': {
        body: {
          models: [
            { value: 'k3', label: 'Kimi K3' },
            { value: 'kimi-for-coding', label: 'Kimi for Coding' },
          ],
          defaultModel: 'k3',
          efforts: ['low', 'high', 'max'],
        },
      },
      '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
    })
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    act(() => result.current.setProvider('kimi'))
    await waitFor(() => expect(result.current.efforts).toEqual(['low', 'high', 'max']))
    expect(result.current.effort).toBe('high')

    act(() => {
      result.current.setEffort('high')
      result.current.setModel('kimi-for-coding')
    })
    await waitFor(() => expect(result.current.efforts).toEqual([]))
    expect(result.current.effort).toBe('')

    act(() => result.current.send('coding turn'))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/send'), expect.anything()))
    expect(requestBodyFor('/send')).toEqual({
      text: 'coding turn',
      model: 'kimi-for-coding',
    })
  })

  it('commit 202 → progress phase; commit_done → done with the projectId', async () => {
    mockFetch({
      '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
      '/api/blueprint/commit': { status: 202, body: { commitId: 'commit-9' } },
    })
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'x', blueprint: blueprint() })
    })
    act(() => result.current.goToCommit())
    expect(result.current.phase).toBe('commit')
    await act(async () => {
      result.current.submitCommit({ name: 'Recipely', location: '~/projects/recipely', providers: ['claude'], createGithubRepo: false })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.phase).toBe('progress'))
    expect(result.current.submitting).toBe(false)
    act(() => {
      lastHandler()({ type: 'blueprint.commit_progress', commitId: 'commit-9', step: 'git-init', status: 'done' })
      lastHandler()({ type: 'blueprint.commit_done', commitId: 'commit-9', projectId: 'proj-7' })
    })
    expect(result.current.commitSteps).toEqual([{ step: 'git-init', status: 'done', detail: undefined }])
    expect(result.current.phase).toBe('done')
    expect(result.current.createdProjectId).toBe('proj-7')
  })

  it('github warning persists its code and fires one non-blocking toast', async () => {
    const { toast } = await import('sonner')
    mockFetch({
      '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
      '/api/blueprint/commit': { status: 202, body: { commitId: 'commit-9' } },
    })
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'x', blueprint: blueprint() })
    })
    await act(async () => {
      result.current.submitCommit({ name: 'Recipely', location: '~/projects/recipely', providers: ['claude'], createGithubRepo: true })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.phase).toBe('progress'))
    act(() => {
      lastHandler()({ type: 'blueprint.commit_progress', commitId: 'commit-9', step: 'github', status: 'warning', detail: 'missing repo scope', code: 'gh_scope' })
      // A repeated upsert of the same warning must not re-toast.
      lastHandler()({ type: 'blueprint.commit_progress', commitId: 'commit-9', step: 'github', status: 'warning', detail: 'missing repo scope', code: 'gh_scope' })
      lastHandler()({ type: 'blueprint.commit_done', commitId: 'commit-9', projectId: 'proj-7' })
    })
    expect(result.current.commitSteps).toEqual([
      { step: 'github', status: 'warning', detail: 'missing repo scope', code: 'gh_scope' },
    ])
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/repositories|repo scope|token/i), { description: 'missing repo scope' })
    expect(result.current.phase).toBe('done')
  })

  it('commit validation error stays on the form with its actionable detail', async () => {
    mockFetch({
      '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
      '/api/blueprint/commit': {
        status: 400,
        body: { error: 'm1_spec_quality_invalid', detail: 'spec 2 section "Out of Scope" requires at least two bullets' },
      },
    })
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'x', blueprint: blueprint() })
    })
    act(() => result.current.goToCommit())
    expect(result.current.phase).toBe('commit')
    await act(async () => {
      result.current.submitCommit({ name: 'x', location: '/dirty', providers: ['claude'], createGithubRepo: false })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.commitError).toBe('m1_spec_quality_invalid'))
    expect(result.current.commitErrorDetail).toBe('spec 2 section "Out of Scope" requires at least two bullets')
    expect(result.current.phase).toBe('commit')
  })

  it('guards against a double commit while the first request is pending', async () => {
    let resolveCommit!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    global.fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/blueprint/commit')) {
        return new Promise((resolve) => { resolveCommit = resolve })
      }
      if (url.includes('/api/blueprint/conversations')) {
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ conversation: { id: 'conv-1' } }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'x', blueprint: blueprint() })
    })
    const value = { name: 'Recipely', location: '~/projects/recipely', providers: ['claude'], createGithubRepo: false }
    act(() => {
      result.current.submitCommit(value)
      result.current.submitCommit(value)
    })
    expect(result.current.submitting).toBe(true)
    expect(vi.mocked(global.fetch).mock.calls.filter(([input]) => String(input).includes('/api/blueprint/commit'))).toHaveLength(1)
    await act(async () => {
      resolveCommit({ ok: true, status: 202, json: async () => ({ commitId: 'commit-1' }) })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.phase).toBe('progress'))
  })

  it('openProject activates the created project and calls onFinished', async () => {
    const onFinished = vi.fn()
    const { result } = renderHook(() => useBuilderSession(true, { onFinished }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    act(() => {
      lastHandler()({ type: 'blueprint.commit_done', commitId: null, projectId: 'x' })
    })
    // commit_done for a foreign commitId is ignored (no commit in flight)
    expect(result.current.phase).toBe('chat')
    act(() => result.current.openProject())
    expect(onFinished).toHaveBeenCalled()
    expect(setActiveProjectId).not.toHaveBeenCalled() // no created project yet
  })

  it('abortAndReset aborts the live conversation and clears every slice', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useBuilderSession(enabled, { onFinished: vi.fn() }),
      { wrapper, initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    await openConversation(result)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'x', blueprint: blueprint() })
      result.current.setDraft('unsent detail')
    })
    expect(result.current.dirty).toBe(true)
    rerender({ enabled: false })
    act(() => result.current.abortAndReset())
    expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations/conv-1/abort', { method: 'POST' })
    expect(result.current.blueprint).toBeNull()
    expect(result.current.messages).toEqual([])
    expect(result.current.phase).toBe('chat')
    expect(result.current.dirty).toBe(false)
    expect(result.current.draft).toBe('')
    expect(result.current.efforts).toEqual([])
    expect(result.current.conversationReady).toBe(false)
    expect(result.current.conversationId).toBeNull()
    expect(result.current.snapshot).toEqual({ status: 'idle' })
  })

  describe('resume / discard / manual repair (harden-project-builder-snapshots)', () => {
    const recentRow = {
      id: 'conv-old', title: 'Tetris', productName: 'WebTetris', platform: 'web', provider: 'claude', model: null,
      updated_at: '2026-09-04 08:00:00', messageCount: 6, specCount: 8, specsComplete: true, dimensionsFilled: 5,
      hasSnapshot: true, pendingIssue: null,
    }

    it('loads the resume list and rehydrates a conversation (transcript, snapshot, provider, session)', async () => {
      mockFetch({
        '/api/blueprint/conversations?resumable=1': { body: { conversations: [recentRow] } },
        '/api/blueprint/conversations/conv-old': {
          body: {
            conversation: { id: 'conv-old', provider: 'codex', model: 'gpt-5.6-sol' },
            messages: [
              { role: 'user', content: 'tetris', created_at: '2026-09-04 07:59:00' },
              { role: 'assistant', content: '', created_at: '2026-09-04 07:59:30' },
              { role: 'assistant', content: 'Backlog ready.', created_at: '2026-09-04 08:00:00' },
            ],
            blueprint: blueprint(),
            rawBlueprint: blueprint(),
            snapshot: { status: 'accepted', claimsComplete: true },
          },
        },
      })
      const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
      await waitFor(() => expect(result.current.recent).toHaveLength(1))
      expect(result.current.recent[0]).toMatchObject({ id: 'conv-old', productName: 'WebTetris', specCount: 8, specsComplete: true, updatedAt: '2026-09-04 08:00:00' })
      await act(async () => { await result.current.resume('conv-old') })
      expect(result.current.conversationId).toBe('conv-old')
      expect(result.current.provider).toBe('codex')
      expect(result.current.model).toBe('gpt-5.6-sol')
      expect(result.current.messages.map((m) => m.content)).toEqual(['tetris', 'Backlog ready.'])
      expect(result.current.blueprint?.product.name).toBe('Recipely')
      expect(result.current.canProposeCommit).toBe(true)
      expect(result.current.snapshot).toMatchObject({ status: 'accepted' })
      expect(result.current.conversationReady).toBe(true)
      // Later turns go to the resumed row — no new conversation is created.
      act(() => result.current.send('tweak spec 3'))
      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations/conv-old/send', expect.anything()))
      expect(vi.mocked(global.fetch).mock.calls.some(([input, init]) => String(input) === '/api/blueprint/conversations' && (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
    })

    it('a resume with a pending rejection restores the repair affordance', async () => {
      mockFetch({
        '/api/blueprint/conversations?resumable=1': { body: { conversations: [{ ...recentRow, pendingIssue: 'truncated', hasSnapshot: false }] } },
        '/api/blueprint/conversations/conv-old': {
          body: { conversation: { id: 'conv-old', provider: 'claude' }, messages: [], blueprint: null, rawBlueprint: null, snapshot: { status: 'rejected', reason: 'truncated', detail: 'cut' } },
        },
      })
      const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
      await waitFor(() => expect(result.current.recent[0]?.pendingIssue).toBe('truncated'))
      await act(async () => { await result.current.resume('conv-old') })
      expect(result.current.snapshot).toMatchObject({ status: 'rejected', reason: 'truncated', detail: 'cut' })
      expect(result.current.blueprint).toBeNull()
    })

    it('a failed resume toasts and leaves the session untouched', async () => {
      const { toast } = await import('sonner')
      mockFetch({ '/api/blueprint/conversations/conv-old': { status: 404, body: { error: 'conversation not found' } } })
      const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
      await act(async () => { await result.current.resume('conv-old') })
      expect(toast.error).toHaveBeenCalledWith('Could not resume that blueprint.')
      expect(result.current.conversationId).toBeNull()
    })

    it('discardRecent deletes the row and drops it from the list', async () => {
      mockFetch({
        '/api/blueprint/conversations?resumable=1': { body: { conversations: [recentRow] } },
        '/api/blueprint/conversations/conv-old': { body: { ok: true } },
      })
      const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
      await waitFor(() => expect(result.current.recent).toHaveLength(1))
      await act(async () => { await result.current.discardRecent('conv-old') })
      expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations/conv-old', { method: 'DELETE' })
      expect(result.current.recent).toEqual([])
    })

    it('repairSnapshot posts the repair and stays busy on 202; 409 nothing_to_repair toasts and unblocks', async () => {
      const { toast } = await import('sonner')
      mockFetch({
        '/api/blueprint/conversations/conv-1/repair-snapshot': { status: 202, body: { accepted: true, kind: 'invalid_json' } },
        '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
      })
      const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
      await openConversation(result)
      act(() => {
        lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: '', blueprint: null, snapshot: { status: 'rejected', reason: 'invalid_json', detail: 'x' } })
      })
      await act(async () => { await result.current.repairSnapshot() })
      expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations/conv-1/repair-snapshot', { method: 'POST' })
      expect(result.current.busy).toBe(true)

      mockFetch({
        '/api/blueprint/conversations/conv-1/repair-snapshot': { status: 409, body: { error: 'nothing_to_repair' } },
        '/api/blueprint/conversations': { body: { conversation: { id: 'conv-1' } } },
      })
      act(() => {
        lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'ok', blueprint: blueprint(), snapshot: { status: 'accepted' } })
      })
      await act(async () => { await result.current.repairSnapshot() })
      expect(toast.info).toHaveBeenCalledWith('There is nothing to repair — keep talking with the Builder.')
      expect(result.current.busy).toBe(false)
    })
  })
})
