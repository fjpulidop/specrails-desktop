/**
 * In-process tracking of orchestrated Blueprint commits (`blueprint:<commitId>`):
 * the async commit route answers at once and reports through
 * `blueprint.commit_*` bus frames. One listener per bus, the last 50 commits
 * kept. In-process only: a server restart forgets them (the project they
 * created stays readable through projects).
 */
import type { MobileEventBus } from '../../../mobile/mobile-event-bus'
import type { WsMessage } from '../../../types'
import type { McpToolContext } from '../../tools/types'
import { neutralize } from './untrusted'
import { asRecord, clip } from './text'

const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null

export interface CommitTrack {
  conversationId: string | null
  name: string
  status: 'running' | 'done' | 'failed'
  step: string | null
  steps: Array<{ step: string; status: string; code?: string }>
  projectId: string | null
  error: string | null
  at: number
}

const COMMITS_KEPT = 50
const commits = new Map<string, CommitTrack>()
const tracked = new WeakSet<object>()

export function trackCommits(ctx: Pick<McpToolContext, 'eventBus'>): void {
  const bus = ctx.eventBus as MobileEventBus | undefined
  if (!bus || tracked.has(bus)) return
  tracked.add(bus)
  bus.onMessage((raw: WsMessage) => {
    const msg = asRecord(raw)
    const id = str(msg.commitId)
    if (!id || !String(msg.type).startsWith('blueprint.commit_')) return
    let entry = commits.get(id)
    if (!entry) {
      entry = { conversationId: null, name: '', status: 'running', step: null, steps: [], projectId: null, error: null, at: Date.now() }
      rememberCommit(id, entry)
    }
    entry.at = Date.now()
    if (msg.type === 'blueprint.commit_progress') {
      const step = str(msg.step) ?? '?'
      const status = str(msg.status) ?? 'running'
      const existing = entry.steps.find((s) => s.step === step)
      const code = str(msg.code)
      if (existing) { existing.status = status; if (code) existing.code = code } else entry.steps.push({ step, status, ...(code ? { code } : {}) })
      entry.step = step
    } else if (msg.type === 'blueprint.commit_done') {
      entry.status = 'done'
      entry.projectId = str(msg.projectId)
    } else if (msg.type === 'blueprint.commit_failed') {
      entry.status = 'failed'
      entry.step = str(msg.step) ?? entry.step
      entry.error = typeof msg.error === 'string' && msg.error ? clip(neutralize(msg.error), 300) : null
    }
  })
}

export function rememberCommit(id: string, track: CommitTrack): void {
  const seen = commits.get(id)
  // Frames that arrived before the route answered are kept (the commit is async).
  if (seen && seen !== track) { seen.conversationId = track.conversationId; seen.name = track.name; return }
  commits.set(id, track)
  while (commits.size > COMMITS_KEPT) commits.delete(commits.keys().next().value as string)
}

/** Test-only: forget tracked commits. */
export function __resetBlueprintCommits(): void { commits.clear() }

export function trackedCommit(id: string): CommitTrack | undefined { return commits.get(id) }
