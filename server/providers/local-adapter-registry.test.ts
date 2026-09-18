import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { register, hasAdapter, listAdapters, getAdapter, _clearForTests, unregisterAdapter, isLocalAdapterId, adapterKind } from './registry'
import { syncLocalAdapters, isLocalEnginesEnabled, listLocalAdapters, listLocalConnections } from './local-adapter-registry'
import { claudeAdapter } from './claude-adapter'

const local = { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:8080/v1' }
const lan = { id: 'lan-box', kind: 'openai-compatible' as const, baseUrl: 'http://10.0.0.2:8000/v1', rates: { inputPer1M: 0.1, outputPer1M: 0.4 } }

describe('registry.unregisterAdapter', () => {
  beforeEach(() => { _clearForTests(); register(claudeAdapter) })

  it('removes only local adapters; CLI adapters are never removed', () => {
    expect(unregisterAdapter('claude')).toBe(false)
    expect(hasAdapter('claude')).toBe(true)
    expect(unregisterAdapter('ghost')).toBe(false)
    syncLocalAdapters([local])
    expect(hasAdapter('local')).toBe(true)
    expect(isLocalAdapterId('local')).toBe(true)
    expect(isLocalAdapterId('claude')).toBe(false)
    expect(isLocalAdapterId(undefined)).toBe(false)
    expect(adapterKind('local')).toBe('local')
    expect(adapterKind('claude')).toBe('cli')
    expect(adapterKind('nope')).toBeNull()
    expect(unregisterAdapter('local')).toBe(true)
    expect(hasAdapter('local')).toBe(false)
  })

  it('lists CLI adapters first even when a local one registered earlier', () => {
    _clearForTests()
    syncLocalAdapters([local])
    register(claudeAdapter)
    expect(listAdapters().map((a) => a.id)).toEqual(['claude', 'local'])
  })
})

describe('syncLocalAdapters', () => {
  const prev = process.env.SPECRAILS_LOCAL_ENGINES
  beforeEach(() => { _clearForTests(); register(claudeAdapter); delete process.env.SPECRAILS_LOCAL_ENGINES })
  afterEach(() => { if (prev === undefined) delete process.env.SPECRAILS_LOCAL_ENGINES; else process.env.SPECRAILS_LOCAL_ENGINES = prev })

  it('registers, re-registers and unregisters to mirror the connections', () => {
    const first = syncLocalAdapters([{ id: 'claude', kind: 'cli' }, local])
    expect(first).toEqual({ registered: ['local'], unregistered: [], skipped: [] })
    const instance = getAdapter('local')
    const second = syncLocalAdapters([{ ...lan }])
    expect(second).toEqual({ registered: ['lan-box'], unregistered: ['local'], skipped: [] })
    expect(hasAdapter('local')).toBe(false)
    expect(hasAdapter('lan-box')).toBe(true)
    // The in-flight instance keeps working after removal.
    expect(instance.id).toBe('local')
    expect(listLocalConnections()).toEqual([lan])
    expect(listLocalAdapters().map((a) => a.id)).toEqual(['lan-box'])
    // A changed connection swaps the instance (new rates take effect on the next resolve).
    const before = getAdapter('lan-box')
    syncLocalAdapters([{ ...lan, label: 'renamed' }])
    expect(getAdapter('lan-box')).not.toBe(before)
    expect(getAdapter('lan-box').displayName).toBe('renamed')
  })

  it('skips ids that collide with a CLI adapter and ignores malformed entries', () => {
    const r = syncLocalAdapters([{ id: 'claude', kind: 'openai-compatible', baseUrl: 'http://x' } as never, { id: 'bad', kind: 'openai-compatible' } as never])
    expect(r.skipped).toEqual(['claude'])
    expect(r.registered).toEqual([])
    expect(adapterKind('claude')).toBe('cli')
  })

  it.each(['0', 'false', 'OFF', ' off '])('kill switch %j unregisters everything and registers nothing', (value) => {
    syncLocalAdapters([local])
    process.env.SPECRAILS_LOCAL_ENGINES = value
    expect(isLocalEnginesEnabled()).toBe(false)
    expect(syncLocalAdapters([local, lan])).toEqual({ registered: [], unregistered: ['local'], skipped: [] })
    expect(listAdapters().map((a) => a.id)).toEqual(['claude'])
  })

  it.each(['', '1', 'true', 'yes'])('kill switch %j keeps local engines on', (value) => {
    process.env.SPECRAILS_LOCAL_ENGINES = value
    expect(isLocalEnginesEnabled()).toBe(true)
  })
})
