import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttentionPrefsStore } from '../attention-prefs-store'
import { DEFAULT_ATTENTION_PREFS, LEGACY_OS_NOTIFICATION_KEY } from '../attention-policy'

type Call = { url: string; init?: RequestInit }

function server(initial: Record<string, unknown> = {}) {
  let record: Record<string, unknown> = { ...structuredClone(DEFAULT_ATTENTION_PREFS), ...initial }
  const calls: Call[] = []
  let failPatch = false
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (init?.method === 'PATCH') {
      if (failPatch) return { ok: false, status: 400, json: async () => ({}) }
      const patch = JSON.parse(String(init.body))
      record = { ...record, ...patch, categories: { ...(record.categories as object), ...(patch.categories ?? {}) } }
    }
    return { ok: true, status: 200, json: async () => record }
  })
  const store = createAttentionPrefsStore(() => fetchImpl as unknown as typeof fetch, () => '/api/attention-prefs')
  return { store, calls, fetchImpl, failNextPatch: () => { failPatch = true } }
}

describe('attention prefs store', () => {
  beforeEach(() => localStorage.clear())

  it('starts from the defaults and reads the server once (concurrent callers share the read)', async () => {
    const { store, fetchImpl } = server({ sound: true })
    expect(store.get()).toEqual(DEFAULT_ATTENTION_PREFS)
    expect(store.loaded()).toBe(false)
    const [a, b] = await Promise.all([store.ready(), store.ready()])
    expect(a.sound).toBe(true)
    expect(b).toBe(a)
    expect(store.loaded()).toBe(true)
    await store.ready()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('an unreachable server keeps the defaults (never silences the app)', async () => {
    const store = createAttentionPrefsStore(() => (async () => { throw new Error('offline') }) as unknown as typeof fetch, () => '/x')
    expect(await store.ready()).toEqual(DEFAULT_ATTENTION_PREFS)
    expect(store.loaded()).toBe(true)
  })

  it('updates optimistically, then takes the server\'s record; notifies subscribers', async () => {
    const { store, calls } = server()
    await store.ready()
    const listener = vi.fn()
    store.subscribe(listener)
    const pending = store.update({ categories: { done: false } })
    expect(store.get().categories.done).toBe(false)
    await pending
    expect(calls.at(-1)).toMatchObject({ init: { method: 'PATCH', body: JSON.stringify({ categories: { done: false } }) } })
    expect(store.get().categories.done).toBe(false)
    expect(listener).toHaveBeenCalled()
  })

  it('reverts and rethrows when the server refuses', async () => {
    const { store, failNextPatch } = server()
    await store.ready()
    failNextPatch()
    await expect(store.update({ sound: true })).rejects.toThrow('HTTP 400')
    expect(store.get().sound).toBe(false)
  })

  it('applies a record pushed by the server', () => {
    const { store } = server()
    store.apply({ ...DEFAULT_ATTENTION_PREFS, mutedProjects: ['p9'] })
    expect(store.get().mutedProjects).toEqual(['p9'])
    expect(store.loaded()).toBe(true)
  })

  it('migrates the legacy localStorage prefs once, then drops the key', async () => {
    localStorage.setItem(LEGACY_OS_NOTIFICATION_KEY, JSON.stringify({ enabled: true, filter: 'completed' }))
    const { store, calls } = server()
    const prefs = await store.ready()
    expect(prefs.categories).toMatchObject({ failed: false, budget: false, done: true })
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1)
    expect(localStorage.getItem(LEGACY_OS_NOTIFICATION_KEY)).toBeNull()
    await store.refresh()
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1)
  })

  it('defaults in the legacy key need no PATCH, the key still goes', async () => {
    localStorage.setItem(LEGACY_OS_NOTIFICATION_KEY, JSON.stringify({ enabled: true, filter: 'all' }))
    const { store, calls } = server()
    await store.ready()
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false)
    expect(localStorage.getItem(LEGACY_OS_NOTIFICATION_KEY)).toBeNull()
  })
})
