import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DECIDE_TIMEOUT_MS, decideTour, resetStartupQueueForTests, setGroupToast, startupQueue, whenIdle } from '../startup-queue'

beforeEach(() => { vi.useFakeTimers(); resetStartupQueueForTests() })
afterEach(() => { resetStartupQueueForTests(); vi.useRealTimers(); document.body.innerHTML = '' })

const snapshot = () => startupQueue.getSnapshot()

describe('startup queue: launch order', () => {
  it('the tour waits for the crash and resume reports and shows on a clean launch', () => {
    const stop = startupQueue.subscribe(() => {})
    expect(decideTour(snapshot())).toBe('pending')
    startupQueue.report('crash', false)
    expect(decideTour(snapshot())).toBe('pending')
    startupQueue.report('resume', false)
    expect(decideTour(snapshot())).toBe('show')
    stop()
  })

  it('a crash or resume offers defer the tour to the next clean launch', () => {
    startupQueue.report('crash', true)
    expect(decideTour(snapshot())).toBe('defer')
    resetStartupQueueForTests()
    startupQueue.report('crash', false)
    startupQueue.report('resume', true)
    expect(decideTour(snapshot())).toBe('defer')
  })

  it('never opens the tour over another startup modal', () => {
    startupQueue.report('crash', false)
    startupQueue.report('resume', false)
    const release = startupQueue.hold('resume')
    expect(decideTour(snapshot())).toBe('pending')
    release()
    expect(decideTour(snapshot())).toBe('show')
  })

  it('decides without a missing report after the timeout (an unreachable server never blocks it)', () => {
    const stop = startupQueue.subscribe(() => {})
    startupQueue.report('resume', false)
    vi.advanceTimersByTime(DECIDE_TIMEOUT_MS)
    expect(decideTour(snapshot())).toBe('show')
    stop()
  })
})

describe('startup queue: attention toasts', () => {
  it('shows at once when nothing holds the queue', () => {
    const show = vi.fn()
    startupQueue.deliver(show)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('holds toasts while a startup modal is open; one arrives as itself', () => {
    const show = vi.fn()
    const release = startupQueue.hold('resume')
    startupQueue.deliver(show)
    expect(show).not.toHaveBeenCalled()
    release()
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('several held toasts arrive grouped as one', () => {
    const group = vi.fn()
    setGroupToast(group)
    const singles = [vi.fn(), vi.fn(), vi.fn()]
    const release = startupQueue.hold('tour')
    singles.forEach((show) => startupQueue.deliver(show))
    release()
    expect(group).toHaveBeenCalledWith(3, expect.any(Array))
    singles.forEach((show) => expect(show).not.toHaveBeenCalled())
  })

  it('waits for the last of two holds and ignores a double release', () => {
    const show = vi.fn()
    const resume = startupQueue.hold('resume')
    const tour = startupQueue.hold('tour')
    startupQueue.deliver(show)
    resume(); resume()
    expect(show).not.toHaveBeenCalled()
    tour()
    expect(show).toHaveBeenCalledTimes(1)
  })
})

describe('whenIdle (update card gate)', () => {
  it('resolves after a quiet period without input or dialogs', async () => {
    const done = vi.fn()
    void whenIdle(new AbortController().signal, 3_000).then(done)
    vi.advanceTimersByTime(2_000)
    window.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(2_000)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
  })

  it('never resolves while a dialog is open or the queue is held', async () => {
    const done = vi.fn()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    void whenIdle(new AbortController().signal, 2_000).then(done)
    vi.advanceTimersByTime(10_000)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    dialog.remove()
    const release = startupQueue.hold('resume')
    vi.advanceTimersByTime(10_000)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    release()
    vi.advanceTimersByTime(3_000)
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
  })

  it('a hidden dialog does not count, and abort rejects', async () => {
    const hidden = document.createElement('div')
    hidden.setAttribute('role', 'dialog')
    hidden.hidden = true
    document.body.append(hidden)
    const done = vi.fn()
    void whenIdle(new AbortController().signal, 1_000).then(done)
    vi.advanceTimersByTime(2_000)
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    const controller = new AbortController()
    const pending = whenIdle(controller.signal, 1_000)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
  })
})
