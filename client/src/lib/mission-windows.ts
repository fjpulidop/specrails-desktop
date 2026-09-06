import type { AgentAttachment } from './agent-api'
import type { AgentComposerDraftSnapshot } from './agent-composer-drafts'
import { isTauri } from './tauri-shell'

export interface MissionWindowTarget { projectId: string | null; conversationId: string }
export interface MissionWindowSnapshot extends MissionWindowTarget {
  version: 1
  capturedAt: number
  composer: AgentComposerDraftSnapshot
  scroll: { top: number; atBottom?: boolean } | null
  workspace: {
    codePaneOpen: boolean
    jobsPaneOpen: boolean
    analyticsPaneOpen: boolean
    browserOpen: boolean
    pendingCaptures: AgentAttachment[]
    browserOwnerId?: string | null
    browserUrl?: string | null
    codeSelection?: { path: string | null; repositoryId: string | null }
    terminal?: { activeId: string | null; visibility: 'hidden' | 'restored' | 'maximized'; userHeight: number }
  }
}
export interface MissionWindowTransfer extends MissionWindowTarget {
  windowLabel: string
  revision: number
  state: 'opening' | 'detached' | 'attaching'
  snapshot?: MissionWindowSnapshot | null
}
export interface MissionWindowEvent {
  kind: 'opening' | 'detached' | 'attach-requested' | 'attaching' | 'attached' | 'discarded' | 'failed'
  transfer: MissionWindowTransfer
  error?: string
  /** Failure can retain a transfer for recovery; placement alone is not ownership. */
  registered?: boolean
}
export interface MissionWindowBridge {
  supported(): Promise<boolean>
  list(): Promise<MissionWindowTransfer[]>
  current(windowLabel?: string): Promise<MissionWindowTransfer | null>
  detach(target: MissionWindowTarget, snapshot: MissionWindowSnapshot): Promise<MissionWindowTransfer>
  ready(revision: number): Promise<MissionWindowTransfer>
  attach(snapshot: MissionWindowSnapshot): Promise<MissionWindowTransfer>
  ack(windowLabel: string, revision: number): Promise<MissionWindowTransfer>
  cancel(windowLabel: string, revision: number): Promise<void>
  focus(conversationId: string): Promise<boolean>
  discard(conversationId: string): Promise<void>
  listen(callback: (event: MissionWindowEvent) => void): Promise<() => void>
}

export const MISSION_WINDOW_EVENT = 'mission-window:event'
export const MAX_MISSION_SNAPSHOT_BYTES = 2 * 1024 * 1024

export function isMissionWindowRoute(): boolean {
  return isTauri() && new URLSearchParams(window.location.search).get('missionWindow') === '1'
}

/** Reject incomplete/oversized state; truncating would silently lose unsent work. */
export function validateMissionWindowSnapshot(value: unknown, target: MissionWindowTarget): MissionWindowSnapshot {
  const encoded = JSON.stringify(value)
  if (!encoded || new TextEncoder().encode(encoded).length > MAX_MISSION_SNAPSHOT_BYTES) throw new Error('The mission state exceeds the transfer limit. Your draft remains in this window.')
  const snapshot = JSON.parse(encoded) as MissionWindowSnapshot
  if (!snapshot || snapshot.version !== 1 || snapshot.projectId !== target.projectId || snapshot.conversationId !== target.conversationId) throw new Error('The mission window snapshot does not match this conversation.')
  if (!Number.isFinite(snapshot.capturedAt) || typeof snapshot.composer?.text !== 'string' || !Array.isArray(snapshot.composer.references) || !Array.isArray(snapshot.composer.attachments)) throw new Error('The mission draft snapshot is incomplete.')
  const { text, references, attachments } = snapshot.composer
  if (!references.every(ref => typeof ref?.key === 'string' && Number.isInteger(ref.start) && Number.isInteger(ref.end) && ref.start >= 0 && ref.end >= ref.start && ref.end <= text.length && typeof ref.chip?.id === 'string' && typeof ref.chip.token === 'string')) throw new Error('The mission draft contains invalid reference positions.')
  if (!attachments.every(att => typeof att?.id === 'string' && typeof att.filename === 'string')) throw new Error('The mission draft contains invalid attachments.')
  const submission = snapshot.composer.submission
  if (submission !== undefined && (!submission || typeof submission.signature !== 'string' || typeof submission.queueId !== 'string' || !submission.queueId)) throw new Error('The mission draft contains an invalid retry identity.')
  if (snapshot.scroll !== null && (!snapshot.scroll || !Number.isFinite(snapshot.scroll.top) || snapshot.scroll.top < 0)) throw new Error('The mission scroll snapshot is invalid.')
  if (!snapshot.workspace || !['codePaneOpen', 'jobsPaneOpen', 'analyticsPaneOpen', 'browserOpen'].every(key => typeof snapshot.workspace[key as 'browserOpen'] === 'boolean') || !Array.isArray(snapshot.workspace.pendingCaptures)) throw new Error('The mission workspace snapshot is incomplete.')
  return snapshot
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Native mission windows are unavailable in this browser.')
  const api = await import('@tauri-apps/api/core')
  return api.invoke<T>(command, args)
}

/** Browser development never imports native APIs or advertises detached windows. */
export const missionWindowBridge: MissionWindowBridge = {
  async supported() { if (!isTauri()) return false; try { return await invoke<boolean>('mission_windows_supported') === true } catch { return false } },
  async list() { return isTauri() ? invoke('mission_windows_list') : [] },
  async current(windowLabel) { return isTauri() ? invoke('mission_window_current', windowLabel ? { windowLabel } : undefined) : null },
  detach(target, snapshot) { return invoke('mission_window_detach', { ...target, snapshot }) },
  ready(revision) { return invoke('mission_window_ready', { revision }) },
  attach(snapshot) { return invoke('mission_window_attach', { snapshot }) },
  ack(windowLabel, revision) { return invoke('mission_window_ack', { windowLabel, revision }) },
  async cancel(windowLabel, revision) { if (isTauri()) await invoke('mission_window_cancel', { windowLabel, revision }) },
  async focus(conversationId) { return isTauri() ? invoke('mission_window_focus', { conversationId }) : false },
  async discard(conversationId) { if (isTauri()) await invoke('mission_window_discard', { conversationId }) },
  async listen(callback) {
    if (!isTauri()) return () => {}
    const { listen } = await import('@tauri-apps/api/event')
    return listen<MissionWindowEvent>(MISSION_WINDOW_EVENT, event => callback(event.payload))
  },
}
