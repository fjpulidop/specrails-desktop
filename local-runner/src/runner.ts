import fs from 'fs'
import readline from 'readline'
import { randomUUID } from 'crypto'
import { ArgvError, parseArgv } from './argv'
import { FrameEmitter } from './frames'
import { EndpointError, streamCompletion } from './openai-client'
import { SessionStore, sessionsDir } from './sessions'
import { builtinTools, confinementRoots } from './tools'
import { connectMcpServers, readMcpConfig, type McpSession } from './mcp'
import { resolveSlashCommand } from './commands'
import type { ChatMessage, RunnableTool, RunnerIo, RunnerOptions, SessionFile, ToolCall, Usage } from './types'

/**
 * The agent loop. `runCli` is the whole process in a function so the runner
 * is testable in-process (the entry point only wires process streams and the
 * exit code). Exit codes: 0 success, 1 turn error in one-shot mode, 2 argv error.
 */

const MISSING_SESSION = (id: string) => `No conversation found with session ID: ${id}`

interface TurnOutcome {
  ok: boolean
}

/** Sent once when the model closes a tool turn with no text (see runTurn). */
const EMPTY_REPLY_NUDGE = 'You called tools but did not answer. Reply to the user now in plain text, using the tool results above. Do not call more tools.'

class TurnRunner {
  private readonly emitter: FrameEmitter
  private readonly toolsByName = new Map<string, RunnableTool>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly opts: RunnerOptions,
    private readonly io: RunnerIo,
    private readonly session: SessionFile,
    private readonly store: SessionStore,
    tools: RunnableTool[],
    private readonly baseSystemPrompt: string | null,
  ) {
    this.emitter = new FrameEmitter(io.stdout)
    for (const t of tools) this.toolsByName.set(t.definition.function.name, t)
    this.fetchImpl = io.fetch ?? fetch
    this.now = io.now ?? Date.now
  }

  private apiKey(): string | null {
    if (!this.opts.apiKeyEnv) return null
    const v = this.io.env[this.opts.apiKeyEnv]
    return v && v.length > 0 ? v : null
  }

  private systemPrompt(tail: string | null): string | null {
    const parts = [this.baseSystemPrompt, tail].filter((p): p is string => typeof p === 'string' && p.length > 0)
    return parts.length ? parts.join('\n\n') : null
  }

  async runTurn(userText: string): Promise<TurnOutcome> {
    const started = this.now()
    const usageTotal: Usage = { input_tokens: 0, output_tokens: 0 }
    const model = this.opts.model
    this.emitter.init(this.session.id, model)

    const finish = (args: { isError: boolean; numTurns: number; result: string; reason?: string }): TurnOutcome => {
      this.store.save(this.session)
      this.emitter.result({
        sessionId: this.session.id,
        isError: args.isError,
        numTurns: args.numTurns,
        durationMs: Math.max(this.now() - started, 0),
        usage: usageTotal,
        result: args.result,
        ...(args.reason ? { reason: args.reason } : {}),
      })
      return { ok: !args.isError }
    }

    // Slash commands: see commands.ts for the claude-compatible expansion rules.
    const slash = resolveSlashCommand(this.io.cwd, userText)
    if (slash.kind === 'unknown') {
      const text = `Unknown command: /${slash.name}`
      this.emitter.assistantText(`msg_${randomUUID()}`, model, text)
      return finish({ isError: true, numTurns: 0, result: text })
    }
    const system = this.systemPrompt(slash.kind === 'expanded' ? slash.systemTail : null)

    this.session.messages.push({ role: 'user', content: userText })
    const tools = [...this.toolsByName.values()].map((t) => t.definition)
    let apiCalls = 0
    let nudged = false
    let contextRetried = false
    let lastText = ''

    while (true) {
      if (this.opts.maxTurns !== null && apiCalls >= this.opts.maxTurns) {
        return finish({
          isError: true,
          numTurns: apiCalls,
          result: `Reached max turns (${this.opts.maxTurns}) before the model finished`,
          reason: 'max_turns',
        })
      }
      const messageId = `msg_${randomUUID()}`
      const messages: ChatMessage[] = system ? [{ role: 'system', content: system }, ...this.session.messages] : [...this.session.messages]
      let completion
      try {
        completion = await streamCompletion({
          baseUrl: this.opts.baseUrl,
          apiKey: this.apiKey(),
          model,
          messages,
          tools,
          reasoningEffort: this.opts.reasoningEffort,
          fetchImpl: this.fetchImpl,
          onText: (delta) => this.emitter.assistantText(messageId, model, delta),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof EndpointError && err.isContextLength && !contextRetried && this.evictOldestToolExchange()) {
          contextRetried = true
          this.io.stderr.write('[local-runner] context-length error; evicted the oldest tool exchange and retrying once\n')
          continue
        }
        return finish({ isError: true, numTurns: apiCalls, result: message })
      }
      apiCalls++
      if (completion.usage) {
        usageTotal.input_tokens += completion.usage.input_tokens
        usageTotal.output_tokens += completion.usage.output_tokens
      }
      const usage = completion.usage ?? undefined
      if (completion.text) lastText = completion.text

      // `content: null` is legal OpenAI but llama.cpp-style servers reject it
      // ("invalid message content type: <nil>"); an empty string is accepted everywhere.
      const assistant: ChatMessage = { role: 'assistant', content: completion.text || '' }
      if (completion.toolCalls.length > 0) assistant.tool_calls = completion.toolCalls
      this.session.messages.push(assistant)

      if (completion.toolCalls.length === 0) {
        if (usage) this.emitter.assistantUsage(messageId, model, usage)
        // Small models often end a turn right after a tool call with an EMPTY
        // final message (no text, no calls). That would surface as "the agent
        // returned no output". Nudge ONCE: ask for the user-facing reply and
        // re-call; a second empty reply settles as a real (empty) result.
        if (!completion.text && apiCalls > 1 && !nudged) {
          nudged = true
          this.session.messages.push({ role: 'user', content: EMPTY_REPLY_NUDGE })
          continue
        }
        return finish({ isError: false, numTurns: apiCalls, result: lastText })
      }

      for (const call of completion.toolCalls) {
        const outcome = await this.executeToolCall(messageId, model, call, usage)
        this.session.messages.push({ role: 'tool', tool_call_id: call.id, content: outcome })
      }
    }
  }

  private async executeToolCall(messageId: string, model: string, call: ToolCall, usage: Usage | undefined): Promise<string> {
    const name = call.function.name
    let input: Record<string, unknown> | null = null
    let parseError: string | null = null
    const raw = call.function.arguments.trim()
    if (raw.length === 0) input = {}
    else {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
        else parseError = `tool arguments must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
      } catch (err) {
        parseError = `invalid tool arguments JSON: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    this.emitter.assistantToolUse(messageId, model, call.id, name, input ?? { _raw: raw }, usage)

    let content: string
    let isError: boolean
    if (parseError !== null || input === null) {
      content = `${parseError ?? 'invalid tool arguments'}. Raw arguments: ${raw.slice(0, 500)}`
      isError = true
    } else {
      const tool = this.toolsByName.get(name)
      if (!tool) {
        content = `Unknown tool: ${name}. Available tools: ${[...this.toolsByName.keys()].join(', ') || '(none)'}`
        isError = true
      } else {
        const out = await tool.run(input)
        content = out.content
        isError = out.isError
      }
    }
    this.emitter.toolResult(call.id, content, isError)
    return content
  }

  /**
   * Context-overflow recovery (D7): drop the OLDEST assistant tool-call message
   * together with its tool results (an exchange inside the current turn is
   * evictable too — it is often the only thing that can be). Never touches a
   * user turn (the latest one is what the model must answer) nor the system
   * prompt (rebuilt per call).
   */
  private evictOldestToolExchange(): boolean {
    const msgs = this.session.messages
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        let end = i + 1
        while (end < msgs.length && msgs[end].role === 'tool') end++
        msgs.splice(i, end - i)
        return true
      }
    }
    return false
  }
}

function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter((c): c is { type: 'text'; text: string } => !!c && typeof c === 'object' && (c as { type?: string }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
      .map((c) => c.text)
    return parts.length ? parts.join('\n') : null
  }
  return null
}

export async function runCli(argv: string[], io: RunnerIo): Promise<number> {
  let opts: RunnerOptions
  try {
    opts = parseArgv(argv, io.env)
  } catch (err) {
    if (err instanceof ArgvError) {
      io.stderr.write(`${err.message}\n`)
      return err.exitCode
    }
    throw err
  }

  const emitter = new FrameEmitter(io.stdout)
  const store = new SessionStore(sessionsDir(io.env))
  let session: SessionFile
  if (opts.resume) {
    const loaded = store.load(opts.resume)
    if (!loaded) {
      emitter.result({
        sessionId: opts.resume,
        isError: true,
        numTurns: 0,
        durationMs: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        result: MISSING_SESSION(opts.resume),
      })
      return 1
    }
    session = loaded
    session.model = opts.model
  } else {
    session = store.create(opts.model, io.cwd)
  }

  const roots = confinementRoots(io.cwd, opts.addDirs)
  const tools: RunnableTool[] = builtinTools({ cwd: io.cwd, roots, env: io.env }, opts.toolPolicy)
  let mcp: McpSession | null = null
  if (opts.mcpConfig) {
    try {
      const config = readMcpConfig(opts.mcpConfig)
      mcp = await connectMcpServers(config, io.env, io.stderr)
      tools.push(...mcp.tools)
    } catch (err) {
      io.stderr.write(`[local-runner] cannot load --mcp-config ${opts.mcpConfig}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  const baseSystem = [opts.systemPrompt, opts.appendSystemPrompt].filter((p): p is string => !!p).join('\n\n') || null
  const turns = new TurnRunner(opts, io, session, store, tools, baseSystem)

  try {
    if (opts.inputFormat !== 'stream-json') {
      const outcome = await turns.runTurn(opts.prompt as string)
      return outcome.ok ? 0 : 1
    }

    // Persistent mode: one turn per stdin line, a `result` per turn, exit 0 at
    // stdin end. An explicit -p (if any) is the first turn.
    if (opts.prompt !== null) await turns.runTurn(opts.prompt)
    const rl = readline.createInterface({ input: io.stdin, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let frame: { type?: string; message?: { content?: unknown } }
      try {
        frame = JSON.parse(trimmed) as typeof frame
      } catch {
        io.stderr.write(`[local-runner] ignoring non-JSON stdin line\n`)
        continue
      }
      if (frame.type !== 'user') continue
      const text = contentToText(frame.message?.content)
      if (text === null) {
        io.stderr.write(`[local-runner] ignoring user frame without text content\n`)
        continue
      }
      await turns.runTurn(text)
    }
    return 0
  } finally {
    if (mcp) await mcp.close()
  }
}

/** Exposed for tests: whether the sessions directory currently holds the given id. */
export function sessionFileExists(env: Record<string, string | undefined>, id: string): boolean {
  return fs.existsSync(`${sessionsDir(env)}/${id}.json`)
}
