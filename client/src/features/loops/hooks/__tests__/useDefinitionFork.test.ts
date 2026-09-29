import { act, renderHook } from '@testing-library/react'
import { createElement, StrictMode, type PropsWithChildren } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDefinitionFork } from '../useDefinitionFork'
import type { LoopStepSegment } from '../../components/loop-log/loop-log-model'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../projects/lib/project-repositories', () => ({ repositoryApiBase: (id: string) => `/api/projects/${id}` }))
const attempt = { meta: { nodePath: 'reviews/read', scopeId: 'branch', iteration: 2 } } as LoopStepSegment
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response
afterEach(() => vi.unstubAllGlobals())
it('remains usable after StrictMode remounts its effects', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ loopRunId: 'child' }))
  vi.stubGlobal('fetch', fetch)
  const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children)
  const { result } = renderHook(() => useDefinitionFork('source', 'p'), { wrapper })
  await act(() => result.current.fork(attempt))
  expect(result.current.created).toBe('child')
  expect(result.current.busy).toBe(false)
})
it('creates the exact scoped fork and reuses a pending server request after acknowledgement loss', async () => {
  const pending = { requestId: 'saved-request', fromNodePath: 'reviews/read', scopeId: 'branch', visit: 2 }
  const fetch = vi.fn().mockResolvedValueOnce(reply({ forkRequest: pending })).mockResolvedValueOnce(reply({ loopRunId: 'child' }))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useDefinitionFork('source', 'p'))
  await act(() => result.current.fork(attempt))
  expect(fetch).toHaveBeenLastCalledWith('/api/projects/p/loop-runs/source/fork', expect.objectContaining({ body: JSON.stringify(pending) }))
  expect(result.current.created).toBe('child')
})
it('does not create a second child when a prior request was already adopted', async () => {
  const fetch = vi.fn().mockResolvedValue(reply({ forkAdopted: true, forkRunId: 'existing-child' }))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useDefinitionFork('source', 'p'))
  await act(() => result.current.fork(attempt))
  expect(fetch).toHaveBeenCalledOnce()
  expect(result.current.created).toBe('existing-child')
})
it('fences duplicate clicks and drops a late response after changing projects', async () => {
  let finish!: (value: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetch)
  const { result, rerender } = renderHook(({ project }) => useDefinitionFork('source', project), { initialProps: { project: 'p' } })
  let task!: Promise<void>
  act(() => { task = result.current.fork(attempt); void result.current.fork(attempt) })
  expect(fetch).toHaveBeenCalledOnce()
  rerender({ project: 'other' })
  await act(async () => { finish(reply({})); await task })
  expect(fetch).toHaveBeenCalledOnce()
  expect(result.current.created).toBeNull()
})
it('preserves an unrelated pending cut instead of changing its idempotency request', async () => {
  const fetch = vi.fn().mockResolvedValue(reply({ forkRequest: { requestId: 'saved', fromNodePath: 'other', scopeId: 'branch', visit: 2 } }))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useDefinitionFork('source', 'p'))
  await act(() => result.current.fork(attempt))
  expect(fetch).toHaveBeenCalledOnce()
  expect(result.current.error).toBe('loopExplorer.forkPending')
})
