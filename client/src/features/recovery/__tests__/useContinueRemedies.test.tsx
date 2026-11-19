import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '../../../test-utils'
import { toast } from 'sonner'
import { useContinueRemedies } from '../hooks/useContinueRemedies'
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
})
