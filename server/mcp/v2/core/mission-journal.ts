import { randomUUID } from 'node:crypto'
import { createAgentConversation, getAgentConversation } from '../../../modules/agents/runtime/agent-store'
import { getAgentChatManager } from '../../../modules/missions/runtime/agent-chat-registry'
import { defaultMachineProvider } from '../../../provider-selection'
import { isV2Result } from './envelope'
import { parseRef } from './refs'
import type { V2CallContext, V2SessionState } from './registry'

/**
 * What an external MCP client (Claude Code, Codex…) does is visible in Desktop.
 *
 * The MCP is the vehicle the person drives Specrails with, so every change it
 * makes lands in a mission, the way Intent keeps its own steps in its mission:
 * - the mission the session is working with (one it created, wrote to or
 *   operated, or one named with `options.mission`), else
 * - the session's own log mission for that project ("MCP · <client>"),
 *   created on its first change there.
 * Each change is an `mcp-action` row (tool, action, outcome, summary, refs) and
 * the mission is the call's origin, so a launched run, a PR card or a CI repair
 * shows there as it would for a mission's own agent. Reads leave no trace;
 * in-app mission agents (a capability) keep their own mission and cards.
 */

const HOME = 'home'
const SUMMARY_CHARS = 300

export interface JournalSessionState {
  /** Mission in use per project id (`home` for none). */
  journalMissions?: Record<string, string>
  /** The MCP client's name, e.g. `claude-code`. */
  clientName?: () => string | null
  /** False for in-app turns (they never journal). */
  external?: boolean
}

type Session = V2SessionState & JournalSessionState
type Args = Record<string, unknown>

export interface JournalTarget { conversationId: string; projectId: string | null }

const live = (ctx: V2CallContext, id: string | null | undefined) => {
  if (!id) return null
  const conversation = getAgentConversation(ctx.desktopDb, id)
  return conversation && !conversation.deleted_at ? conversation : null
}

function missionOf(ctx: V2CallContext, value: unknown): ReturnType<typeof live> {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = parseRef(value)
  return live(ctx, parsed?.kind === 'mission' ? parsed.id : parsed ? null : value.trim())
}

/** The project a call concerns: its `project`, the project of its `ref`, else the session's. */
export function journalProjectId(ctx: V2CallContext, args: Args): string | null {
  const session = ctx.sessionState as Session
  try {
    if (args.project !== undefined && args.project !== null && args.project !== HOME) return ctx.v2.project(args).id
    const parsed = parseRef(args.ref)
    if (parsed && 'project' in parsed && parsed.project) return ctx.v2.project({ project: parsed.project }).id
  } catch { /* not a known project: the session's own */ }
  return session.activeProjectId ?? null
}

export function bindJournalMission(session: Session, conversationId: string, projectId: string | null): void {
  session.journalMissions ??= {}
  session.journalMissions[projectId ?? HOME] = conversationId
}

function clientOf(session: Session): string {
  try { return session.clientName?.()?.trim().slice(0, 80) || 'MCP' } catch { return 'MCP' }
}

/** Whether this call is journaled at all: an external session's change. */
export function journals(ctx: V2CallContext, tier: string, hasCapability: boolean): boolean {
  const session = ctx.sessionState as Session
  return !hasCapability && ctx.firstPartyAgent !== true && session.external === true && tier !== 'read'
}

/**
 * The mission a journaled call lands in, before it runs. A missions-tool call on
 * a mission uses that mission; `create` / `intent_start` without one bind after
 * they run (`journalCreated`), so they return null here.
 */
export function openJournalMission(ctx: V2CallContext, tool: string, action: string, args: Args): JournalTarget | null {
  const session = ctx.sessionState as Session
  const options = (args.options && typeof args.options === 'object' ? args.options : {}) as Args
  const named = missionOf(ctx, options.mission) ?? (tool === 'specrails_missions' ? missionOf(ctx, args.ref) : null)
  if (named) {
    bindJournalMission(session, named.id, named.pinned_project_id ?? null)
    return { conversationId: named.id, projectId: named.pinned_project_id ?? null }
  }
  if (tool === 'specrails_missions' && (action === 'create' || action === 'intent_start')) return null
  const projectId = journalProjectId(ctx, args)
  const bound = live(ctx, session.journalMissions?.[projectId ?? HOME])
  if (bound) return { conversationId: bound.id, projectId }
  const client = clientOf(session)
  const created = createAgentConversation(ctx.desktopDb, {
    provider: defaultMachineProvider(), pinnedProjectId: projectId, title: `MCP · ${client}`, origin: { kind: 'mcp', client },
  })
  getAgentChatManager()?.notifyConversationCreated(created.id)
  bindJournalMission(session, created.id, projectId)
  return { conversationId: created.id, projectId }
}

/** `create` / `intent_start`: the mission they made becomes the one in use. */
export function journalCreated(ctx: V2CallContext, value: unknown): JournalTarget | null {
  if (!isV2Result(value)) return null
  const refs = (value.refs ?? {}) as Record<string, unknown>
  const data = (value.data && typeof value.data === 'object' ? value.data : {}) as Args
  const mission = missionOf(ctx, refs.mission ?? data.ref)
  if (!mission) return null
  bindJournalMission(ctx.sessionState as Session, mission.id, mission.pinned_project_id ?? null)
  return { conversationId: mission.id, projectId: mission.pinned_project_id ?? null }
}

/** Calls whose effect already shows in the mission itself (the message is the record). */
const SELF_EVIDENT = new Set(['specrails_missions.send'])

/** Writes the call's row in its mission: what was asked, and how it ended. */
export function recordJournalAction(ctx: V2CallContext, target: JournalTarget, entry: {
  tool: string; action: string; tier: string; args: Args; value?: unknown; error?: { code: string; message: string }
}): void {
  if (!entry.error && SELF_EVIDENT.has(`${entry.tool}.${entry.action}`)) return
  const manager = getAgentChatManager()
  if (!manager) return
  const value = entry.value
  // A created mission is the row's own mission: its summary only tells the agent what to do next.
  const created = entry.tool === 'specrails_missions' && (entry.action === 'create' || entry.action === 'intent_start')
  const summary = !created && isV2Result(value) && typeof value.summary === 'string' ? value.summary : null
  const refs = isV2Result(value) && value.refs && typeof value.refs === 'object' ? value.refs as Record<string, string> : {}
  try {
    manager.postSystemRow(target.conversationId, {
      kind: 'mcp-action',
      client: clientOf(ctx.sessionState as Session),
      tool: entry.tool,
      action: entry.action,
      tier: entry.tier,
      ok: !entry.error,
      ...(typeof entry.args.ref === 'string' ? { target: entry.args.ref.slice(0, 200) } : {}),
      ...(summary ? { summary: summary.slice(0, SUMMARY_CHARS) } : {}),
      ...(Object.keys(refs).length ? { refs: Object.fromEntries(Object.entries(refs).slice(0, 6)) } : {}),
      ...(entry.error ? { error: { code: entry.error.code, message: entry.error.message.slice(0, SUMMARY_CHARS) } } : {}),
      at: new Date().toISOString(),
    }, `mcp-action:${randomUUID()}`)
  } catch { /* the log never fails the tool */ }
}
