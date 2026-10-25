import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveStore, EMPTY_LIVE, type LiveStore } from '../live-store'

describe('live store', () => {
  let store: LiveStore
  beforeEach(() => { vi.useFakeTimers(); store = createLiveStore() })
  afterEach(() => { store.dispose(); vi.useRealTimers() })

  it('flips the streaming flag on the first token and folds the text in once per frame', () => {
    store.setForeground('a')
    const structural = vi.fn()
    const own = vi.fn()
    store.subscribe(structural)
    store.subscribeId('a', own)
    store.appendStream('a', 'Hel')
    expect(store.snapshot().get('a')).toMatchObject({ isStreaming: true, streamingText: '' })
    expect(structural).toHaveBeenCalledTimes(1)
    for (const token of ['lo', ' ', 'world']) store.appendStream('a', token)
    expect(own).toHaveBeenCalledTimes(1) // buffered: nothing yet
    vi.advanceTimersByTime(100)
    expect(store.snapshot().get('a')?.streamingText).toBe('Hello world')
    expect(own).toHaveBeenCalledTimes(2) // one flush for four tokens
    expect(structural).toHaveBeenCalledTimes(1) // text-only changes never wake aggregates
  })

  it('never loses or reorders tokens around a state transition', () => {
    store.setForeground('a')
    store.appendStream('a', 'one ')
    store.appendStream('a', 'two ')
    store.patch('a', (p) => ({ ...p, liveTools: [{ id: 't1', tool: 'bash' }] }))
    expect(store.get('a')?.streamingText).toBe('one two ')
    store.appendStream('a', 'three')
    store.patch('a', (p) => ({ ...EMPTY_LIVE, turnTools: p.liveTools })) // settle
    expect(store.get('a')).toMatchObject({ isStreaming: false, streamingText: '', turnTools: [{ id: 't1' }] })
    vi.advanceTimersByTime(1000)
    expect(store.snapshot().get('a')?.streamingText).toBe('') // the settled turn is not resurrected by a late flush
  })

  it('throttles missions out of view and flushes them when they come into view', () => {
    store.setForeground('a')
    const own = vi.fn()
    store.subscribeId('b', own)
    store.appendStream('b', 'x')
    store.appendStream('b', 'y')
    vi.advanceTimersByTime(200)
    expect(store.snapshot().get('b')?.streamingText).toBe('') // still buffered
    store.setForeground('b')
    expect(store.snapshot().get('b')?.streamingText).toBe('xy')
    vi.advanceTimersByTime(1000)
    expect(store.snapshot().get('b')?.streamingText).toBe('xy')
  })

  it('flushes background text at a low cadence even if never viewed', () => {
    store.appendStream('c', 'bg')
    vi.advanceTimersByTime(600)
    expect(store.snapshot().get('c')?.streamingText).toBe('bg')
  })

  it('drops an idle slice and keeps the snapshot immutable', () => {
    store.patch('a', (p) => ({ ...p, queued: [{ queueId: 'q', text: 'later' }] }))
    const before = store.snapshot()
    expect(before.get('a')?.queued).toHaveLength(1)
    store.patch('a', () => null)
    expect(store.snapshot().has('a')).toBe(false)
    expect(before.has('a')).toBe(true)
  })

  it('flush() folds every buffer and dispose() stops the timers', () => {
    store.appendStream('a', '1')
    store.appendStream('b', '2')
    store.flush()
    expect(store.snapshot().get('a')?.streamingText).toBe('1')
    expect(store.snapshot().get('b')?.streamingText).toBe('2')
    store.appendStream('a', '3')
    store.dispose()
    vi.advanceTimersByTime(2000)
    expect(store.snapshot().get('a')?.streamingText).toBe('1')
  })
})
