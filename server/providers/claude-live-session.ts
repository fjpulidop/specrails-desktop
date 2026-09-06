import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import { treeKillSafe as treeKill } from '../util/win-spawn'
import { spawnAiCli } from '../util/cli-prompt'
import type { InvocationResult } from '../spawn-lifecycle'
import { buildProviderEnv, parseStreamEvents } from './runtime'
import { LiveInputDeliveryError, type LiveInput, type LiveSessionHooks } from './live-session-types'
import type { AdapterEvent } from './types'

// Claude Code 2.1.261: stdin user frames enter the native command queue. The
// query loop handles priority "next" messages after the running tool batch and
// re-emits the queued_command as {type:"user",isReplay:true,uuid:source_uuid}.
// That replay precedes committing absorption and may also precede a cancelled
// turn or hooks: it confirms receipt, not model consumption. Reading requires
// an explicit agent acknowledgement. A successful stdin.write only means bytes
// were buffered, so it is never an acknowledgement.
// https://code.claude.com/docs/en/cli-reference#cli-flags
// https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
// We deliberately do not issue control_request/interrupt for steering: that
// aborts Claude's active tools rather than letting their results finish.

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const STDERR_CAP = 64 * 1024
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}

interface PendingInput {
  id: string
  nativeId: string
  fingerprint: string
  written: boolean
  promise: Promise<boolean>
  resolve: (accepted: boolean) => void
  reject: (error: LiveInputDeliveryError) => void
  onAccepted?: () => void
}

async function inputContent(input: LiveInput): Promise<string | unknown[]> {
  if (!input.imagePaths?.length) return input.text
  const content: unknown[] = [{ type: 'text', text: input.text }]
  let remaining = MAX_IMAGE_BYTES
  for (const imagePath of input.imagePaths) {
    try {
      const mimeType = IMAGE_TYPES[path.extname(imagePath).toLowerCase()]
      if (!mimeType) throw new Error('unsupported image type')
      // Read at most the remaining budget + one byte through one file handle:
      // a growing file cannot evade a stat-then-read limit and exhaust memory.
      const file = await open(imagePath, 'r')
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > remaining) throw new Error('the images exceed the 8 MiB input budget')
        const bytes = Buffer.alloc(remaining + 1)
        let length = 0
        for (;;) {
          const read = await file.read(bytes, length, bytes.length - length, null)
          length += read.bytesRead
          if (length > remaining) throw new Error('the images exceed the 8 MiB input budget')
          if (read.bytesRead === 0) break
        }
        remaining -= length
        content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: bytes.subarray(0, length).toString('base64') } })
      } finally { await file.close() }
    } catch (error) {
      content.push({ type: 'text', text: `[Image attachment ${imagePath} was not delivered: ${error instanceof Error ? error.message : String(error)}. The original attachment is retained by Specrails. Do not infer its contents.]` })
    }
  }
  return content
}

/** One native Claude process, accepting input until its final result. Tool
 * batches finish normally. If an update misses a fold boundary Claude may
 * process it as a subsequent native turn in the SAME process; keep stdin open
 * until those written inputs have been echoed and their result has arrived. */
export function runClaudeLiveSession(hooks: LiveSessionHooks): Promise<InvocationResult> {
  if (hooks.adapter.id !== 'claude' || !hooks.buildOpts) throw new Error('Claude live sessions require the Claude adapter and buildOpts.')
  const opts = hooks.buildOpts
  return new Promise<InvocationResult>(resolveInvocation => {
    const events: AdapterEvent[] = []
    const pending = new Map<string, PendingInput>()
    const submitted = new Map<string, PendingInput>()
    const initialId = randomUUID()
    let child: ChildProcess | null = null
    let ended = false
    let accepting = true
    let initialWritten = false
    let initialAccepted = false
    let sessionId: string | null = opts.sessionId ?? null
    let lastResultEvent: AdapterEvent | null = null
    let stderrTail = ''
    let promptDirectory: string | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let inactivity: ReturnType<typeof setTimeout> | undefined
    let closeDeadline: ReturnType<typeof setTimeout> | undefined
    let stdoutReader: ReturnType<typeof createInterface> | undefined
    let stderrReader: ReturnType<typeof createInterface> | undefined
    let writeSequence = Promise.resolve()
    let escalation: ReturnType<typeof setTimeout> | undefined

    const rejectPending = (reason: string) => {
      for (const input of pending.values()) {
        if (input.written) input.reject(new LiveInputDeliveryError(reason, true))
        else input.resolve(false)
      }
      pending.clear()
    }
    const settle = (code: number | null, timedOut = false, spawnFailed = false) => {
      if (ended) return
      ended = true
      accepting = false
      clearTimeout(timeout); clearTimeout(inactivity); clearTimeout(closeDeadline)
      rejectPending('Claude ended before acknowledging the live input. Delivery is uncertain; do not replay automatically.')
      stdoutReader?.close(); stderrReader?.close()
      // Leave the child's close/error listeners in place until it exits, so
      // late EPIPE is contained and close cancels the owned SIGKILL deadline.
      try { child?.stdin?.destroy() } catch { /* best effort */ }
      try { child?.stdout?.destroy() } catch { /* best effort */ }
      try { child?.stderr?.destroy() } catch { /* best effort */ }
      if (promptDirectory) { try { rmSync(promptDirectory, { recursive: true, force: true }) } catch { /* best effort */ } }
      resolveInvocation({ code, timedOut, spawnFailed, events, lastResultEvent, sessionId, stderrTail, child })
    }
    const terminate = () => {
      if (!child || escalation) return
      try { if (child.pid) treeKill(child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { /* child already gone */ }
      const ownedChild = child
      escalation = setTimeout(() => {
        try { if (ownedChild.pid) treeKill(ownedChild.pid, 'SIGKILL'); else ownedChild.kill('SIGKILL') } catch { /* already gone */ }
      }, 2000)
      escalation.unref?.()
      ownedChild.once('close', () => clearTimeout(escalation))
    }
    const expire = (kind: 'wall' | 'inactivity') => {
      if (ended) return
      if (kind === 'wall') hooks.onTimeout?.()
      else hooks.onInactivityTimeout?.()
      terminate()
      settle(null, true)
    }
    const activity = () => {
      clearTimeout(inactivity)
      if (!ended && hooks.inactivityTimeoutMs && hooks.inactivityTimeoutMs > 0) {
        inactivity = setTimeout(() => expire('inactivity'), hooks.inactivityTimeoutMs)
        inactivity.unref?.()
      }
    }
    const event = (value: AdapterEvent) => {
      events.push(value)
      if (value.kind === 'session-started') sessionId = value.sessionId
      if (value.kind === 'result') {
        lastResultEvent = value
        if (typeof value.payload.session_id === 'string') sessionId = value.payload.session_id
      }
      hooks.onEvent?.(value)
    }
    const send = (input: LiveInput, onAccepted?: () => void): Promise<boolean> => {
      const fingerprint = JSON.stringify([input.text, input.imagePaths ?? []])
      const existing = submitted.get(input.id)
      if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(new LiveInputDeliveryError('Live input ID already has different content.', existing.written))
      if (!accepting || ended || !child?.stdin || child.stdin.destroyed || child.stdin.writableEnded || child.killed) return Promise.resolve(false)
      let resolve!: PendingInput['resolve'], reject!: PendingInput['reject']
      const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
      const entry: PendingInput = { id: input.id, nativeId: randomUUID(), fingerprint, written: false, promise, resolve, reject, onAccepted }
      submitted.set(input.id, entry)
      pending.set(entry.nativeId, entry)
      const writing = writeSequence.then(async () => {
        if (!accepting || ended) { pending.delete(entry.nativeId); entry.resolve(false); return }
        const content = await inputContent(input)
        if (!accepting || ended || !child?.stdin || child.stdin.destroyed || child.stdin.writableEnded || child.killed) {
          pending.delete(entry.nativeId); entry.resolve(false); return
        }
        // Mark BEFORE write: a custom writable can synchronously emit the echo,
        // and an EPIPE callback cannot prove no bytes reached the CLI.
        entry.written = true
        child.stdin.write(JSON.stringify({ type: 'user', uuid: entry.nativeId, session_id: sessionId ?? '',
          parent_tool_use_id: null, priority: 'next', message: { role: 'user', content } }) + '\n', error => {
          if (!error) return
          pending.delete(entry.nativeId)
          entry.reject(new LiveInputDeliveryError(`Claude input write failed: ${error.message}`, true))
        })
      })
      // Keep input order even when an earlier message reads a large image.
      // Waiting for its write (not its echo) still permits genuine streaming.
      writeSequence = writing.catch(() => {})
      void writing.catch(error => {
        pending.delete(entry.nativeId)
        entry.reject(error instanceof LiveInputDeliveryError ? error : new LiveInputDeliveryError(error instanceof Error ? error.message : String(error), entry.written))
      })
      return promise
    }
    const finishAfterResult = () => {
      if (ended || !accepting) return
      accepting = false
      // Any image preparation which has NOT written yet can safely use the
      // caller's ordinary continuation. Written entries must first receive ACK.
      for (const [id, input] of pending) if (!input.written) { pending.delete(id); input.resolve(false) }
      child?.stdin?.end()
      // The native turn has finished; EOF should close its resident process.
      // Reap a CLI that ignores EOF, without aborting an active tool batch.
      closeDeadline = setTimeout(() => { terminate(); settle(0) }, 2000)
      closeDeadline.unref?.()
    }

    try {
      let spawnOpts = opts
      const extraArgs = [...(opts.extraArgs ?? []), '--replay-user-messages']
      // The shared Windows wrapper moves inline prompt flags to stdin and ends
      // it. A private prompt FILE avoids that transform for this live channel.
      if (process.platform === 'win32' && opts.systemPrompt) {
        promptDirectory = mkdtempSync(path.join(tmpdir(), 'specrails-claude-live-'))
        const promptFile = path.join(promptDirectory, 'system.txt')
        writeFileSync(promptFile, opts.systemPrompt, { mode: 0o600 })
        extraArgs.push('--system-prompt-file', promptFile)
        spawnOpts = { ...opts, systemPrompt: undefined }
      }
      const args = hooks.adapter.buildArgs('chat-stream', { ...spawnOpts, extraArgs })
      child = (hooks.spawn ?? spawnAiCli)(hooks.binary ?? hooks.adapter.binary, args, {
        cwd: hooks.cwd, env: buildProviderEnv(hooks.adapter, opts, hooks.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      hooks.onSpawnError?.(error as Error)
      settle(null, false, true)
      return
    }
    child.on('error', error => { hooks.onSpawnError?.(error); settle(null, false, true) })
    child.on('close', code => {
      if (!ended && !lastResultEvent && !child?.killed) event({ kind: 'error', message: 'Claude closed before producing a terminal result.' })
      settle(code)
    })
    child.stdin?.on('error', error => {
      if (ended) return
      rejectPending(`Claude stdin failed: ${error.message}; delivery is uncertain.`)
      event({ kind: 'error', message: `Claude stdin failed: ${error.message}` })
      terminate(); settle(null)
    })
    if (!child.stdout || !child.stdin) { terminate(); settle(null, false, true); return }
    stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    child.stdout.on('data', () => { activity(); hooks.onData?.('stdout') })
    stdoutReader.on('line', line => {
      if (ended) return
      try {
        hooks.onStdoutLine?.(line)
        let raw: Record<string, any> | undefined
        try { raw = JSON.parse(line) } catch { /* adapter ignores malformed lines */ }
        if (raw?.type === 'user' && raw.isReplay === true && raw.parent_tool_use_id == null && raw.message?.role === 'user' && typeof raw.uuid === 'string') {
          if (raw.uuid === initialId && initialWritten && !initialAccepted) {
            initialAccepted = true
            hooks.onInitialInputAccepted?.()
          }
          const input = pending.get(raw.uuid)
          if (input?.written) {
            pending.delete(raw.uuid)
            try { input.onAccepted?.(); input.resolve(true) }
            catch (error) { input.reject(new LiveInputDeliveryError(`Claude accepted the input but local acknowledgement failed: ${String(error)}`, true)) }
          }
          // Echoes carry input resources, not tool outcomes or generated text.
          return
        }
        for (const parsed of parseStreamEvents(hooks.adapter, line)) {
          event(parsed)
          if (parsed.kind === 'result') {
            if (parsed.isError) {
              const errors = parsed.payload.errors
              const reason = typeof parsed.payload.result === 'string' && parsed.payload.result || (Array.isArray(errors) ? errors.join('\n') : 'Claude returned an error result.')
              event({ kind: 'error', message: String(reason) })
              rejectPending('Claude failed before confirming the input. Do not replay automatically.')
              finishAfterResult()
            } else if (initialWritten && ![...pending.values()].some(input => input.written)) finishAfterResult()
          }
        }
      } catch (error) {
        // A callback/parser must not throw out of an EventEmitter into the
        // sidecar's uncaught-exception handler.
        console.error('[claude-live-session] stdout handler failed:', error)
      }
    })
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        activity(); hooks.onData?.('stderr')
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_CAP)
      })
      if (hooks.onStderrLine) {
        stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity })
        stderrReader.on('line', line => hooks.onStderrLine?.(line))
      }
    }
    hooks.onSpawn?.(child)
    activity()
    if (hooks.timeoutMs && hooks.timeoutMs > 0) {
      timeout = setTimeout(() => expire('wall'), hooks.timeoutMs)
      timeout.unref?.()
    }
    // Initial content also uses the native channel, with a unique UUID. The
    // caller owns initial-message persistence; replay confirms its receipt.
    void inputContent({ id: initialId, text: opts.prompt, imagePaths: opts.imagePaths }).then(content => {
      if (ended || !accepting || !child?.stdin || child.killed || child.stdin.destroyed) return
      initialWritten = true
      child.stdin.write(JSON.stringify({ type: 'user', uuid: initialId, session_id: sessionId ?? '', parent_tool_use_id: null,
        priority: 'next', message: { role: 'user', content } }) + '\n', error => {
        if (error) { event({ kind: 'error', message: `Claude initial input failed: ${error.message}` }); terminate(); settle(null) }
      })
      hooks.onInputReady?.({ send, acceptedReceipt: 'received' })
    }).catch(error => { event({ kind: 'error', message: `Claude initial input failed: ${String(error)}` }); terminate(); settle(null) })
  })
}
