import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { spawnAiCli } from '../util/cli-prompt'
import { treeKillSafe } from '../util/win-spawn'
import type { InvocationResult } from '../spawn-lifecycle'
import { buildProviderEnv } from './runtime'
import type { AdapterEvent } from './types'
import { LiveInputDeliveryError, type LiveInput, type LiveInputSink, type LiveSessionHooks } from './live-session-types'

// Verified against codex-cli 0.153.4's generated app-server v2 protocol and
// https://learn.chatgpt.com/docs/app-server. No SDK or paid probe is required.
const RPC_TIMEOUT_MS = 60_000
const STEER_TIMEOUT_MS = 30_000
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const STDERR_CAP = 64 * 1024
type JsonObject = Record<string, unknown>
type RpcId = string | number
interface PendingRequest {
  method: string
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  onAccepted?: (value: JsonObject) => void
}
class RpcFailure extends Error {
  constructor(message: string, readonly code: number | undefined) { super(message) }
}
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const preview = (value: unknown, limit = 4000): string => (typeof value === 'string' ? value : JSON.stringify(value ?? '')).slice(0, limit)
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const userInput = (text: string, imagePaths?: string[]) => [
  { type: 'text', text, text_elements: [] },
  ...(imagePaths ?? []).map(path => ({ type: 'localImage', path })),
]

/** One native Codex turn, retaining a full-duplex app-server connection until
 * completion. Steering never interrupts, restarts, or replays an active action. */
export function runCodexLiveSession(hooks: LiveSessionHooks): Promise<InvocationResult> {
  const opts = hooks.buildOpts
  const events: AdapterEvent[] = []
  let child: ChildProcess | null = null
  let sessionId: string | null = null
  let lastResultEvent: AdapterEvent | null = null
  let stderrTail = ''
  let activeTurnId: string | null = null
  let terminal: JsonObject | null = null
  let settled = false
  let transportFailed = false
  let closing = false
  let childClosed = false
  let turnRequested = false
  let nextId = 0
  let inputReady = false
  let lineBuffer = ''
  const decoder = new StringDecoder('utf8')
  const pending = new Map<RpcId, PendingRequest>()
  const messages = new Map<string, string>()
  const completedItems = new Set<string>()
  const startedTools = new Set<string>()
  const submissions = new Map<string, { fingerprint: string; promise: Promise<boolean> }>()
  let sendChain: Promise<unknown> = Promise.resolve()
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let wallTimer: ReturnType<typeof setTimeout> | undefined
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let baselineUsage: JsonObject | null = null
  let lastTotal: JsonObject | null = null
  let usageSeen = false
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }

  return new Promise<InvocationResult>(resolve => {
    const emit = (event: AdapterEvent) => {
      if (settled) return
      events.push(event)
      if (event.kind === 'result') lastResultEvent = event
      try { hooks.onEvent?.(event) } catch { /* renderer failure must not replay provider actions */ }
    }
    const finish = (code: number | null, timedOut = false, spawnFailed = false) => {
      if (settled) return
      activeTurnId = null
      if (terminal || usageSeen) {
        // Usage arrives before the terminal notification. Preserve observed
        // billable work even after Stop, timeout, or an app-server disconnect.
        // Without a terminal response, a normal exit is still not success.
        const status = terminal?.status ?? (transportFailed || timedOut || spawnFailed || code !== null ? 'failed' : 'interrupted')
        emit({ kind: 'result', payload: {
          session_id: sessionId,
          ...(usageSeen ? { usage: {
            input_tokens: usage.inputTokens,
            cached_input_tokens: usage.cachedInputTokens,
            // The existing adapter adds reasoning_output_tokens to output.
            // App-server outputTokens already includes them: avoid double billing.
            output_tokens: Math.max(0, usage.outputTokens - usage.reasoningOutputTokens),
            reasoning_output_tokens: usage.reasoningOutputTokens,
          } } : {}),
          status,
          ...(typeof terminal?.durationMs === 'number' ? { duration_ms: terminal.durationMs } : {}),
        }, ...(status === 'failed' ? { isError: true } : {}) })
      }
      settled = true
      clearTimeout(inactivityTimer); clearTimeout(wallTimer); clearTimeout(shutdownTimer)
      if (childClosed) clearTimeout(killTimer)
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(request.method === 'turn/steer'
          ? new LiveInputDeliveryError('Codex disconnected before acknowledging the input. Its delivery is unknown; do not resend it automatically.', true)
          : new Error('Codex app-server closed before responding.'))
      }
      pending.clear()
      child?.stdout?.removeListener('data', onStdout)
      child?.stderr?.removeListener('data', onStderr)
      // Keep error listeners on the dying pipes: a late EPIPE must not crash Desktop.
      // Settlement no longer consumes output, so release all pipe handles even
      // when a failed child needs the bounded SIGKILL fallback to finally exit.
      try { child?.stdin?.destroy() } catch { /* best effort */ }
      try { child?.stdout?.destroy() } catch { /* best effort */ }
      try { child?.stderr?.destroy() } catch { /* best effort */ }
      resolve({ code, timedOut, spawnFailed, events, lastResultEvent, sessionId, stderrTail, child })
    }
    const terminate = () => {
      if (!child || childClosed) return
      const signal = (value: NodeJS.Signals) => {
        try {
          if (child?.pid) treeKillSafe(child.pid, value, () => {})
          else child?.kill(value)
        } catch { /* exit/close remain authoritative */ }
      }
      signal('SIGTERM')
      if (!childClosed && !killTimer) {
        killTimer = setTimeout(() => { signal('SIGKILL'); finish(terminal?.status === 'completed' ? 0 : null) }, 2000)
        killTimer.unref?.()
      }
    }
    const fail = (message: string, timedOut = false) => {
      if (settled) return
      transportFailed = true
      emit({ kind: 'error', message })
      finish(null, timedOut)
      terminate()
    }
    const armIdle = () => {
      if (settled || closing || !hooks.inactivityTimeoutMs || hooks.inactivityTimeoutMs <= 0) return
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        hooks.onInactivityTimeout?.()
        fail('Codex stopped reporting progress before the turn completed.', true)
      }, hooks.inactivityTimeoutMs)
      inactivityTimer.unref?.()
    }
    const maybeClose = () => {
      // A completion notification can precede a steering acknowledgement in
      // the same stream. Drain those replies before closing stdin.
      if (!terminal || settled || closing || pending.size > 0) return
      closing = true
      activeTurnId = null
      clearTimeout(inactivityTimer)
      shutdownTimer = setTimeout(terminate, 1500)
      shutdownTimer.unref?.()
      try { child?.stdin?.end() } catch { terminate() }
    }
    const write = (frame: JsonObject) => {
      if (settled || closing || childClosed || !child?.stdin || child.stdin.destroyed) throw new Error('Codex app-server input is closed.')
      child.stdin.write(JSON.stringify(frame) + '\n', error => {
        if (error && !settled) fail('Codex app-server input transport failed. Pending input delivery is unknown.')
      })
    }
    const rpc = (method: string, params: JsonObject, onAccepted?: (value: JsonObject) => void): Promise<JsonObject> => {
      if (settled || closing || childClosed) return Promise.reject(new LiveInputDeliveryError('Codex turn is closed.', false))
      return new Promise((accept, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return
          if (method === 'turn/steer') reject(new LiveInputDeliveryError('Codex did not acknowledge the input in time. Delivery is unknown; do not resend it automatically.', true))
          else reject(new Error(`Codex app-server timed out during ${method}.`))
          maybeClose()
        }, method === 'turn/steer' ? STEER_TIMEOUT_MS : RPC_TIMEOUT_MS)
        timer.unref?.()
        pending.set(id, { method, resolve: accept, reject, timer, onAccepted })
        try { write({ id, method, params }) } catch (error) {
          clearTimeout(timer); pending.delete(id)
          reject(method === 'turn/steer'
            ? new LiveInputDeliveryError('Codex could not confirm writing the input. Delivery is unknown; do not resend it automatically.', true)
            : error)
        }
      })
    }
    const sink: LiveInputSink = {
      // Core acknowledges submission before updating model context or sampling.
      // A matching userMessage item also does not prove model consumption.
      acceptedReceipt: 'received',
      send(input: LiveInput, onAccepted?: () => void): Promise<boolean> {
        if (!input.id || typeof input.text !== 'string' || (input.imagePaths?.some(path => typeof path !== 'string'))) {
          return Promise.reject(new LiveInputDeliveryError('Invalid Codex live input.', false))
        }
        const fingerprint = JSON.stringify([input.text, input.imagePaths ?? []])
        const existing = submissions.get(input.id)
        if (existing) return existing.fingerprint === fingerprint ? existing.promise
          : Promise.reject(new LiveInputDeliveryError('The same live input ID was used for different content.', false))
        const promise = sendChain.then(async () => {
          const expectedTurnId = activeTurnId
          if (!expectedTurnId || terminal || settled || closing || child?.killed) return false
          try {
            await rpc('turn/steer', {
              threadId: sessionId, expectedTurnId,
              clientUserMessageId: input.id, input: userInput(input.text, input.imagePaths),
            }, value => {
              if (value.turnId !== expectedTurnId) throw new LiveInputDeliveryError('Codex acknowledged an unexpected turn. Input delivery is unknown.', true)
              // Commit before parsing the next stdout line, including when ACK
              // and assistant text arrived in one OS pipe chunk.
              try { onAccepted?.() } catch { throw new LiveInputDeliveryError('Codex accepted the input but local confirmation could not be saved. Do not resend it.', true) }
            })
            return true
          } catch (error) {
            if (error instanceof RpcFailure) {
              if (/no active turn|no turn (?:is )?(?:active|running)|(?:expected|active) turn.*(?:mismatch|does not match)|turn.*(?:already (?:completed|finished)|not found)/i.test(error.message)) return false
              throw new LiveInputDeliveryError(`Codex rejected the input: ${error.message}`, false)
            }
            throw error
          }
        })
        submissions.set(input.id, { fingerprint, promise })
        sendChain = promise.catch(() => {})
        return promise
      },
    }

    const item = (value: unknown, completed: boolean) => {
      const entry = object(value), id = string(entry.id), type = string(entry.type)
      if (!id || completedItems.has(id)) return
      if (type === 'agentMessage') {
        if (completed) {
          const text = string(entry.text), previous = messages.get(id) ?? ''
          if (text.startsWith(previous) && text.length > previous.length) emit({ kind: 'text-delta', text: text.slice(previous.length) })
          messages.set(id, text)
        }
      } else if (['commandExecution', 'mcpToolCall', 'fileChange', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'].includes(type)) {
        if (!startedTools.has(id)) {
          startedTools.add(id)
          emit({ kind: 'tool-use', toolUseId: id,
            name: type === 'mcpToolCall' ? `${string(entry.server)}.${string(entry.tool)}` : type,
            inputPreview: preview(entry.command ?? entry.arguments ?? entry.changes ?? entry.prompt ?? entry.query ?? '', 1000) })
        }
        if (completed) emit({ kind: 'tool-result', toolUseId: id,
          outputPreview: preview(entry.aggregatedOutput ?? entry.result ?? entry.error ?? entry.changes ?? entry.contentItems ?? { status: entry.status }),
          ...(['failed', 'declined'].includes(string(entry.status)) || entry.success === false || (typeof entry.exitCode === 'number' && entry.exitCode !== 0) || entry.error ? { isError: true } : {}) })
      }
      if (completed) completedItems.add(id)
    }
    const notification = (method: string, params: JsonObject) => {
      if (settled) return
      if (method === 'thread/started') return // only the requested thread's response establishes identity
      if (params.threadId !== sessionId || !sessionId) return
      if (method === 'thread/tokenUsage/updated') {
        const snapshot = object(params.tokenUsage), total = object(snapshot.total), last = object(snapshot.last)
        if (!activeTurnId || params.turnId !== activeTurnId) {
          if (!turnRequested) baselineUsage = total
          return
        }
        if (terminal) return
        const previous = lastTotal ?? baselineUsage
        for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += previous
          ? Math.max(0, count(total[key]) - count(previous[key])) : count(last[key])
        lastTotal = total; usageSeen = true
        return
      }
      if (method === 'turn/started') {
        const turn = object(params.turn), id = string(turn.id)
        if (turnRequested && !terminal && !activeTurnId && id) activeTurnId = id
        return
      }
      const turn = object(params.turn)
      const turnId = string(params.turnId) || string(turn.id)
      if (!turnRequested || !turnId || (activeTurnId && turnId !== activeTurnId)) return
      // The initial turn may complete before its start response is flushed.
      if (!activeTurnId && !terminal) activeTurnId = turnId
      if (terminal) return
      if (method === 'item/agentMessage/delta') {
        const id = string(params.itemId), delta = string(params.delta)
        if (id && delta && !completedItems.has(id)) { messages.set(id, (messages.get(id) ?? '') + delta); emit({ kind: 'text-delta', text: delta }) }
      } else if (method === 'item/started' || method === 'item/completed') item(params.item, method === 'item/completed')
      else if (method === 'error') {
        const error = string(object(params.error).message) || 'Codex reported an error.'
        if (params.willRetry === true) emit({ kind: 'other', type: 'codex.retrying', raw: { message: error } })
        else emit({ kind: 'error', message: error })
      } else if (method === 'turn/completed') {
        if (!['completed', 'failed', 'interrupted'].includes(string(turn.status))) { fail('Codex returned an invalid terminal turn status.'); return }
        if (Array.isArray(turn.items)) turn.items.forEach(entry => item(entry, true))
        terminal = turn
        activeTurnId = null
        if (turn.status === 'failed') emit({ kind: 'error', message: string(object(turn.error).message) || 'Codex turn failed.' })
        maybeClose()
      }
    }
    const frame = (value: unknown) => {
      const record = object(value), id = record.id
      if (typeof record.method === 'string') {
        if (typeof id === 'string' || typeof id === 'number') {
          // No approval is inferred from a server request. Native commands keep
          // the requested sandbox; MCP permissions remain in the MCP server.
          if (record.method === 'item/commandExecution/requestApproval' || record.method === 'item/fileChange/requestApproval') write({ id, result: { decision: 'decline' } })
          else if (record.method === 'item/tool/requestUserInput') write({ id, result: { answers: {} } })
          else write({ id, error: { code: -32601, message: 'This client does not implement that request. Ask the user in the mission conversation when input is needed.' } })
        } else notification(record.method, object(record.params))
        return
      }
      if (typeof id !== 'number' && typeof id !== 'string') return
      const request = pending.get(id)
      if (!request) return
      pending.delete(id); clearTimeout(request.timer)
      if (record.error) {
        const error = object(record.error)
        request.reject(new RpcFailure(string(error.message) || 'Codex rejected the request.', typeof error.code === 'number' ? error.code : undefined))
      } else if ('result' in record) {
        const result = object(record.result)
        try { request.onAccepted?.(result); request.resolve(result) } catch (error) {
          request.reject(error as Error)
          if (request.method === 'turn/steer' && error instanceof LiveInputDeliveryError && error.ambiguous) fail(error.message)
        }
      } else request.reject(new LiveInputDeliveryError('Codex returned a malformed acknowledgement. Delivery is unknown.', request.method === 'turn/steer'))
      maybeClose()
    }
    function onStdout(chunk: Buffer | string) {
      if (settled) return
      armIdle(); hooks.onData?.('stdout')
      lineBuffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      for (;;) {
        const end = lineBuffer.indexOf('\n')
        if (end < 0) {
          if (Buffer.byteLength(lineBuffer) > MAX_FRAME_BYTES) fail('Codex app-server exceeded the protocol frame limit.')
          return
        }
        const line = lineBuffer.slice(0, end).replace(/\r$/, '')
        lineBuffer = lineBuffer.slice(end + 1)
        if (!line.trim()) continue
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { fail('Codex app-server exceeded the protocol frame limit.'); return }
        try { hooks.onStdoutLine?.(line); frame(JSON.parse(line)) }
        catch { fail('Codex app-server returned an invalid protocol frame.'); return }
        if (settled) return
      }
    }
    function onStderr(chunk: Buffer | string) {
      if (settled) return
      armIdle(); hooks.onData?.('stderr')
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-STDERR_CAP)
      if (hooks.onStderrLine) for (const line of text.split(/\r?\n/).filter(Boolean)) hooks.onStderrLine(line)
    }

    if (!opts || hooks.adapter.id !== 'codex' || !['chat-turn', 'chat-resume'].includes(hooks.action ?? '')) {
      emit({ kind: 'error', message: 'Codex live sessions require chat-turn/chat-resume build options.' })
      finish(null, false, true)
      return
    }
    if (hooks.action === 'chat-resume' && !opts.sessionId) {
      emit({ kind: 'error', message: 'Codex live resume requires a session id.' }); finish(null, false, true); return
    }
    if (opts.toolPolicy === 'none') {
      emit({ kind: 'error', message: 'Codex cannot enforce a no-tools live session.' }); finish(null, false, true); return
    }
    try {
      child = (hooks.spawn ?? spawnAiCli)(hooks.binary ?? hooks.adapter.binary, ['app-server', '--listen', 'stdio://', ...(opts.extraArgs ?? [])], {
        cwd: hooks.cwd, env: buildProviderEnv(hooks.adapter, opts, hooks.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      hooks.onSpawnError?.(error as Error)
      emit({ kind: 'error', message: error instanceof Error ? error.message : 'Could not spawn Codex app-server.' })
      finish(null, false, true); return
    }
    child.on('error', error => { hooks.onSpawnError?.(error); emit({ kind: 'error', message: error.message }); finish(null, false, true) })
    child.on('close', code => {
      childClosed = true; clearTimeout(killTimer)
      if (!settled && !terminal) emit({ kind: 'error', message: 'Codex app-server closed before the turn completed.' })
      finish(terminal?.status === 'completed' ? 0 : terminal?.status === 'failed' ? 1 : terminal?.status === 'interrupted' ? null : code)
    })
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.stdin?.on('error', () => { if (!settled) fail('Codex app-server input transport failed. Pending input delivery is unknown.') })
    hooks.onSpawn?.(child)
    if (settled) return
    if (!child.stdin || !child.stdout) { fail('Codex app-server requires stdin/stdout pipes.'); return }
    armIdle()
    if (hooks.timeoutMs && hooks.timeoutMs > 0) {
      wallTimer = setTimeout(() => { hooks.onTimeout?.(); fail('Codex live turn exceeded its time limit.', true) }, hooks.timeoutMs)
      wallTimer.unref?.()
    }
    void (async () => {
      try {
        await rpc('initialize', { clientInfo: { name: 'specrails_desktop', title: 'Specrails Desktop', version: '1.0.0' }, capabilities: { experimentalApi: true } })
        write({ method: 'initialized' })
        const thread = await rpc(hooks.action === 'chat-resume' ? 'thread/resume' : 'thread/start', {
          ...(hooks.action === 'chat-resume' ? { threadId: opts.sessionId } : {}),
          model: opts.model, cwd: hooks.cwd, approvalPolicy: 'never', sandbox: opts.toolPolicy === 'read-only' ? 'read-only' : 'workspace-write',
        })
        sessionId = string(object(thread.thread).id) || null
        if (!sessionId) throw new Error('Codex did not return a thread id.')
        if (hooks.action === 'chat-resume' && sessionId !== opts.sessionId) throw new Error('Codex resumed an unexpected thread.')
        emit({ kind: 'session-started', sessionId })
        turnRequested = true
        await rpc('turn/start', {
          threadId: sessionId, input: userInput(opts.prompt, opts.imagePaths), model: opts.model,
          ...(opts.reasoning_effort ? { effort: opts.reasoning_effort } : {}),
        }, response => {
          const turn = object(response.turn), id = string(turn.id)
          if (!id || (activeTurnId && id !== activeTurnId)) throw new Error('Codex did not acknowledge the expected turn.')
          if (!terminal) activeTurnId = id
          hooks.onInitialInputAccepted?.()
          // A fast turn can already be terminal in this response. Publish that
          // state before exposing the sink so queued input remains unsent.
          if (!terminal && ['completed', 'failed', 'interrupted'].includes(string(turn.status))) {
            notification('turn/completed', { threadId: sessionId, turn })
          }
          if (!inputReady) { inputReady = true; hooks.onInputReady?.(sink) }
        })
      } catch (error) {
        if (!settled) fail(error instanceof Error ? error.message : 'Codex live session failed to initialize.')
      }
    })()
  })
}
