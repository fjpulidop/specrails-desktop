import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WsMessage } from './types'

const mocks = vi.hoisted(() => ({
  assemble: vi.fn(),
}))

vi.mock('./offline-assemble', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./offline-assemble')>()
  return { ...actual, assembleProjectOffline: mocks.assemble }
})

import { SetupManager } from './setup-manager'

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('SetupManager.startSilentAssemble', () => {
  let broadcasts: WsMessage[]
  let manager: SetupManager

  beforeEach(() => {
    mocks.assemble.mockReset()
    broadcasts = []
    manager = new SetupManager((msg) => broadcasts.push(msg))
  })

  it('emits per-provider progress events and records failures for retry', async () => {
    mocks.assemble.mockImplementation(async (opts: {
      providers: string[]
      onProviderStart?: (p: string) => void
      onProviderResult?: (r: { provider: string; ok: boolean; error?: string }) => void
    }) => {
      const results = []
      for (const p of opts.providers) {
        opts.onProviderStart?.(p)
        const ok = p !== 'codex'
        const r = { provider: p, ok, ...(ok ? {} : { error: 'boom' }) }
        opts.onProviderResult?.(r)
        results.push(r)
      }
      return results
    })

    manager.startSilentAssemble('proj-1', '/tmp/repo', 'my-app', ['claude', 'codex'])
    await flush()
    await flush()

    const progress = broadcasts.filter((b) => (b as { type?: string }).type === 'project.assemble_progress') as Array<Record<string, unknown>>
    expect(progress.map((p) => [p.provider, p.status])).toEqual([
      ['claude', 'running'],
      ['claude', 'done'],
      ['codex', 'running'],
      ['codex', 'failed'],
    ])
    expect(progress.every((p) => p.projectId === 'proj-1')).toBe(true)
    expect(manager.silentAssembleState('proj-1')).toEqual({ running: false, failed: ['codex'] })
  })

  it('is a no-op while a run is in flight', async () => {
    let release: () => void = () => {}
    mocks.assemble.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve([{ provider: 'claude', ok: true }])
      }),
    )
    manager.startSilentAssemble('proj-1', '/tmp/repo', 'my-app', ['claude'])
    manager.startSilentAssemble('proj-1', '/tmp/repo', 'my-app', ['claude'])
    expect(mocks.assemble).toHaveBeenCalledTimes(1)
    release()
    await flush()
    expect(manager.silentAssembleState('proj-1').running).toBe(false)
  })

  it('a terminal assemble error marks every provider failed', async () => {
    mocks.assemble.mockRejectedValue(new Error('workspace never appeared'))
    manager.startSilentAssemble('proj-1', '/tmp/repo', 'my-app', ['claude', 'gemini'])
    await flush()
    await flush()
    expect(manager.silentAssembleState('proj-1').failed).toEqual(['claude', 'gemini'])
    const failed = broadcasts.filter(
      (b) => (b as { type?: string; status?: string }).type === 'project.assemble_progress'
        && (b as { status?: string }).status === 'failed',
    )
    expect(failed).toHaveLength(2)
  })

  it('unknown providers are filtered; empty list is a no-op', () => {
    manager.startSilentAssemble('proj-1', '/tmp/repo', 'my-app', ['turbofake'])
    expect(mocks.assemble).not.toHaveBeenCalled()
    expect(manager.silentAssembleState('proj-1').running).toBe(false)
  })
})
