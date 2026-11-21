import { describe, expect, it, vi } from 'vitest'
import { SUBJECT_WINDOW_MS, createAttentionCenter, type AttentionCenterDeps, type AttentionEvent } from '../attention-center'
import { DEFAULT_ATTENTION_PREFS, type AttentionPrefs } from '../attention-policy'
import type { WindowFocus } from '../window-focus'

function setup(over: { prefs?: Partial<AttentionPrefs>; focus?: WindowFocus; shown?: boolean } = {}) {
  let now = 1_000_000
  const state = {
    prefs: { ...structuredClone(DEFAULT_ATTENTION_PREFS), ...over.prefs },
    focus: over.focus ?? { appFocused: false, label: null },
  }
  const deps = {
    prefs: vi.fn(async () => state.prefs),
    focus: vi.fn(async () => state.focus),
    notify: vi.fn(async () => over.shown ?? true),
    toast: vi.fn(),
    now: () => now,
    burstMs: 0,
    summary: (count: number, lines: string[]) => ({ title: `${count} things`, body: lines.join(' | '), tag: 'attention:summary' }),
  } satisfies AttentionCenterDeps
  return { center: createAttentionCenter(deps), deps, state, advance: (ms: number) => { now += ms } }
}

function setupDeps(): AttentionCenterDeps {
  return {
    prefs: async () => structuredClone(DEFAULT_ATTENTION_PREFS),
    focus: async () => ({ appFocused: false, label: null }),
    notify: async () => true,
    toast: vi.fn(),
    burstMs: 0,
  }
}

const event = (over: Partial<AttentionEvent> = {}): AttentionEvent => ({
  key: 'inbox:a', category: 'review', projectId: 'p1', title: 'Review ready', body: 'Alpha · Add login', ...over,
})

describe('attention center', () => {
  it('coalesces a burst of more than two OS notifications into one summary', async () => {
    const { center, deps } = setup({ prefs: { sound: true } })
    const decisions = await Promise.all(['a', 'b', 'c'].map((key) => center.dispatch(event({ key: `inbox:${key}`, body: `B-${key}` }))))
    expect(decisions).toEqual(['notify', 'notify', 'notify'])
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '3 things', body: 'B-a | B-b | B-c', sound: true }))
    expect(center.takeAway().map((entry) => entry.key)).toEqual(['inbox:a', 'inbox:b', 'inbox:c'])
  })

  it('a burst summary and the away entries carry each event\'s wording', async () => {
    const summary = vi.fn((count: number) => ({ title: `${count} things`, body: '', tag: 'attention:summary' }))
    const copy = { kind: 'review' as const, project: 'Alpha', subject: 'Add login' }
    const center = createAttentionCenter({ ...setupDeps(), summary })
    await Promise.all(['a', 'b', 'c'].map((key) => center.dispatch(event({ key: `inbox:${key}`, copy: key === 'b' ? undefined : copy }))))
    expect(summary).toHaveBeenCalledWith(3, expect.any(Array), [copy, undefined, copy])
    expect(center.takeAway().map((entry) => entry.copy)).toEqual([copy, undefined, copy])
  })

  it('keeps two notifications of one burst separate', async () => {
    const { center, deps } = setup()
    await Promise.all(['a', 'b'].map((key) => center.dispatch(event({ key: `inbox:${key}` }))))
    expect(deps.notify).toHaveBeenCalledTimes(2)
  })

  it('away: an OS notification with the sound pref, remembered for the return toast', async () => {
    const { center, deps } = setup({ prefs: { sound: true } })
    const open = vi.fn()
    expect(await center.dispatch(event({ open }))).toBe('notify')
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Review ready', body: 'Alpha · Add login', tag: 'inbox:a', sound: true }))
    const away = center.takeAway()
    expect(away).toEqual([{ key: 'inbox:a', open, title: 'Review ready' }])
    expect(center.takeAway()).toEqual([])
  })

  it('announces one key once', async () => {
    const { center, deps } = setup()
    await center.dispatch(event())
    expect(await center.dispatch(event())).toBe('skip')
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('two copies arriving together are announced once', async () => {
    const { center, deps } = setup()
    await Promise.all([center.dispatch(event()), center.dispatch(event())])
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('one subject from two sources is announced once within the window, again after it', async () => {
    const { center, deps, advance } = setup()
    await center.dispatch(event({ key: 'job-stuck:r1', subjectKey: 'failed:run:r1', category: 'failed' }))
    expect(await center.dispatch(event({ key: 'inbox:r1:v1', subjectKey: 'failed:run:r1', category: 'failed' }))).toBe('skip')
    advance(SUBJECT_WINDOW_MS + 1)
    expect(await center.dispatch(event({ key: 'inbox:r1:v2', subjectKey: 'failed:run:r1', category: 'failed' }))).toBe('notify')
    expect(deps.notify).toHaveBeenCalledTimes(2)
  })

  it('a skipped event does not hold its subject (a later source may still announce it)', async () => {
    const { center, state } = setup({ prefs: { enabled: false } })
    await center.dispatch(event({ key: 'a', subjectKey: 's' }))
    state.prefs.enabled = true
    expect(await center.dispatch(event({ key: 'b', subjectKey: 's' }))).toBe('notify')
  })

  it('focused elsewhere: the default toast, or the event\'s own in-app form; nothing remembered', async () => {
    const { center, deps } = setup({ focus: { appFocused: true, label: 'main' } })
    expect(await center.dispatch(event())).toBe('toast')
    expect(deps.toast).toHaveBeenCalledWith(expect.objectContaining({ key: 'inbox:a' }))
    const inAppToast = vi.fn()
    await center.dispatch(event({ key: 'b', inAppToast }))
    expect(inAppToast).toHaveBeenCalledOnce()
    expect(deps.notify).not.toHaveBeenCalled()
    expect(center.takeAway()).toEqual([])
  })

  it('focused on its place: nothing; isOnScreen is only asked when the app has the focus', async () => {
    const isOnScreen = vi.fn(() => true)
    const focused = setup({ focus: { appFocused: true, label: 'main' } })
    expect(await focused.center.dispatch(event({ isOnScreen }))).toBe('skip')
    expect(isOnScreen).toHaveBeenCalledWith({ appFocused: true, label: 'main' })
    isOnScreen.mockClear()
    const awayCenter = setup()
    expect(await awayCenter.center.dispatch(event({ isOnScreen }))).toBe('notify')
    expect(isOnScreen).not.toHaveBeenCalled()
  })

  it('a browser notification click forgets its away entry and opens the item', async () => {
    const { center, deps } = setup()
    const open = vi.fn()
    await center.dispatch(event({ open }))
    const [{ onClick }] = deps.notify.mock.calls[0] as unknown as [{ onClick: () => void }]
    onClick()
    expect(open).toHaveBeenCalledOnce()
    expect(center.takeAway()).toEqual([])
  })

  it('a refused OS notification still reaches the person: remembered when away, a toast when focused', async () => {
    const awayCenter = setup({ shown: false })
    await awayCenter.center.dispatch(event())
    expect(awayCenter.center.takeAway()).toHaveLength(1)
    const focused = setup({ shown: false, focus: { appFocused: true, label: 'main' } })
    await focused.center.dispatch(event({ persistent: true, category: 'failed' }))
    expect(focused.deps.toast).toHaveBeenCalledOnce()
  })
})
