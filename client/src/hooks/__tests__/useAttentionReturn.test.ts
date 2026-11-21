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

async function focusBack(): Promise<void> {
  await act(async () => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(RETURN_SETTLE_MS); await Promise.resolve(); await Promise.resolve() })
}

describe('useAttentionReturn (back from away)', () => {
  beforeEach(() => { vi.useFakeTimers(); toastFn.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  it('says nothing about what is already on screen (the mission that asked is open in front)', async () => {
    const focus = async () => ({ appFocused: true, label: 'main' })
    renderHook(() => useAttentionReturn(centerWith([{ key: 'seen', open: vi.fn(), isOnScreen: () => true }]), focus))
    await focusBack()
    expect(toastFn).not.toHaveBeenCalled()
  })

  it('counts only what is not on screen', async () => {
    const focus = async () => ({ appFocused: true, label: 'main' })
    const elsewhere = vi.fn()
    renderHook(() => useAttentionReturn(centerWith([
      { key: 'seen', isOnScreen: () => true, copy: { kind: 'question', project: 'Alpha', subject: 'Seen' } },
      { key: 'other', open: elsewhere, isOnScreen: () => false, copy: { kind: 'review', project: 'Tetrisex', subject: '#12' } },
    ]), focus))
    await focusBack()
    const [title, options] = toastFn.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(title).toBe('Tetrisex · #12 is ready for review')
    expect(options.action.label).toBe('Review')
    options.action.onClick()
    expect(elsewhere).toHaveBeenCalledOnce()
  })

  it('one thing: the toast names it, offers its own action and opens it directly', async () => {
    const open = vi.fn()
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a', open, copy: { kind: 'question', project: 'Generala Dorada', subject: '#6' } }])))
    await focusBack()
    expect(toastFn).toHaveBeenCalledOnce()
    const [title, options] = toastFn.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(title).toBe('Generala Dorada · #6 is waiting for your answer')
    expect(options.action.label).toBe('Answer')
    options.action.onClick()
    expect(open).toHaveBeenCalledOnce()
  })

  it('several things: the toast opens the inbox', async () => {
    const opened = vi.fn()
    window.addEventListener(OPEN_INBOX_EVENT, opened)
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a', open: vi.fn() }, { key: 'b' }, { key: 'c' }])))
    await focusBack()
    const [title, options] = toastFn.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(title).toBe('3 pending items')
    expect(options.action.label).toBe('Open inbox')
    options.action.onClick()
    window.removeEventListener(OPEN_INBOX_EVENT, opened)
    expect(opened).toHaveBeenCalledOnce()
  })

  it('one thing without wording falls back to its own title', async () => {
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a', open: vi.fn(), title: 'Run seems stuck' }])))
    await focusBack()
    const [title, options] = toastFn.mock.calls[0] as [string, { action: { label: string } }]
    expect(title).toBe('Run seems stuck')
    expect(options.action.label).toBe('Open')
  })

  it('several questions and reviews are summarized by kind', async () => {
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a', copy: { kind: 'question' } }, { key: 'b', copy: { kind: 'question' } }, { key: 'c', copy: { kind: 'review' } }])))
    await focusBack()
    expect(toastFn.mock.calls[0][0]).toBe('2 questions and 1 review pending')
  })

  it('a single entry without a place still offers the inbox', async () => {
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a' }])))
    await focusBack()
    expect((toastFn.mock.calls[0][1] as { action: { label: string } }).action.label).toBe('Open inbox')
  })

  it('nothing announced while away: no toast; a second return does not repeat the summary', async () => {
    renderHook(() => useAttentionReturn(centerWith([{ key: 'a' }])))
    await focusBack()
    await focusBack()
    expect(toastFn).toHaveBeenCalledOnce()
    toastFn.mockClear()
    renderHook(() => useAttentionReturn(centerWith([])))
    await focusBack()
    expect(toastFn).not.toHaveBeenCalled()
  })
})
