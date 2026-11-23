import { publishMissionScreen } from '../../../lib/attention/mission-screen'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import {
  ANNOUNCED_KEY, SEEN_KEY, attentionCategoryOf, inboxItemKey, isUnseen, markSeen, markUnseen, planAnnouncements, readAnnounced,
  readSeenMarks, unseenCount, writeSeenMarks, type InboxItem,
} from '../lib/inbox-model'
import { inboxAttentionCopy, inboxAttentionText, inboxItemOnScreen, useInboxAttention } from '../hooks/useInboxAttention'
import type { AttentionCenter, AttentionEvent } from '../../../lib/attention/attention-center'

const DAY = 24 * 60 * 60 * 1000
const mk = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'p1:review:d1', projectId: 'p1', projectName: 'Alpha', kind: 'review', title: 'Add login', detail: null,
  at: new Date().toISOString(), version: 'on_review', action: 'open-review', subjectId: 'd1', conversationId: 'c1', diagnosis: null, cap: null, ...over,
})

beforeEach(() => localStorage.clear())

describe('unseen model', () => {
  it('a version is unseen until marked; a new version is unseen again', () => {
    const item = mk()
    let marks = markSeen({}, [item], 1_000)
    expect(isUnseen(item, marks)).toBe(false)
    expect(isUnseen({ ...item, version: 'pr_ready' }, marks)).toBe(true)
    marks = markUnseen(marks, item)
    expect(isUnseen(item, marks)).toBe(true)
  })

  it('markSeen keeps the object when nothing changes, and renews an old mark of an item still there', () => {
    const item = mk()
    const marks = markSeen({}, [item], 1_000)
    expect(markSeen(marks, [item], 2_000)).toBe(marks)
    expect(markSeen(marks, [item], 1_000 + 8 * DAY)[item.id].at).toBe(1_000 + 8 * DAY)
  })

  it('persists per viewer and prunes marks older than 30 days', () => {
    const now = Date.now()
    writeSeenMarks({ a: { version: 'v', at: now }, old: { version: 'v', at: now - 31 * DAY } })
    expect(Object.keys(readSeenMarks(now))).toEqual(['a'])
    localStorage.setItem(SEEN_KEY, 'not json')
    expect(readSeenMarks(now)).toEqual({})
  })

  it('the badge number leaves out muted projects', () => {
    const items = [mk(), mk({ id: 'p2:q', projectId: 'p2' })]
    expect(unseenCount(items, {})).toBe(2)
    expect(unseenCount(items, {}, ['p2'])).toBe(1)
    expect(unseenCount(items, markSeen({}, items, 1))).toBe(0)
  })
})

describe('announcements plan', () => {
  const a = mk({ id: 'a' })
  const b = mk({ id: 'b' })

  it('the first snapshot after startup is recorded silently', () => {
    const { announce, ledger } = planAnnouncements({}, [a, b], [a, b], true, 1)
    expect(announce).toEqual([])
    expect(Object.keys(ledger)).toEqual([inboxItemKey(a), inboxItemKey(b)])
  })

  it('afterwards each new key is announced once; a new version counts as new', () => {
    const seeded = planAnnouncements({}, [a], [a], true, 1).ledger
    const second = planAnnouncements(seeded, [a, b], [a, b], false, 2)
    expect(second.announce).toEqual([b])
    expect(planAnnouncements(second.ledger, [a, b], [a, b], false, 3).announce).toEqual([])
    const bumped = { ...a, version: 'pr_ready' }
    expect(planAnnouncements(second.ledger, [bumped, b], [bumped, b], false, 4).announce).toEqual([bumped])
  })

  it('a snoozed / done new key is recorded but not announced', () => {
    const { announce, ledger } = planAnnouncements({}, [a], [], false, 1)
    expect(announce).toEqual([])
    expect(inboxItemKey(a) in ledger).toBe(true)
  })

  it('returns the same ledger object when nothing changes', () => {
    const ledger = planAnnouncements({}, [a], [a], true, 1).ledger
    expect(planAnnouncements(ledger, [a], [a], false, 2).ledger).toBe(ledger)
  })
})

describe('attention category of an item', () => {
  it('maps kinds; a provider-limit block is a spending signal', () => {
    expect(attentionCategoryOf(mk({ kind: 'question' }))).toBe('question')
    expect(attentionCategoryOf(mk({ kind: 'review' }))).toBe('review')
    expect(attentionCategoryOf(mk({ kind: 'budget' }))).toBe('budget')
    expect(attentionCategoryOf(mk({ kind: 'failed' }))).toBe('failed')
    expect(attentionCategoryOf(mk({ kind: 'jira' }))).toBe('failed')
    expect(attentionCategoryOf(mk({ kind: 'blocked', diagnosis: { kind: 'environment' } as never }))).toBe('failed')
    expect(attentionCategoryOf(mk({ kind: 'blocked', diagnosis: { kind: 'provider_limit' } as never }))).toBe('budget')
  })
})

describe('inbox item text and place', () => {
  it('names the kind, the project, the item and the plain cause', () => {
    expect(inboxAttentionText(mk())).toEqual({ title: 'Review ready', body: 'Alpha · Add login' })
    const blocked = mk({ kind: 'blocked', action: 'resume-run', title: 'Implement', diagnosis: { kind: 'provider_limit', confidence: 'high', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, source: 'desktop', remedies: [] } })
    const text = inboxAttentionText(blocked)
    expect(text.title).toBe('Blocked')
    expect(text.body.startsWith('Alpha · Implement · ')).toBe(true)
    expect(text.body.length).toBeGreaterThan('Alpha · Implement · '.length)
  })

  it('words the return toast by what the item is: kind, project and title', () => {
    expect(inboxAttentionCopy(mk())).toEqual({ kind: 'review', project: 'Alpha', subject: 'Add login' })
    expect(inboxAttentionCopy(mk({ kind: 'question' })).kind).toBe('question')
    expect(inboxAttentionCopy(mk({ kind: 'question', question: { kind: 'approval' } as never })).kind).toBe('approval')
    expect(inboxAttentionCopy(mk({ kind: 'failed' })).kind).toBe('stopped')
    expect(inboxAttentionCopy(mk({ kind: 'blocked', detail: 'held:restart:implement' })).kind).toBe('stopped')
    // Only a provider limit or the budget reads "paused by a limit"; the person's own Pause says so.
    expect(inboxAttentionCopy(mk({ kind: 'blocked', detail: 'held:paused' })).kind).toBe('held')
    expect(inboxAttentionCopy(mk({ kind: 'blocked', detail: 'held:pausedByYou' })).kind).toBe('pausedByYou')
    expect(inboxAttentionCopy(mk({ kind: 'blocked', detail: 'held:pausedByYou:developer' })).kind).toBe('pausedByYou')
    expect(inboxAttentionCopy(mk({ kind: 'blocked', diagnosis: { kind: 'provider_limit' } as never })).kind).toBe('paused')
    expect(inboxAttentionCopy(mk({ kind: 'jira' })).kind).toBe('generic')
    // A reached cap is about the project's spending, not one spec.
    const cap = { scope: 'project', period: 'day', budgetUsd: 5, spentUsd: 5.1, resetsAt: '' } as const
    expect(inboxAttentionCopy(mk({ kind: 'budget', action: 'raise-cap', cap }))).toEqual({ kind: 'paused', project: 'Alpha', subject: null })
  })

  it('on screen when the inbox is open or the item\'s own place is shown', () => {
    const item = mk()
    expect(inboxItemOnScreen(item, { pathname: '/', search: '?inbox=1' }, 'agent')).toBe(true)
    expect(inboxItemOnScreen(item, { pathname: '/', search: '?mission=c1&review=d1' }, 'agent')).toBe(true)
    expect(inboxItemOnScreen(item, { pathname: '/', search: '?review=other' }, 'agent')).toBe(false)
    expect(inboxItemOnScreen(item, { pathname: '/review/d1', search: '' }, 'kanban')).toBe(true)
    const run = mk({ kind: 'failed', action: 'open-run', subjectId: 'r1' })
    expect(inboxItemOnScreen(run, { pathname: '/jobs/r1', search: '' }, 'kanban')).toBe(true)
    expect(inboxItemOnScreen(mk({ action: 'resume-run' }), { pathname: '/', search: '' }, 'agent')).toBe(false)
  })
})

describe('useInboxAttention', () => {
  const ref = <T,>(current: T) => ({ current }) as MutableRefObject<T>

  function setup() {
    const events: AttentionEvent[] = []
    const center: AttentionCenter = { dispatch: vi.fn(async (event: AttentionEvent) => { events.push(event); return 'notify' as const }), takeAway: () => [], forget: vi.fn() }
    const open = vi.fn()
    const props = (snapshot: InboxItem[], visible = snapshot, status: 'loading' | 'ready' | 'error' = 'ready') => ({
      status, snapshot, visible, open, center, locationRef: ref({ pathname: '/', search: '' }), uiModeRef: ref<'kanban' | 'agent'>('agent'),
    })
    return { events, open, props }
  }

  it('seeds silently, then announces a new item once with its category, subject and way back', () => {
    const { events, open, props } = setup()
    const first = mk({ id: 'a' })
    const { rerender } = renderHook((p) => useInboxAttention(p), { initialProps: props([], [], 'loading') })
    rerender(props([first]))
    expect(events).toEqual([])
    const second = mk({ id: 'b', kind: 'question', action: 'open-run', subjectId: 'r9', title: 'Implement · #4', projectId: 'p2', projectName: 'Beta' })
    rerender(props([first, second]))
    rerender(props([first, second]))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ category: 'question', projectId: 'p2', subjectKey: 'question:run:r9', title: 'Awaiting your response', body: 'Beta · Implement · #4', copy: { kind: 'question', project: 'Beta', subject: 'Implement · #4' } })
    events[0].open?.()
    expect(open).toHaveBeenCalledWith(second)
    expect(JSON.parse(localStorage.getItem(ANNOUNCED_KEY)!)).toHaveProperty([inboxItemKey(second)])
  })

  it('a restart (a new session) never announces what was already there', () => {
    const first = setup()
    const a = mk({ id: 'a' })
    const b = mk({ id: 'b' })
    const view = renderHook((p) => useInboxAttention(p), { initialProps: first.props([a]) })
    view.rerender(first.props([a, b]))
    expect(first.events).toHaveLength(1)
    view.unmount()
    const next = setup()
    const c = mk({ id: 'c' })
    renderHook((p) => useInboxAttention(p), { initialProps: next.props([a, b, c]) })
    expect(next.events).toEqual([])
    expect(Object.keys(readAnnounced())).toContain(inboxItemKey(c))
  })

  it('an item whose mission is in front of the person (main window or its own window) is on screen', () => {
    const { events, props } = setup()
    const { rerender } = renderHook((p) => useInboxAttention(p), { initialProps: props([]) })
    rerender(props([mk({ id: 'q', kind: 'question', action: 'open-run', subjectId: 'r1', conversationId: 'm1' })]))
    const event = events[0]
    publishMissionScreen({ uiMode: 'agent', pathname: '/', activeId: 'm2', primaryVisible: true, splitIds: [], chatOpen: false, detached: new Map([['m1', 'mission-m1']]) })
    expect(event.isOnScreen?.({ appFocused: true, label: 'mission-m1' })).toBe(true)
    expect(event.isOnScreen?.({ appFocused: true, label: 'main' })).toBe(false)
    publishMissionScreen({ uiMode: 'agent', pathname: '/', activeId: 'm1', primaryVisible: true, splitIds: [], chatOpen: false, detached: new Map() })
    expect(event.isOnScreen?.({ appFocused: true, label: 'main' })).toBe(true)
    publishMissionScreen(null)
  })

  it('an item answered or dismissed since is forgotten for the return toast', () => {
    const { props } = setup()
    const center = props([]).center
    const a = mk({ id: 'a' }), b = mk({ id: 'b' })
    const { rerender } = renderHook((p) => useInboxAttention(p), { initialProps: props([a, b]) })
    rerender(props([a, b], [a]))
    expect(center.forget).toHaveBeenCalledWith(`inbox:${inboxItemKey(b)}`)
    expect(center.forget).not.toHaveBeenCalledWith(`inbox:${inboxItemKey(a)}`)
  })
})
