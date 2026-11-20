import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '../../../test-utils'
import { toast } from 'sonner'
import { useContinueRemedies, useProviderSwitchContinue, useResolutionActions } from '../hooks/useContinueRemedies'
import type { FailureDiagnosis } from '../lib/failure-diagnosis'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const notify = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/notify-error', () => ({ notifyError: notify }))

const envBlocker: FailureDiagnosis = { kind: 'environment', confidence: 'high', phase: 'baseline', rounds: null, resetAt: null, detail: 'APP_KEY', resumablePhase: null, blocker: null, source: 'core', remedies: ['copy-env-files', 'continue', 'fix-environment'] }

describe('useContinueRemedies: copy-env-files', () => {
  let bodies: unknown[]
  let reply: { status: number; body: unknown }
  beforeEach(() => {
    vi.clearAllMocks()
    bodies = []
    reply = { status: 201, body: { loopRunId: 'child', remedy: 'continue', fromStep: 'baseline', envFilesEnabled: true, envFilesCopied: ['.env'] } }
    global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
  })

  it('is offered only when the server ranked it, and posts the remedy', async () => {
    const onContinued = vi.fn()
    const { result } = renderHook(() => useContinueRemedies('p', 'run', envBlocker, { enabled: true, onContinued }))
    expect(result.current['copy-env-files']).toBeTruthy()
    act(() => result.current['copy-env-files']!.run())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied .env into the run. Continuing.'))
    expect(bodies).toEqual([{ remedy: 'copy-env-files' }])
    expect(onContinued).toHaveBeenCalledWith('child')
    const plain = renderHook(() => useContinueRemedies('p', 'run', { ...envBlocker, remedies: ['continue'] }, { enabled: true }))
    expect(plain.result.current['copy-env-files']).toBeUndefined()
  })

  it('says plainly when the project has no .env to copy', async () => {
    reply = { status: 409, body: { error: 'env_files_unavailable', detail: 'x' } }
    const { result } = renderHook(() => useContinueRemedies('p', 'run', envBlocker, { enabled: true }))
    act(() => result.current['copy-env-files']!.run())
    await waitFor(() => expect(notify).toHaveBeenCalledWith('This project has no .env file to copy. Create it in your checkout, then try again.'))
  })

  it('picking a resolution posts its id (or the instruction) and says which choice the run continues with', async () => {
    const onContinued = vi.fn()
    const { result } = renderHook(() => useResolutionActions('p', 'run', { enabled: true, onContinued }))
    act(() => result.current!.choose('deterministic-close', 'Make the close tests deterministic'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Continuing with: Make the close tests deterministic'))
    expect(bodies).toEqual([{ remedy: 'continue', optionId: 'deterministic-close' }])
    expect(onContinued).toHaveBeenCalledWith('child')
    await waitFor(() => expect(result.current!.done).toBe(true))
    // Spent: a second click sends nothing.
    act(() => result.current!.instruct('again'))
    expect(bodies).toHaveLength(1)
    const own = renderHook(() => useResolutionActions('p', 'run-2', { enabled: true }))
    act(() => own.result.current!.instruct('  Use a fake clock  '))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Continuing with your instruction.'))
    expect(bodies[1]).toEqual({ remedy: 'continue', instruction: 'Use a fake clock' })
    expect(renderHook(() => useResolutionActions('p', 'run', { enabled: false })).result.current).toBeNull()
  })
})

describe('useProviderSwitchContinue: a run that settled on a usage limit', () => {
  const offer = { providerId: 'codex', roles: ['developer', 'fixer'], targets: [{ provider: 'claude', model: 'haiku', effort: 'low' }] }
  let bodies: unknown[]
  beforeEach(() => {
    vi.clearAllMocks()
    bodies = []
    global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ loopRunId: 'child', remedy: 'continue', mode: 'fork', fromStep: 'fixer', resumed: true, provider: 'claude' }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
  })

  it('continues as the next attempt with the chosen route (and the AI option it came from), once', async () => {
    const onContinued = vi.fn()
    const { result } = renderHook(() => useProviderSwitchContinue('p', 'run', offer, { enabled: true, onContinued }))
    act(() => result.current!.continueWith({ provider: 'claude', model: 'haiku', effort: 'low', remember: true }, 'switch-provider'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Continuing with Claude'))
    expect(bodies).toEqual([{ remedy: 'continue', switch: { provider: 'claude', model: 'haiku', effort: 'low', remember: true }, optionId: 'switch-provider' }])
    expect(onContinued).toHaveBeenCalledWith('child')
    expect(result.current!.done).toBe(true)
    act(() => result.current!.continueWith({ provider: 'claude', model: 'haiku' }))
    expect(bodies).toHaveLength(1)
  })

  it('is absent without an offer or where the surface cannot continue the run', () => {
    expect(renderHook(() => useProviderSwitchContinue('p', 'run', null, { enabled: true })).result.current).toBeNull()
    expect(renderHook(() => useProviderSwitchContinue('p', 'run', offer, { enabled: false })).result.current).toBeNull()
  })
})
