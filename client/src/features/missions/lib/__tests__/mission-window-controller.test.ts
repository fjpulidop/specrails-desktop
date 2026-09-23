import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { MissionWindowController } from '../mission-window-controller'
import type { MissionWindowBridge, MissionWindowEvent, MissionWindowSnapshot, MissionWindowTransfer } from '../mission-windows'
import { __clearComposerDrafts, captureComposerDraft, composerDrafts, persistComposerDraft, restoreComposerDraft } from '../agent-composer-drafts'

const snapshot = (text = 'implementemos #1'): MissionWindowSnapshot => ({
  version: 1, projectId: 'p1', conversationId: 'c1', capturedAt: 1,
  composer: { text, references: text.includes('#1') ? [{ key: 'r1', start: 14, end: 16, chip: { id: '1', kind: 'spec', label: 'Spec', token: '#1', projectId: 'p1' } }] : [], attachments: [{ id: 'a1', filename: 'picture.png', storedName: 'a.png', mimeType: 'image/png', size: 20, addedAt: '2026-01-01' }] },
  scroll: { top: 120, atBottom: false }, workspace: { codePaneOpen: true, jobsPaneOpen: false, analyticsPaneOpen: false, browserOpen: true, pendingCaptures: [], browserOwnerId: 'owner-1', browserUrl: 'http://localhost:3000/' },
})
const transfer = (state: MissionWindowTransfer['state'] = 'opening', revision = 1): MissionWindowTransfer => ({ windowLabel: 'mission-1', conversationId: 'c1', projectId: 'p1', revision, state, snapshot: snapshot() })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
function fixture(initial: MissionWindowTransfer | null = null, secondary = !!initial) {
  let receive: ((event: MissionWindowEvent) => void) | undefined
  const bridge = {
    supported: vi.fn(async () => true), list: vi.fn(async () => initial ? [initial] : []),
    current: vi.fn(async (_label?: string) => initial), detach: vi.fn(async () => transfer()),
    ready: vi.fn(async () => transfer('detached')), attach: vi.fn(async () => transfer('attaching', 2)),
    ack: vi.fn(async () => transfer('attaching', 2)), cancel: vi.fn(async () => {}),
    focus: vi.fn(async () => true), discard: vi.fn(async () => {}),
    listen: vi.fn(async (callback: (event: MissionWindowEvent) => void) => { receive = callback; return vi.fn() }),
  } satisfies MissionWindowBridge
  const controller = new MissionWindowController(bridge, secondary)
  controllers.push(controller)
  return { bridge, controller, emit: (kind: MissionWindowEvent['kind'], value = transfer(), error?: string, registered = true) => receive?.({ kind, transfer: value, error, registered }) }
}
const controllers: MissionWindowController[] = []
afterEach(() => { controllers.splice(0).forEach(c => c.stop()); __clearComposerDrafts() })

describe('mission window acknowledged ownership', () => {
  it('preserves browser-only editing without importing/listening to a native host', async () => {
    const { bridge, controller } = fixture()
    bridge.supported.mockResolvedValue(false)
    await controller.start()
    expect(controller.isEditable('c1')).toBe(true)
    expect(await controller.detach('p1', 'c1')).toBe(false)
    expect(bridge.listen).not.toHaveBeenCalled()
  })

  it('freezes before capture, coalesces repeated detach clicks, and focuses an existing mission', async () => {
    const { bridge, controller, emit } = fixture()
    const capture = deferred<MissionWindowSnapshot>()
    controller.registerHandlers({ capture: () => capture.promise, restore: vi.fn() })
    await controller.start()
    const first = controller.detach('p1', 'c1')
    expect(controller.isEditable('c1')).toBe(false)
    expect(controller.detach('p1', 'c1')).toBe(first)
    capture.resolve(snapshot())
    expect(await first).toBe(true)
    expect(bridge.detach).toHaveBeenCalledTimes(1)
    expect(controller.isEditable('c1')).toBe(false)
    emit('detached', transfer('detached'))
    expect(controller.isPending('c1')).toBe(false)
    expect(controller.isEditable('c1')).toBe(false)
    expect(await controller.detach('p1', 'c1')).toBe(true)
    expect(bridge.focus).toHaveBeenCalledWith('c1')
    expect(captureComposerDraft('c1')).toEqual(snapshot().composer)
  })

  it('keeps the draft and editable source when opening fails, including oversized snapshots', async () => {
    const { bridge, controller } = fixture()
    restoreComposerDraft('c1', snapshot().composer)
    controller.registerHandlers({ capture: () => snapshot('x'.repeat(2_100_000)), restore: vi.fn() })
    await controller.start()
    expect(await controller.detach('p1', 'c1')).toBe(false)
    expect(bridge.detach).not.toHaveBeenCalled()
    expect(controller.isEditable('c1')).toBe(true)
    expect(captureComposerDraft('c1')).toEqual(snapshot().composer)
    controller.registerHandlers({ capture: () => snapshot(), restore: vi.fn() })
    bridge.detach.mockRejectedValueOnce(new Error('Could not create window'))
    expect(await controller.detach('p1', 'c1')).toBe(false)
    expect(controller.getSnapshot().error).toContain('Could not create')
    expect(controller.isEditable('c1')).toBe(true)
  })

  it('exposes the child identity before its binder is ready and only acknowledges an actual restored view', async () => {
    const { bridge, controller, emit } = fixture(transfer())
    await controller.start()
    expect(controller.getSnapshot().current?.conversationId).toBe('c1')
    expect(controller.isEditable('c1')).toBe(false)
    expect(bridge.ready).not.toHaveBeenCalled()
    const restored = deferred<void>()
    const restore = vi.fn(() => restored.promise)
    controller.registerHandlers({ capture: () => snapshot(), restore })
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    expect(bridge.ready).not.toHaveBeenCalled()
    restored.resolve()
    await waitFor(() => expect(bridge.ready).toHaveBeenCalledWith(1))
    emit('detached', transfer('detached'))
    await waitFor(() => expect(controller.isEditable('c1')).toBe(true))
    expect(restore).toHaveBeenCalledTimes(1)
    expect(controller.isEditable('another-mission')).toBe(false)
  })

  it('reintegrates with current refs/attachments only after main restore commits', async () => {
    const { bridge, controller, emit } = fixture()
    const restored = deferred<void>()
    controller.registerHandlers({ capture: () => snapshot(), restore: () => restored.promise })
    await controller.start()
    emit('attaching', transfer('attaching', 2))
    expect(controller.isEditable('c1')).toBe(false)
    expect(bridge.ack).not.toHaveBeenCalled()
    restored.resolve()
    await waitFor(() => expect(bridge.ack).toHaveBeenCalledWith('mission-1', 2))
    await waitFor(() => expect(controller.isEditable('c1')).toBe(true))
    expect(captureComposerDraft('c1')).toEqual(snapshot().composer)
    emit('opening', transfer('opening', 1))
    emit('attaching', transfer('attaching', 2))
    expect(controller.getSnapshot().transfers).toEqual([])
  })

  it('cancels failed destination hydration and leaves its source recoverable', async () => {
    const { bridge, controller } = fixture(transfer())
    controller.registerHandlers({ capture: () => snapshot(), restore: async () => { throw new Error('Backend unavailable') } })
    await controller.start()
    await waitFor(() => expect(bridge.cancel).toHaveBeenCalledWith('mission-1', 1))
    expect(bridge.ready).not.toHaveBeenCalled()
    expect(captureComposerDraft('c1')).toEqual(snapshot().composer)
    expect(controller.getSnapshot().error).toBe('Backend unavailable')
  })

  it('aborts a stale restoration and never acknowledges after a newer rollback revision', async () => {
    const { bridge, controller, emit } = fixture()
    const restored = deferred<void>()
    const restore = vi.fn((_snapshot, _target, _signal: AbortSignal) => restored.promise)
    controller.registerHandlers({ capture: () => snapshot(), restore })
    await controller.start()
    emit('attaching', transfer('attaching', 2))
    emit('failed', transfer('detached', 3), 'Timed out')
    expect(restore.mock.calls[0][2].aborted).toBe(true)
    restored.resolve()
    await Promise.resolve(); await Promise.resolve()
    expect(bridge.ack).not.toHaveBeenCalled()
    expect(controller.getSnapshot().transfers[0].revision).toBe(3)
    expect(controller.isEditable('c1')).toBe(false)
  })

  it('restores a reloaded child from its newer session draft without replaying the old native draft', async () => {
    composerDrafts.set('c1', 'newer unsent work'); persistComposerDraft('c1'); composerDrafts.clear()
    const { bridge, controller } = fixture(transfer('detached'))
    const restore = vi.fn(async () => {})
    controller.registerHandlers({ capture: () => snapshot(), restore })
    await controller.start()
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    expect(restore.mock.calls[0]?.[0]).toMatchObject({ composer: { text: 'newer unsent work' } })
    expect(bridge.ready).not.toHaveBeenCalled()
  })

  it('retries a failed detached reload only when focus or an explicit refresh asks it to reconcile again', async () => {
    const { bridge, controller, emit } = fixture(transfer('detached'))
    const restore = vi.fn().mockRejectedValueOnce(new Error('Temporary conversation outage')).mockResolvedValue(undefined)
    controller.registerHandlers({ capture: () => snapshot(), restore })
    await controller.start()
    await waitFor(() => expect(controller.getSnapshot().error).toContain('Temporary conversation outage'))
    expect(restore).toHaveBeenCalledTimes(1)
    expect(bridge.cancel).not.toHaveBeenCalled()
    emit('detached', transfer('detached'))
    await Promise.resolve(); await Promise.resolve()
    expect(restore).toHaveBeenCalledTimes(1)

    await controller.refresh()
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(controller.isEditable('c1')).toBe(true))
    expect(bridge.ready).not.toHaveBeenCalled()
    expect(bridge.ack).not.toHaveBeenCalled()
    expect(bridge.cancel).not.toHaveBeenCalled()
    await controller.refresh()
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('restores a retained child after browser rollback with a new revision and its latest local input', async () => {
    const { controller, emit } = fixture(transfer('detached'))
    const restore = vi.fn(async () => {})
    controller.registerHandlers({ capture: () => snapshot(), restore })
    await controller.start()
    await waitFor(() => expect(controller.isEditable('c1')).toBe(true))
    composerDrafts.set('c1', 'input preserved in source window')
    emit('failed', transfer('detached', 3), 'Browser returned to its source window', true)
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
    expect(restore.mock.calls[1]?.[0]).toMatchObject({ composer: { text: 'input preserved in source window' }, workspace: { browserOwnerId: 'owner-1' } })
    await waitFor(() => expect(controller.isEditable('c1')).toBe(true))
  })

  it('reconciles a main reload during attaching by loading its full native snapshot', async () => {
    const { bridge, controller } = fixture(null, false)
    bridge.list.mockResolvedValue([{ ...transfer('attaching', 2), snapshot: null }])
    bridge.current.mockImplementation(async label => label ? transfer('attaching', 2) : null)
    controller.registerHandlers({ capture: () => snapshot(), restore: async () => {} })
    await controller.start()
    await waitFor(() => expect(bridge.ack).toHaveBeenCalledWith('mission-1', 2))
    expect(bridge.current).toHaveBeenCalledWith('mission-1')
  })

  it('does not regress detached state when an older opening IPC response arrives with the same revision', async () => {
    const { bridge, controller, emit } = fixture()
    const opening = deferred<MissionWindowTransfer>()
    bridge.detach.mockReturnValue(opening.promise)
    controller.registerHandlers({ capture: () => snapshot(), restore: async () => {} })
    await controller.start()
    const pending = controller.detach('p1', 'c1')
    await Promise.resolve(); await Promise.resolve()
    emit('detached', transfer('detached'))
    opening.resolve(transfer())
    await pending
    expect(controller.getSnapshot().transfers[0].state).toBe('detached')
    expect(controller.isPending('c1')).toBe(false)
  })

  it('captures the latest child state on native close and keeps other missions independent', async () => {
    const { bridge, controller, emit } = fixture(transfer('detached'))
    controller.registerHandlers({ capture: () => snapshot('edited in separate window'), restore: async () => {} })
    await controller.start()
    await waitFor(() => expect(controller.isEditable('c1')).toBe(true))
    emit('detached', { ...transfer('detached'), windowLabel: 'mission-2', conversationId: 'c2' })
    emit('attach-requested', transfer('detached'))
    await waitFor(() => expect(bridge.attach).toHaveBeenCalledTimes(1))
    expect(bridge.attach.mock.calls[0]?.[0]).toMatchObject({ composer: { text: 'edited in separate window' } })
    expect(controller.getSnapshot().transfers.some(t => t.conversationId === 'c2')).toBe(true)
  })

  it('discards a deleted conversation without rehydrating it or leaving its window draft', async () => {
    const { bridge, controller } = fixture(transfer('detached'), false)
    bridge.current.mockResolvedValue(null)
    restoreComposerDraft('c1', snapshot().composer)
    const restore = vi.fn(async () => {})
    controller.registerHandlers({ capture: () => snapshot(), restore })
    await controller.start()
    expect(await controller.discard('c1')).toBe(true)
    expect(bridge.discard).toHaveBeenCalledWith('c1')
    expect(restore).not.toHaveBeenCalled()
    expect(composerDrafts.has('c1')).toBe(false)
    expect(controller.getSnapshot().transfers).toEqual([])
  })

  it('does not lose events which arrive while a registry refresh is in flight', async () => {
    const { bridge, controller, emit } = fixture()
    await controller.start()
    const listed = deferred<MissionWindowTransfer[]>()
    bridge.list.mockReturnValueOnce(listed.promise)
    const refreshing = controller.refresh()
    emit('opening', transfer())
    listed.resolve([])
    await refreshing
    expect(controller.getSnapshot().transfers).toHaveLength(1)
  })

  it('retains ownership if browser rollback fails, but recovers a destroyed window without a ghost placeholder', async () => {
    const { controller, emit } = fixture()
    const recover = vi.fn()
    controller.registerHandlers({ capture: () => snapshot(), restore: async () => {}, recover })
    await controller.start()
    emit('opening', transfer())
    emit('failed', transfer(), 'Browser cannot return', true)
    expect(controller.isEditable('c1')).toBe(false)
    expect(controller.getSnapshot().transfers).toHaveLength(1)
    emit('detached', transfer('detached'))
    const last = transfer('detached'); last.snapshot = snapshot('recover after OS close')
    emit('failed', last, 'Window closed unexpectedly', false)
    expect(controller.isEditable('c1')).toBe(true)
    expect(controller.getSnapshot().transfers).toEqual([])
    expect(captureComposerDraft('c1').text).toBe('recover after OS close')
    expect(recover).toHaveBeenCalledWith(last.snapshot, last)
    composerDrafts.set('c1', 'new text in the integrated view')
    emit('failed', last, 'Duplicate close frame', false)
    expect(captureComposerDraft('c1').text).toBe('new text in the integrated view')
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('does not allow a second editor when initial registry hydration fails', async () => {
    const { bridge, controller } = fixture()
    bridge.list.mockRejectedValueOnce(new Error('IPC unavailable'))
    await controller.start()
    expect(controller.getSnapshot().initialized).toBe(true)
    expect(controller.isEditable('c1')).toBe(false)
    await controller.refresh()
    expect(controller.isEditable('c1')).toBe(true)
  })

  it('does not reopen a deleted mission when a delayed capture finishes', async () => {
    const { bridge, controller } = fixture()
    const captured = deferred<MissionWindowSnapshot>()
    controller.registerHandlers({ capture: () => captured.promise, restore: async () => {} })
    await controller.start()
    const opening = controller.detach('p1', 'c1')
    await controller.discard('c1')
    captured.resolve(snapshot())
    expect(await opening).toBe(false)
    expect(bridge.detach).not.toHaveBeenCalled()
    expect(composerDrafts.has('c1')).toBe(false)
  })

  it('serializes two simultaneous reintegrations until each actual view commit has been acknowledged', async () => {
    const { controller, bridge, emit } = fixture()
    const first = deferred<void>(), second = deferred<void>()
    const restore = vi.fn((_snapshot, target) => target.conversationId === 'c1' ? first.promise : second.promise)
    controller.registerHandlers({ capture: () => snapshot(), restore })
    const one = transfer('attaching', 2)
    const two = { ...transfer('attaching', 3), windowLabel: 'mission-2', conversationId: 'c2', snapshot: { ...snapshot('second draft'), conversationId: 'c2' } }
    bridge.ack.mockImplementation(async label => label === 'mission-1' ? one : two)
    await controller.start()
    emit('attaching', one)
    emit('attaching', two)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(bridge.ack).not.toHaveBeenCalled()
    first.resolve()
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
    expect(bridge.ack).toHaveBeenCalledTimes(1)
    expect(bridge.ack).toHaveBeenNthCalledWith(1, 'mission-1', 2)
    second.resolve()
    await waitFor(() => expect(bridge.ack).toHaveBeenNthCalledWith(2, 'mission-2', 3))
    expect(captureComposerDraft('c1').text).toBe('implementemos #1')
    expect(captureComposerDraft('c2').text).toBe('second draft')
    await waitFor(() => expect(controller.getSnapshot().transfers).toEqual([]))
  })

  it('advances to the next waiting mission when the first restoration is cancelled', async () => {
    const { controller, bridge, emit } = fixture()
    const restore = vi.fn((_snapshot, target, signal: AbortSignal) => target.conversationId === 'c1'
      ? new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))))
      : Promise.resolve())
    controller.registerHandlers({ capture: () => snapshot(), restore })
    const two = { ...transfer('attaching', 3), windowLabel: 'mission-2', conversationId: 'c2', snapshot: { ...snapshot(), conversationId: 'c2' } }
    bridge.ack.mockResolvedValue(two)
    await controller.start()
    emit('attaching', transfer('attaching', 2))
    emit('attaching', two)
    emit('failed', transfer('detached', 4), 'First mission cancelled', true)
    await waitFor(() => expect(bridge.ack).toHaveBeenCalledWith('mission-2', 3))
    expect(bridge.ack).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().transfers[0].state).toBe('detached')
  })
})
