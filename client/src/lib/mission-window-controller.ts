import {
  captureComposerDraft, clearComposerDraftRecovery, composerAttachmentDrafts, composerDrafts, composerReferenceDrafts,
  composerSubmissionIds, hasComposerDraft, persistComposerDraft, recoverComposerDraft, restoreComposerDraft,
} from './agent-composer-drafts'
import {
  validateMissionWindowSnapshot, type MissionWindowBridge, type MissionWindowEvent,
  type MissionWindowSnapshot, type MissionWindowTarget, type MissionWindowTransfer,
} from './mission-windows'

export interface MissionWindowHandlers {
  capture(target: MissionWindowTarget): MissionWindowSnapshot | Promise<MissionWindowSnapshot>
  /** Resolve only after the destination's actual React view has restored state. */
  restore(snapshot: MissionWindowSnapshot, target: MissionWindowTarget, signal: AbortSignal): Promise<void>
  /** Refresh an already-mounted integrated view after exceptional native closure. No ACK. */
  recover?(snapshot: MissionWindowSnapshot, target: MissionWindowTarget): void
}
export interface MissionWindowsState {
  available: boolean
  initialized: boolean
  current: MissionWindowTransfer | null
  transfers: MissionWindowTransfer[]
  pending: string[]
  error: string | null
}

/** One renderer's state machine. Native revisions, never renderer timing, own the mission. */
export class MissionWindowController {
  private state: MissionWindowsState = { available: false, initialized: false, current: null, transfers: [], pending: [], error: null }
  private listeners = new Set<() => void>()
  private handlers?: MissionWindowHandlers
  private unlisten?: () => void
  private startPromise?: Promise<void>
  private stopped = false
  private generation = 0
  private revisions = new Map<string, number>()
  private changes = new Map<string, number>()
  private closedRevisions = new Map<string, number>()
  private restores = new Set<string>()
  private restored = new Set<string>()
  private failedRestores = new Set<string>()
  private mainRestoreActive?: string
  private restoreAbort = new Map<string, { revision: number; controller: AbortController }>()
  private operations = new Map<string, Promise<boolean>>()
  private discarded = new Set<string>()
  private ownLabel?: string
  private ownershipKnown = false

  constructor(private bridge: MissionWindowBridge, private secondary = false, private native = true) {}
  getSnapshot = (): MissionWindowsState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private update(patch: Partial<MissionWindowsState>) {
    if (this.stopped) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private error(error: unknown) { this.update({ error: error instanceof Error ? error.message : String(error) }) }
  clearError = () => this.update({ error: null })
  private pending(id: string, value: boolean) {
    this.update({ pending: value ? [...new Set([...this.state.pending, id])] : this.state.pending.filter(existing => existing !== id) })
  }
  isPending = (id: string): boolean => this.state.pending.includes(id) || this.state.transfers.some(t => t.conversationId === id && t.state !== 'detached')
  isEditable = (id: string): boolean => {
    if (!this.state.initialized && this.native) return false
    if (!this.state.available) return !this.secondary
    if (!this.ownershipKnown) return false
    if (this.isPending(id)) return false
    if (this.secondary) return this.state.current?.conversationId === id && this.state.current.state === 'detached'
    return !this.state.transfers.some(t => t.conversationId === id)
  }

  registerHandlers = (handlers: MissionWindowHandlers): (() => void) => {
    this.handlers = handlers
    this.failedRestores.clear()
    this.restorePending()
    return () => { if (this.handlers === handlers) this.handlers = undefined }
  }

  start = (): Promise<void> => {
    if (this.startPromise) return this.startPromise
    this.stopped = false
    const generation = ++this.generation
    this.startPromise = (async () => {
      const available = await this.bridge.supported()
      if (this.stopped || generation !== this.generation) return
      this.update({ available })
      if (available) {
        const unlisten = await this.bridge.listen(this.onEvent)
        if (this.stopped || generation !== this.generation) { unlisten(); return }
        this.unlisten = unlisten
        await this.refresh()
      }
      if (generation === this.generation) this.update({ initialized: true })
    })().catch(error => { if (generation === this.generation) { this.error(error); this.update({ initialized: true }) } })
    return this.startPromise
  }

  stop = () => {
    this.stopped = true; this.generation++; this.unlisten?.(); this.unlisten = undefined; this.startPromise = undefined
    for (const job of this.restoreAbort.values()) job.controller.abort()
  }

  refresh = async (): Promise<void> => {
    if (!this.state.available || this.stopped) return
    const generation = this.generation
    const before = new Map(this.changes)
    try {
      const [entries, current] = await Promise.all([this.bridge.list(), this.bridge.current()])
      if (this.stopped || generation !== this.generation) return
      this.ownershipKnown = true
      if (current) { this.secondary = true; this.ownLabel = current.windowLabel }
      for (const entry of entries) this.merge(entry)
      if (current) this.merge(current)
      // Do not erase a transfer announced while this snapshot was in flight.
      const listed = new Set(entries.map(t => t.windowLabel))
      if (current) listed.add(current.windowLabel)
      this.update({ transfers: this.state.transfers.filter(t => listed.has(t.windowLabel) || this.changes.get(t.windowLabel) !== before.get(t.windowLabel)) })
      if (this.ownLabel) this.update({ current: this.state.transfers.find(t => t.windowLabel === this.ownLabel) ?? null })
      // A main renderer can reload while a secondary awaits its acknowledgement.
      for (const entry of this.state.transfers) {
        if (!this.secondary && entry.state === 'attaching' && !entry.snapshot) {
          const full = await this.bridge.current(entry.windowLabel)
          if (this.stopped || generation !== this.generation) return
          if (full) this.merge(full)
        }
      }
      this.failedRestores.clear()
      this.restorePending()
    } catch (error) { this.error(error) }
  }

  private merge(transfer: MissionWindowTransfer): boolean {
    if (this.stopped || !Number.isSafeInteger(transfer.revision) || transfer.revision < (this.revisions.get(transfer.windowLabel) ?? -1) || transfer.revision <= (this.closedRevisions.get(transfer.windowLabel) ?? -1)) return false
    const previous = this.state.transfers.find(t => t.windowLabel === transfer.windowLabel)
    const phase = { opening: 0, detached: 1, attaching: 2 }
    if (previous?.revision === transfer.revision && phase[previous.state] > phase[transfer.state]) return false
    const restoring = this.restoreAbort.get(transfer.windowLabel)
    if (restoring && restoring.revision !== transfer.revision) restoring.controller.abort()
    this.revisions.set(transfer.windowLabel, transfer.revision)
    this.changes.set(transfer.windowLabel, (this.changes.get(transfer.windowLabel) ?? 0) + 1)
    const next = { ...transfer, snapshot: transfer.snapshot ?? (previous?.revision === transfer.revision ? previous.snapshot : undefined) }
    this.update({
      transfers: [...this.state.transfers.filter(t => t.windowLabel !== transfer.windowLabel), next],
      ...(this.ownLabel === transfer.windowLabel ? { current: next } : {}),
    })
    return true
  }

  private remove(transfer: MissionWindowTransfer) {
    if (transfer.revision < (this.revisions.get(transfer.windowLabel) ?? -1)) return
    this.revisions.set(transfer.windowLabel, transfer.revision)
    this.changes.set(transfer.windowLabel, (this.changes.get(transfer.windowLabel) ?? 0) + 1)
    this.closedRevisions.set(transfer.windowLabel, transfer.revision)
    this.restoreAbort.get(transfer.windowLabel)?.controller.abort()
    this.update({ transfers: this.state.transfers.filter(t => t.windowLabel !== transfer.windowLabel), ...(this.ownLabel === transfer.windowLabel ? { current: null } : {}) })
  }

  private onEvent = (event: MissionWindowEvent) => {
    if (this.stopped) return
    const transfer = event.transfer
    if (transfer.revision < (this.revisions.get(transfer.windowLabel) ?? -1) || transfer.revision <= (this.closedRevisions.get(transfer.windowLabel) ?? -1)) return
    if (event.kind === 'failed' && event.registered === false && !this.secondary && transfer.snapshot) {
      try {
        const snapshot = validateMissionWindowSnapshot(transfer.snapshot, transfer)
        restoreComposerDraft(transfer.conversationId, snapshot.composer)
        this.handlers?.recover?.(snapshot, transfer)
      } catch { /* keep the previous recoverable draft */ }
    }
    if (event.kind === 'attached' || event.kind === 'discarded' || (event.kind === 'failed' && event.registered === false)) this.remove(transfer)
    else if (event.kind !== 'attach-requested') this.merge(transfer)
    if (event.kind === 'failed') {
      this.pending(transfer.conversationId, false)
      this.error(event.error ?? 'The mission window transfer failed. Your draft is preserved.')
      // Compatibility with an older host must also reconcile registry truth,
      // never guess that a failed browser rollback released ownership.
      if (event.registered === undefined) void this.refresh()
    }
    if (event.kind === 'discarded') { this.discarded.add(transfer.conversationId); this.clearDraft(transfer.conversationId) }
    if (event.kind === 'attach-requested' && this.ownLabel === transfer.windowLabel) void this.attach()
    this.restorePending()
  }

  private restorePending() {
    if (!this.handlers || this.stopped) return
    if (this.secondary) {
      const current = this.state.current
      if (current && (current.state === 'opening' || current.state === 'detached')) void this.restore(current, current.state === 'opening' ? 'ready' : 'reload')
    } else {
      // The integrated renderer has one active conversation. Restoring two
      // missions concurrently would replace its chat/commit while the first
      // destination is still waiting for React to acknowledge hydration.
      if (this.mainRestoreActive) return
      const next = this.state.transfers.find(transfer => {
        const key = `${transfer.windowLabel}:${transfer.revision}:ack`
        return transfer.state === 'attaching' && transfer.snapshot && !this.restored.has(key) && !this.failedRestores.has(key)
      })
      if (next) void this.restore(next, 'ack')
    }
  }

  private async restore(transfer: MissionWindowTransfer, action: 'ready' | 'ack' | 'reload') {
    const key = `${transfer.windowLabel}:${transfer.revision}:${action}`
    if (!this.handlers || this.restores.has(key) || this.restored.has(key) || this.failedRestores.has(key)) return
    if (action === 'reload' && this.restores.has(`${transfer.windowLabel}:${transfer.revision}:ready`)) return
    this.restores.add(key)
    if (action === 'ack') this.mainRestoreActive = key
    this.pending(transfer.conversationId, true)
    const handlers = this.handlers
    const abort = new AbortController()
    this.restoreAbort.set(transfer.windowLabel, { revision: transfer.revision, controller: abort })
    try {
      const snapshot = validateMissionWindowSnapshot(transfer.snapshot, transfer)
      if (action === 'reload') {
        recoverComposerDraft(transfer.conversationId)
        if (hasComposerDraft(transfer.conversationId)) snapshot.composer = captureComposerDraft(transfer.conversationId)
      }
      restoreComposerDraft(transfer.conversationId, snapshot.composer)
      await handlers.restore(snapshot, transfer, abort.signal)
      if (abort.signal.aborted || this.stopped || this.revisions.get(transfer.windowLabel) !== transfer.revision || this.closedRevisions.get(transfer.windowLabel) === transfer.revision) return
      if (action === 'ready') this.merge(await this.bridge.ready(transfer.revision))
      else if (action === 'ack') this.remove(await this.bridge.ack(transfer.windowLabel, transfer.revision))
      this.restored.add(key)
      // ready changes state without changing revision. Do not replay the same
      // opening snapshot through the reload path after its acknowledgement.
      if (action === 'ready') this.restored.add(`${transfer.windowLabel}:${transfer.revision}:reload`)
    } catch (error) {
      if (abort.signal.aborted) return
      this.failedRestores.add(key)
      this.error(error)
      if (action !== 'reload') {
        try { await this.bridge.cancel(transfer.windowLabel, transfer.revision) } catch { /* native timeout also restores the source */ }
      }
    } finally {
      this.restores.delete(key)
      if (this.restoreAbort.get(transfer.windowLabel)?.controller === abort) {
        this.restoreAbort.delete(transfer.windowLabel)
        this.pending(transfer.conversationId, false)
      }
      if (this.mainRestoreActive === key) { this.mainRestoreActive = undefined; this.restorePending() }
    }
  }

  detach = (projectId: string | null, conversationId: string): Promise<boolean> => this.operate(conversationId, async () => {
    if (!this.state.available || this.secondary) return false
    const existing = this.state.transfers.find(t => t.conversationId === conversationId)
    if (existing) return this.bridge.focus(conversationId)
    if (!this.handlers) throw new Error('The mission view is not ready to move yet.')
    const target = { projectId, conversationId }
    const snapshot = validateMissionWindowSnapshot(await this.handlers.capture(target), target)
    if (this.discarded.has(conversationId) || this.stopped) return false
    restoreComposerDraft(conversationId, snapshot.composer)
    this.merge(await this.bridge.detach(target, snapshot))
    return true
  })

  attach = (): Promise<boolean> => {
    const current = this.state.current
    if (!this.state.available || !this.secondary || !current) return Promise.resolve(false)
    return this.operate(current.conversationId, async () => {
      if (current.state === 'attaching') return true
      if (current.state !== 'detached' || !this.handlers) throw new Error('The mission view is not ready to move yet.')
      const snapshot = validateMissionWindowSnapshot(await this.handlers.capture(current), current)
      if (this.discarded.has(current.conversationId) || this.stopped) return false
      restoreComposerDraft(current.conversationId, snapshot.composer)
      this.merge(await this.bridge.attach(snapshot))
      return true
    })
  }

  private operate(id: string, operation: () => Promise<boolean>): Promise<boolean> {
    const existing = this.operations.get(id)
    if (existing) return existing
    this.pending(id, true)
    this.clearError()
    // Reserve synchronously, before capture's first await, to prevent double clicks.
    const promise = Promise.resolve().then(operation).catch(error => { if (!this.discarded.has(id)) persistComposerDraft(id); this.error(error); return false }).finally(() => {
      if (this.operations.get(id) === promise) this.operations.delete(id)
      this.pending(id, false)
    })
    this.operations.set(id, promise)
    return promise
  }
  focus = (id: string): Promise<boolean> => this.state.available ? this.bridge.focus(id).catch(error => { this.error(error); return false }) : Promise.resolve(false)
  private clearDraft(id: string) {
    composerDrafts.delete(id); composerAttachmentDrafts.delete(id); composerReferenceDrafts.delete(id)
    composerSubmissionIds.delete(id)
    clearComposerDraftRecovery(id)
    this.pending(id, false)
  }
  /** Only after the backend confirms deletion; this never requests transcript hydration. */
  discard = async (id: string): Promise<boolean> => {
    try {
      if (this.state.available) await this.bridge.discard(id)
      this.discarded.add(id)
      const transfer = this.state.transfers.find(t => t.conversationId === id)
      if (transfer) this.remove(transfer)
      this.clearDraft(id)
      return true
    } catch (error) { this.error(error); return false }
  }
}
