import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentProviderCatalog } from '../useAgentProviderCatalog'

const api = vi.hoisted(() => ({ getAgentModels: vi.fn() }))

vi.mock('../../../lib/agent-api', () => ({
  getAgentModels: api.getAgentModels,
}))

interface CatalogResponse {
  models: Array<{ value: string; label: string; default?: boolean }>
  efforts: string[]
  supportsImageInput: boolean
  customModelAliases: boolean
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAgentProviderCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('never exposes the previous provider catalog during an async switch', async () => {
    const claude = deferred<CatalogResponse>()
    const codex = deferred<CatalogResponse>()
    api.getAgentModels.mockImplementation((provider: string) => (
      provider === 'claude' ? claude.promise : codex.promise
    ))

    const { result, rerender } = renderHook(
      ({ provider }) => useAgentProviderCatalog(provider),
      { initialProps: { provider: 'claude' } },
    )

    expect(result.current).toMatchObject({ provider: 'claude', status: 'loading', models: [], efforts: [] })

    rerender({ provider: 'codex' })
    expect(result.current).toMatchObject({ provider: 'codex', status: 'loading', models: [], efforts: [] })

    await act(async () => {
      claude.resolve({
        models: [{ value: 'sonnet', label: 'Claude Sonnet', default: true }],
        efforts: ['low', 'medium', 'high'],
        supportsImageInput: true,
        customModelAliases: false,
      })
      await claude.promise
    })
    expect(result.current).toMatchObject({ provider: 'codex', status: 'loading', models: [], efforts: [] })

    await act(async () => {
      codex.resolve({
        models: [{ value: 'gpt-5.5', label: 'GPT-5.5', default: true }],
        efforts: ['minimal', 'low', 'medium', 'high'],
        supportsImageInput: true,
        customModelAliases: false,
      })
      await codex.promise
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current).toMatchObject({
      provider: 'codex',
      models: [{ value: 'gpt-5.5', label: 'GPT-5.5', default: true }],
      efforts: ['minimal', 'low', 'medium', 'high'],
      customModelAliases: false,
    })
    expect(api.getAgentModels).toHaveBeenCalledTimes(2)
  })

  it('fails closed with an explicit error state and no stale choices', async () => {
    api.getAgentModels.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useAgentProviderCatalog('claude'))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.models).toEqual([])
    expect(result.current.efforts).toEqual([])
  })

  it('exposes the server-owned custom-alias capability for Kimi', async () => {
    api.getAgentModels.mockResolvedValue({
      models: [{ value: 'k3', label: 'Kimi K3', default: true }],
      efforts: ['low', 'high', 'max'],
      supportsImageInput: true,
      customModelAliases: true,
    })
    const { result } = renderHook(() => useAgentProviderCatalog('kimi'))

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.customModelAliases).toBe(true)
  })
})
