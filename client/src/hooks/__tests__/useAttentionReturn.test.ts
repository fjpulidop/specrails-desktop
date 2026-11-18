import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const toastFn = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastFn }))

import { RETURN_SETTLE_MS, useAttentionReturn } from '../useAttentionReturn'
import type { AttentionCenter, AwayEntry } from '../../lib/attention/attention-center'
import { OPEN_INBOX_EVENT } from '../../lib/inbox-events'

function centerWith(entries: AwayEntry[]): AttentionCenter {
  let pending = entries
  return { dispatch: vi.fn(), forget: vi.fn(), takeAway: () => { const out = pending; pending = []; return out } }
}

function focusBack(): void {
  act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(RETURN_SETTLE_MS) })
}

describe('useAttentionReturn (back from away)', () => {
  beforeEach(() => { vi.useFakeTimers(); toastFn.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  it('one thing: the toast opens it directly', () => {
    const open = vi.fn()
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a', open }])))
    focusBack()
    expect(toastFn).toHaveBeenCalledOnce()
    const [title, options] = toastFn.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(title).toBe('1 thing needs you')
    expect(options.action.label).toBe('Open')
    options.action.onClick()
    expect(open).toHaveBeenCalledOnce()
  })

  it('several things: the toast opens the inbox', () => {
    const opened = vi.fn()
    window.addEventListener(OPEN_INBOX_EVENT, opened)
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a', open: vi.fn() }, { key: 'b' }, { key: 'c' }])))
    focusBack()
    const [title, options] = toastFn.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(title).toBe('3 things need you')
    expect(options.action.label).toBe('Open inbox')
    options.action.onClick()
    window.removeEventListener(OPEN_INBOX_EVENT, opened)
    expect(opened).toHaveBeenCalledOnce()
  })

  it('a single entry without a place still offers the inbox', () => {
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a' }])))
    focusBack()
    expect((toastFn.mock.calls[0][1] as { action: { label: string } }).action.label).toBe('Open inbox')
  })

  it('nothing announced while away: no toast; a second return does not repeat the summary', () => {
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a' }])))
    focusBack()
    focusBack()
    expect(toastFn).toHaveBeenCalledOnce()
    toastFn.mockClear()
    renderHook(() => useAttentionReturn(centerWith([])))
    focusBack()
    expect(toastFn).not.toHaveBeenCalled()
  })
})
