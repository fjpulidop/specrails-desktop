import type { ChildProcess } from 'child_process'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import { getAdapter } from './providers'
import { runAiCliInvocation } from './spawn-lifecycle'
import { ensureAgentCwd } from './agent-cwd-manager'
import { prepareAgentMcp } from './agent-mcp-config'
import { normalizeLevel, type AgentTierLevel } from './agent-tier'
import {
  getAgentConversation,
  addAgentMessage,
  updateAgentConversation,
} from './agent-store'
import { setActiveProject } from './mcp/tools/types'

// ─── AgentChatManager (design D1) ─────────────────────────────────────────────
//
// App-level sibling of ChatManager: spawns an AI CLI from the app-owned agent cwd
// with the Specrails MCP bridge as its tool source, streams the turn over the
// app-global `agent_*` WS events (no projectId — fans to all subscribers), and
// persists to the app registry DB. It reuses the shared spawn→stream→settle core
// (runAiCliInvocation) rather than re-implementing ChatManager's loop.

const OPERATOR_SYSTEM_PROMPT =
  'You are the Specrails operator agent. Drive the Specrails Desktop app on the ' +
  "user's behalf using the specrails_* MCP tools. Target a project with " +
  'specrails_select_project (or the projectId argument); if none is selected and ' +
  'the request is project-specific, ask whether to create a project or search all. ' +
  'Follow HTTP-202 actions to completion with specrails_watch. Respect the ' +
  'permission ladder: if a tool is refused for the current level, tell the user ' +
  'which level it needs rather than working around it. Be concise; report tool ' +
  'outputs faithfully, including failures. Format replies for easy reading: ' +
  'separate distinct ideas into short paragraphs with a blank line between them ' +
  '(not one dense block), and use bullet lists for enumerations.'

export interface AgentTurnOptions {
  tierLevel?: AgentTierLevel
  model?: string
}

export class AgentChatManager {
  private readonly _broadcast: (msg: WsMessage) => void
  private readonly _db: DbInstance
  private readonly _port: number
  private readonly _active = new Map<string, ChildProcess>()

  constructor(broadcast: (msg: WsMessage) => void, db: DbInstance, port: number) {
    this._broadcast = broadcast
    this._db = db
    this._port = port
  }

  /** True while a turn is streaming for this conversation. */
  isStreaming(conversationId: string): boolean {
    return this._active.has(conversationId)
  }

  /**
   * Runs one agent turn: persists the user message, spawns the AI CLI pointed at
   * the Specrails MCP, streams deltas + tool-use as `agent_*` events, then
   * persists the assistant reply and the session id. Settles once.
   */
  async sendMessage(conversationId: string, userText: string, options: AgentTurnOptions = {}): Promise<void> {
    const conversation = getAgentConversation(this._db, conversationId)
    if (!conversation) {
      this._emitError(conversationId, 'Unknown conversation')
      return
    }
    if (this._active.has(conversationId)) {
      this._emitError(conversationId, 'The agent is busy. Try again in a moment.')
      return
    }

    const tierLevel = normalizeLevel(options.tierLevel ?? conversation.tier_level)
    const adapter = getAdapter(conversation.provider)
    // Resolve a model that is VALID for this provider. A stale model from another
    // provider (e.g. claude's "sonnet" after switching to codex) is rejected by
    // the provider — fall back to the provider's default instead of failing.
    const catalog = new Set(adapter.modelCatalog().map((m) => m.value))
    const requested = options.model || conversation.model
    const model = requested && catalog.has(requested) ? requested : adapter.defaultModel()

    // Make the pinned project (Cursor-style selector) the MCP active project for
    // this turn, so project-scoped tools resolve without the agent having to call
    // specrails_select_project. Home (null) clears it → app-global mode.
    setActiveProject(conversation.pinned_project_id ?? null)

    addAgentMessage(this._db, { conversationId, role: 'user', content: userText })

    // Tell the agent which project is pinned (so it phrases + passes projectId).
    const prompt = conversation.pinned_project_id
      ? `[Active project: projectId="${conversation.pinned_project_id}". Use it for project-scoped tools unless told otherwise.]\n\n${userText}`
      : userText

    const cwd = ensureAgentCwd()
    let mcpArgs: string[] = []
    let mcpEnv: Record<string, string> = {}
    try {
      const wiring = prepareAgentMcp({
        adapterId: adapter.id,
        conversationId,
        cwd,
        port: this._port,
        tierLevel,
        activeProjectId: conversation.pinned_project_id,
      })
      mcpArgs = wiring.extraArgs
      mcpEnv = wiring.env
    } catch (err) {
      // A bad conversation id or fs failure shouldn't poison the chat — run tool-less.
      console.error('[agent-chat] failed to prepare mcp:', err)
    }

    const timestamp = (): string => new Date().toISOString()

    interface TurnOutcome {
      text: string
      sessionId: string | null
      error: string | null
      code: number | null
      spawnFailed: boolean
      stderrTail: string
    }

    const invoke = async (useResume: boolean): Promise<TurnOutcome> => {
      const action = useResume ? 'chat-resume' : 'chat-turn'
      let streamed = ''
      let capturedSessionId: string | null = useResume ? conversation.session_id ?? null : null
      let capturedError: string | null = null

      console.log(
        `[agent-chat] turn start conv=${conversationId} provider=${adapter.id} binary=${adapter.binary} ` +
          `action=${action} model=${model} cwd=${cwd} mcp=${mcpArgs.length ? 'mcp-config' : Object.keys(mcpEnv).join(',') || 'none'}`,
      )

      const result = await runAiCliInvocation({
        adapter,
        action,
        cwd,
        env: { ...process.env, ...mcpEnv },
        buildOpts: {
          prompt,
          systemPrompt: adapter.capabilities.systemPromptArg ? OPERATOR_SYSTEM_PROMPT : undefined,
          model,
          sessionId: useResume ? conversation.session_id ?? undefined : undefined,
          extraArgs: mcpArgs,
        },
        onSpawn: (child) => {
          this._active.set(conversationId, child)
        },
        onEvent: (ev) => {
          switch (ev.kind) {
            case 'text-delta':
              streamed += ev.text
              this._broadcast({ type: 'agent_stream', conversationId, delta: ev.text, timestamp: timestamp() })
              break
            case 'tool-use':
              this._broadcast({ type: 'agent_tool', conversationId, tool: ev.name, timestamp: timestamp() })
              break
            case 'session-started':
              if (ev.sessionId) capturedSessionId = ev.sessionId
              break
            case 'result': {
              const sid = (ev.payload as { session_id?: string }).session_id
              if (sid) capturedSessionId = sid
              break
            }
            case 'error':
              capturedError = ev.message
              break
            case 'other':
              break
          }
        },
      })

      this._active.delete(conversationId)
      const text = streamed.trim()
      console.log(
        `[agent-chat] turn end conv=${conversationId} provider=${adapter.id} code=${result.code} ` +
          `spawnFailed=${result.spawnFailed} chars=${text.length} err=${capturedError ?? ''}`,
      )
      if (result.stderrTail && (result.spawnFailed || (result.code ?? 0) !== 0 || !text)) {
        console.error(`[agent-chat] ${adapter.id} stderr:\n${result.stderrTail}`)
      }
      return { text, sessionId: capturedSessionId, error: capturedError, code: result.code, spawnFailed: result.spawnFailed, stderrTail: result.stderrTail }
    }

    const canResume = !!conversation.session_id && adapter.capabilities.nativeResume
    let r = await invoke(canResume)

    // Auto-heal a stale/foreign session: a resume that produced no text (e.g. a
    // provider switch leaving another provider's session id, or codex
    // "no rollout found for thread id") retries once as a fresh turn.
    if (canResume && !r.spawnFailed && !r.text) {
      console.log(`[agent-chat] resume produced no text — retrying fresh conv=${conversationId}`)
      updateAgentConversation(this._db, conversationId, { session_id: null })
      r = await invoke(false)
    }

    if (r.spawnFailed) {
      this._emitError(conversationId, `Failed to launch ${adapter.binary}. Is it installed and on PATH?`)
      return
    }

    if (r.text) {
      addAgentMessage(this._db, { conversationId, role: 'assistant', content: r.text })
      updateAgentConversation(this._db, conversationId, {
        session_id: r.sessionId,
        provider: conversation.provider,
        model,
        tier_level: tierLevel,
      })
      this._broadcast({ type: 'agent_done', conversationId, fullText: r.text, timestamp: timestamp() })
      return
    }

    // Failure: reset the session so the NEXT turn starts fresh, and surface the
    // real reason instead of silently doing nothing.
    updateAgentConversation(this._db, conversationId, { session_id: null, provider: conversation.provider, model, tier_level: tierLevel })
    const reason =
      r.error ||
      (r.stderrTail ? r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : '') ||
      (r.code !== 0 ? `${adapter.binary} exited with code ${r.code}` : 'The agent returned no output.')
    this._emitError(conversationId, reason)
  }

  /** Aborts the active turn for a conversation, if any. */
  abort(conversationId: string): boolean {
    const child = this._active.get(conversationId)
    if (!child) return false
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    this._active.delete(conversationId)
    return true
  }

  /** Kills all active turns (graceful shutdown). */
  async shutdown(): Promise<void> {
    for (const [, child] of this._active) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    this._active.clear()
  }

  private _emitError(conversationId: string, error: string): void {
    this._broadcast({ type: 'agent_error', conversationId, error, timestamp: new Date().toISOString() })
  }
}
