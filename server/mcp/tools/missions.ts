import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { apiCall } from './types'
import { McpToolError, toolResponse, type NextCall } from './envelope'

/**
 * `specrails_missions`: the Agent/Mission mode conversations, for MCP clients.
 * Every action forwards over loopback to the routes the app itself uses
 * (server/modules/missions/runtime/agent-chat-router.ts, mounted at
 * /api/agent). An external client can read, send a message, stop a running
 * turn and ask a side question; it can never change a mission's permission
 * level, provider or project pin (those fields are not forwarded).
 */

const DEFAULT_LIST = 20
const DEFAULT_MESSAGES = 10
const MESSAGE_CHARS = 2_000
const SELECTION_CHARS = 8_000

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}… [truncated]` : value

function requireConversation(args: Row): string {
  const id = str(args.conversationId)
  if (!id) throw new McpToolError('invalid_input', 'This action requires "conversationId" (from specrails_missions list).', {
    next: [{ tool: 'specrails_missions', args: { action: 'list' }, why: 'Find the mission id.' }],
  })
  return id
}

/** A mission must not message, stop or question itself through MCP (it would loop on its own turn). */
function refuseSelf(ctx: McpToolContext, id: string, action: string): void {
  if (ctx.firstPartyAgent && ctx.originConversationId === id) {
    throw new McpToolError('invalid_input', `A mission cannot ${action} its own conversation through MCP.`)
  }
}

function projectName(ctx: McpToolContext, id: unknown): string | null {
  if (typeof id !== 'string') return null
  try { return ctx.registry.getProjectRow?.(id)?.name ?? null } catch { return null }
}

async function activeIds(ctx: McpToolContext): Promise<{ running: Set<string>; background: Set<string> }> {
  const turns = record(await apiCall(ctx, 'GET', '/agent/active-turns'))
  return {
    running: new Set(rows(turns.turns).map((turn) => String(turn.conversationId))),
    background: new Set(rows(turns.sessions).map((session) => String(session.conversationId))),
  }
}

function presentMission(ctx: McpToolContext, conversation: Row, active: { running: Set<string>; background: Set<string> }): Row {
  const id = String(conversation.id)
  const usage = record(conversation.contextUsage)
  return {
    conversationId: id,
    title: str(conversation.title) ?? 'Untitled mission',
    projectId: conversation.pinned_project_id ?? null,
    projectName: projectName(ctx, conversation.pinned_project_id),
    provider: conversation.provider ?? null,
    model: conversation.model ?? null,
    running: active.running.has(id),
    backgroundWork: !active.running.has(id) && active.background.has(id),
    contextUsagePercent: typeof usage.percent === 'number' ? usage.percent : null,
    archived: Boolean(conversation.archivedAt),
    updatedAt: conversation.updated_at ?? null,
  }
}

function describeMission(mission: Row): string {
  const where = mission.projectName ? ` in ${String(mission.projectName)}` : ''
  const engine = [mission.provider, mission.model].filter(Boolean).join(' / ')
  const usage = typeof mission.contextUsagePercent === 'number' ? `, context ${mission.contextUsagePercent}% used` : ''
  return `“${String(mission.title)}”${where} (${engine || 'default engine'}${usage})`
}

export function missionsTools(): McpToolSpec[] {
  return [{
    name: 'specrails_missions',
    title: 'Missions (Agent mode)',
    description:
      'The app\'s Agent/Mission conversations. Actions: list (read; title, project, provider/model, running, context usage %), active (read; missions running now), ' +
      'get (read; recent messages, live state and context usage of conversationId), send (ai-spawn; post a message — it starts or queues a paid turn on the mission\'s own provider), ' +
      'ask (ai-spawn; a one-turn side question about the mission that never writes to it), abort (destructive; stop the running turn). ' +
      'Cannot change a mission\'s permission level, provider or project pin.',
    hintTier: 'read',
    tier: (args) => args.action === 'abort' ? 'destructive' : args.action === 'send' || args.action === 'ask' ? 'ai-spawn' : 'read',
    inputSchema: {
      action: z.enum(['list', 'active', 'get', 'send', 'ask', 'abort']).describe('Operation to perform'),
      conversationId: z.string().min(1).max(200).optional().describe('get/send/ask/abort: the mission id from list'),
      projectId: z.string().optional().describe('list: only missions pinned to this project'),
      includeArchived: z.boolean().optional().describe('list: include archived missions (default false)'),
      limit: z.number().int().min(1).max(100).optional().describe(`list: maximum missions (default ${DEFAULT_LIST}); get: recent messages (default ${DEFAULT_MESSAGES})`),
      text: z.string().min(1).max(64_000).optional().describe('send: the message, verbatim from the person'),
      deliveryMode: z.enum(['queue', 'steer']).optional().describe('send: while a turn runs, queue it (default) or steer the running turn'),
      question: z.string().min(1).max(4_000).optional().describe('ask: the side question'),
      selection: z.string().min(1).max(SELECTION_CHARS).optional().describe('ask: the passage the question is about (default: the latest assistant reply)'),
      throughMessageId: z.string().min(1).max(200).optional().describe('ask: read history up to this message (default: the latest message)'),
    },
    async handler(ctx, args) {
      const action = args.action as string
      switch (action) {
        case 'list':
        case 'active': {
          const scope = args.includeArchived === true ? 'all' : 'active'
          const [listed, active] = await Promise.all([apiCall(ctx, 'GET', `/agent/conversations?archiveScope=${scope}`), activeIds(ctx)])
          let missions = rows(record(listed).conversations).map((conversation) => presentMission(ctx, conversation, active))
          if (typeof args.projectId === 'string') missions = missions.filter((mission) => mission.projectId === args.projectId)
          if (action === 'active') missions = missions.filter((mission) => mission.running || mission.backgroundWork)
          missions.sort((a, b) => Number(b.running) - Number(a.running) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
          const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIST
          const shown = missions.slice(0, limit)
          const running = missions.filter((mission) => mission.running).length
          const first = shown[0]
          return toolResponse({ missions: shown, total: missions.length }, {
            summary: action === 'active'
              ? (missions.length ? `${missions.length} mission${missions.length === 1 ? '' : 's'} working now: ${shown.slice(0, 3).map(describeMission).join('; ')}.` : 'No mission is running right now.')
              : (missions.length ? `${missions.length} mission${missions.length === 1 ? '' : 's'}, ${running} running. Most recent: ${first ? describeMission(first) : 'none'}.` : 'There are no missions yet.'),
            truncated: missions.length > shown.length,
            next: first ? [{ tool: 'specrails_missions', args: { action: 'get', conversationId: first.conversationId }, why: 'Read its recent messages.' }] : [],
          })
        }
        case 'get': {
          const id = requireConversation(args)
          const result = record(await apiCall(ctx, 'GET', `/agent/conversations/${encodeURIComponent(id)}`))
          const conversation = record(result.conversation)
          const live = record(result.live)
          const active = { running: new Set<string>(live.isStreaming === true ? [id] : []), background: new Set<string>() }
          const mission = presentMission(ctx, conversation, active)
          const all = rows(result.messages)
          const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_MESSAGES
          const messages = all.slice(-limit).map((message) => ({
            id: message.id, role: message.role, createdAt: message.created_at ?? null,
            content: clip(typeof message.content === 'string' ? message.content : '', MESSAGE_CHARS),
          }))
          const pending = Array.isArray(result.pendingMessages) ? result.pendingMessages.length : 0
          const last = [...all].reverse().find((message) => message.role === 'assistant')
          const next: NextCall[] = [{ tool: 'specrails_missions', args: { action: 'send', conversationId: id, text: '<message from the person>' }, why: 'Continue the mission (ai-spawn).' }]
          if (mission.running) next.unshift({ tool: 'specrails_watch', args: { ref: id }, why: 'Wait for the running turn to finish.' })
          if (last) next.push({ tool: 'specrails_missions', args: { action: 'ask', conversationId: id, question: '<side question>' }, why: 'Ask about the latest reply without writing to the mission (ai-spawn).' })
          return toolResponse({
            mission, contextUsage: conversation.contextUsage ?? null,
            live: { isStreaming: live.isStreaming === true, startedAt: live.startedAt ?? null, streamingText: typeof live.streamingText === 'string' && live.streamingText ? clip(live.streamingText, MESSAGE_CHARS) : null },
            pendingMessages: pending, messages, totalMessages: all.length,
          }, {
            summary: `Mission ${describeMission(mission)} is ${mission.running ? 'running a turn' : 'idle'}; ${all.length} message${all.length === 1 ? '' : 's'}${pending ? `, ${pending} queued` : ''}.${last ? ` Latest reply: ${clip(String(last.content ?? '').replace(/\s+/g, ' '), 160)}` : ''}`,
            status: mission.running ? 'running' : 'idle',
            ids: { conversationId: id },
            truncated: all.length > messages.length,
            next,
          })
        }
        case 'send': {
          const id = requireConversation(args)
          refuseSelf(ctx, id, 'message')
          const text = str(args.text)
          if (!text) throw new McpToolError('invalid_input', 'send requires "text".')
          const result = record(await apiCall(ctx, 'POST', `/agent/conversations/${encodeURIComponent(id)}/send`, {
            text, ...(args.deliveryMode ? { deliveryMode: args.deliveryMode } : {}),
          }))
          return toolResponse(result, {
            summary: result.queued ? 'Message queued; the mission reads it after the running turn.' : 'Message sent; the mission is working on it.',
            status: result.queued ? 'queued' : 'running',
            ids: { conversationId: id },
            next: [
              { tool: 'specrails_watch', args: { ref: id }, why: 'Wait for the turn to finish (chat_done / chat_error).' },
              { tool: 'specrails_missions', args: { action: 'get', conversationId: id }, why: 'Read the reply.' },
            ],
          })
        }
        case 'ask': {
          const id = requireConversation(args)
          refuseSelf(ctx, id, 'question')
          const question = str(args.question)
          if (!question) throw new McpToolError('invalid_input', 'ask requires "question".')
          let selection = str(args.selection)
          let through = str(args.throughMessageId)
          if (!selection || !through) {
            const result = record(await apiCall(ctx, 'GET', `/agent/conversations/${encodeURIComponent(id)}`))
            const messages = rows(result.messages)
            const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim())
            if (!messages.length) throw new McpToolError('conflict', 'This mission has no messages to ask about yet.')
            through ??= String(messages[messages.length - 1].id)
            selection ??= clip(String(lastAssistant?.content ?? messages[messages.length - 1].content ?? '').trim() || question, SELECTION_CHARS - 20)
          }
          const answer = await apiCall(ctx, 'POST', `/agent/conversations/${encodeURIComponent(id)}/side-questions`, { selection, throughMessageId: through, question })
          const body = record(answer)
          const textAnswer = str(body.answer) ?? str(body.text)
          return toolResponse(answer, {
            summary: textAnswer ? clip(textAnswer.replace(/\s+/g, ' '), 300) : 'Side question answered; see data.',
            ids: { conversationId: id },
          })
        }
        case 'abort': {
          const id = requireConversation(args)
          refuseSelf(ctx, id, 'stop')
          const result = record(await apiCall(ctx, 'POST', `/agent/conversations/${encodeURIComponent(id)}/abort`))
          return toolResponse(result, {
            summary: result.aborted ? 'The running turn was stopped.' : 'Nothing was running in this mission.',
            status: result.aborted ? 'aborted' : 'idle',
            ids: { conversationId: id },
          })
        }
        default:
          throw new McpToolError('invalid_input', `Unknown action "${action}".`)
      }
    },
  }]
}
