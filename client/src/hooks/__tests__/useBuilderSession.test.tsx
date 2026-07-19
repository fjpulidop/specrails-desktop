import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useBuilderSession, SURPRISE_ME_PROMPT } from '../useBuilderSession'
import { SharedWebSocketContext } from '../useSharedWebSocket'
import { coerceBlueprint, type Blueprint } from '../../lib/blueprint-draft'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
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

  it('bootstraps a conversation and registers the WS handler when enabled', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations', expect.objectContaining({ method: 'POST' }))
    expect(wsValue.registerHandler).toHaveBeenCalled()
    expect(result.current.phase).toBe('chat')
    expect(result.current.showSurpriseMe).toBe(true)
  })

  it('blueprint.done stores the snapshot and enables the commit CTA; dirty flips', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    expect(result.current.dirty).toBe(false)
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'Plan.', blueprint: blueprint() })
    })
    expect(result.current.blueprint?.product.name).toBe('Recipely')
    expect(result.current.canProposeCommit).toBe(true)
    expect(result.current.dirty).toBe(true)
    expect(result.current.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Plan.' })
  })

  it('keeps a partial or shallow generation out of the commit flow', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    const partial = blueprint()
    partial.specsComplete = false
    partial.m1Specs = [{ ...partial.m1Specs[0], description: 'Initialize the app.' }]
    act(() => {
      lastHandler()({ type: 'blueprint.done', conversationId: 'conv-1', fullText: 'Partial.', blueprint: partial })
    })
    expect(result.current.canProposeCommit).toBe(false)
    expect(result.current.specQualityDetail).toBe('Generation is not complete yet.')
  })

  it('keeps raw invalid model fields uncommittable and submits them without laundering defaults', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
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
    expect(result.current.specQualityDetail).toContain('valid priority')

    act(() => result.current.submitCommit({
      name: 'Raw payload', location: '/tmp/raw-payload', providers: ['claude'], createGithubRepo: false,
    }))
    await waitFor(() => expect(requestBodyFor('/api/blueprint/commit')).toBeDefined())
    const body = requestBodyFor('/api/blueprint/commit') as { blueprint: { m1Specs: Array<Record<string, unknown>> } }
    expect(body.blueprint.m1Specs[1]).toMatchObject({ priority: 'urgent', dependsOnIndex: -1 })
  })

  it('surpriseMe sends the fixed prompt', async () => {
    const { result } = renderHook(() => useBuilderSession(true, { onFinished: vi.fn() }), { wrapper })
    await waitFor(() => expect(result.current.conversationReady).toBe(true))
    act(() => result.current.surpriseMe())
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: SURPRISE_ME_PROMPT })
    expect(global.fetch).toHaveBeenCalledWith('/api/blueprint/conversations/conv-1/send', expect.anything())
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
    expect(requestBodyFor('/send')).toEqual({ text: 'gemini turn' })
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
  })
})
