// Shared AI-CLI spawn lifecycle.
//
// Every AI-CLI invocation in the app (agent-refine, contract-refine, quick-spec,
// setup-enrich, explore chat, rail jobs) shares the same boilerplate: spawn the
// provider binary, read stdout line-by-line through `adapter.parseStreamLine`
// into an AdapterEvent[] accumulator, capture the session id, drain stderr, and
// settle once on `close` (or a wall-clock timeout / spawn error). This module
// owns exactly that core and nothing more — the genuinely-unique bits (how a
// callsite renders deltas, finalizes invocation accounting, validates output,
// manages crash-respawn / idle-kill) stay with the caller via hooks + the
// returned result. Adopting it is behaviour-preserving: the caller keeps every
// post-close decision it had, just without re-implementing the plumbing.

import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import treeKill from 'tree-kill'
import { spawnAiCli } from './util/cli-prompt'
import type { ProviderAdapter, AdapterEvent, SpawnAction, SpawnOptions } from './providers/types'

/** Node child_process spawn options the lifecycle forwards verbatim. */
interface NodeSpawnOpts {
  env?: NodeJS.ProcessEnv
  cwd?: string
  stdio?: Parameters<typeof spawnAiCli>[2] extends infer O ? (O extends { stdio?: infer S } ? S : unknown) : unknown
}

export interface RunInvocationHooks {
  /** Resolved adapter for THIS invocation (per-job / per-conversation). */
  adapter: ProviderAdapter
  /** Build argv from the adapter (common path) … */
  action?: SpawnAction
  buildOpts?: SpawnOptions
  /** … OR supply hand-rolled argv (contract-refine). One of action/argv required. */
  argv?: string[]
  /** Binary override; defaults to `adapter.binary`. */
  binary?: string
  cwd: string
  /** Env for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** stdio override; defaults to ['ignore','pipe','pipe']. */
  stdio?: NodeSpawnOpts['stdio']
  /** Injectable spawn fn (tests). Defaults to spawnAiCli. */
  spawn?: typeof spawnAiCli

  /** Called once with the spawned child so the caller can register it for
   *  cancel/kill before any output arrives. */
  onSpawn?: (child: ChildProcess) => void
  /** Every parsed AdapterEvent (already pushed to the accumulator). The caller
   *  renders text-delta/tool-use/etc. to its own WS shape here. */
  onEvent?: (ev: AdapterEvent) => void
  /** Every raw stdout line BEFORE adapter parse — for callsites that ALSO
   *  JSON.parse the raw line (queue-manager appendEvent, spec-gen dual path). */
  onStdoutLine?: (line: string) => void
  /** Every raw stderr line. When omitted, stderr is drained into `stderrTail`. */
  onStderrLine?: (line: string) => void
  /** Fires on every raw stdout/stderr 'data' chunk (drives a zombie/idle timer
   *  synchronously, before readline buffers). */
  onData?: (source: 'stdout' | 'stderr') => void
  /** spawn 'error' (ENOENT). The caller surfaces a WS error here. */
  onSpawnError?: (err: Error) => void

  /** Optional wall-clock watchdog. On fire the child is killed and the run
   *  settles with `timedOut: true`. */
  timeoutMs?: number
  onTimeout?: () => void
}

export interface InvocationResult {
  /** Exit code, or null if killed/timed out before exit. */
  code: number | null
  timedOut: boolean
  /** True when the spawn itself threw / emitted 'error' (ENOENT). */
  spawnFailed: boolean
  /** All parsed AdapterEvents (hand to finaliseInvocationResult). */
  events: AdapterEvent[]
  /** Last kind:'result' event, for callers needing the raw payload. */
  lastResultEvent: AdapterEvent | null
  /** Session id captured last-wins from session-started / result events. */
  sessionId: string | null
  /** Drained stderr (capped) when no onStderrLine override was given. */
  stderrTail: string
  /** The spawned child (also delivered synchronously via onSpawn). */
  child: ChildProcess | null
}

const STDERR_TAIL_CAP = 64 * 1024

/**
 * Run one AI-CLI invocation: spawn → stream → settle. Resolves exactly once on
 * child 'close', a spawn 'error', or the optional timeout. Never rejects — a
 * failure is reported via the result (`spawnFailed`/`timedOut`/`code`). The
 * caller does all post-close work (finalise/record/validate) from the returned
 * events.
 */
export function runAiCliInvocation(hooks: RunInvocationHooks): Promise<InvocationResult> {
  const binary = hooks.binary ?? hooks.adapter.binary
  const args = hooks.argv ?? hooks.adapter.buildArgs(hooks.action as SpawnAction, hooks.buildOpts as SpawnOptions)
  const spawn = hooks.spawn ?? spawnAiCli

  const events: AdapterEvent[] = []
  let lastResultEvent: AdapterEvent | null = null
  let sessionId: string | null = null
  let stderrTail = ''

  return new Promise<InvocationResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (partial: { code: number | null; timedOut: boolean; spawnFailed: boolean; child: ChildProcess | null }) => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      resolve({ ...partial, events, lastResultEvent, sessionId, stderrTail })
    }

    let child: ChildProcess
    try {
      child = spawn(binary, args, {
        env: hooks.env ?? process.env,
        stdio: hooks.stdio ?? ['ignore', 'pipe', 'pipe'],
        cwd: hooks.cwd,
      } as Parameters<typeof spawnAiCli>[2])
    } catch (err) {
      hooks.onSpawnError?.(err as Error)
      settle({ code: null, timedOut: false, spawnFailed: true, child: null })
      return
    }
    hooks.onSpawn?.(child)

    if (hooks.timeoutMs != null) {
      timer = setTimeout(() => {
        hooks.onTimeout?.()
        // treeKill the whole subtree (a bare child.kill leaves grandchildren),
        // then escalate to SIGKILL after a grace window if the child ignores
        // SIGTERM — otherwise a hung, signal-swallowing CLI is orphaned for the
        // host's lifetime. (Mirrors QueueManager._kill.)
        if (child.pid) {
          treeKill(child.pid, 'SIGTERM')
          const pid = child.pid
          const killTimer = setTimeout(() => {
            try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
          }, 2000)
          killTimer.unref?.()
          child.once('close', () => clearTimeout(killTimer))
        } else {
          try { child.kill('SIGTERM') } catch { /* already gone */ }
        }
        settle({ code: null, timedOut: true, spawnFailed: false, child })
      }, hooks.timeoutMs)
    }

    if (child.stdout) {
      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      if (hooks.onData) child.stdout.on('data', () => hooks.onData!('stdout'))
      reader.on('line', (line) => {
        hooks.onStdoutLine?.(line)
        const ev = hooks.adapter.parseStreamLine(line)
        if (!ev) return
        events.push(ev)
        if (ev.kind === 'session-started') {
          sessionId = ev.sessionId
        } else if (ev.kind === 'result') {
          lastResultEvent = ev
          const sid = (ev.payload as { session_id?: string }).session_id
          if (sid) sessionId = sid
        }
        hooks.onEvent?.(ev)
      })
    }

    if (child.stderr) {
      if (hooks.onStderrLine) {
        const errReader = createInterface({ input: child.stderr, crlfDelay: Infinity })
        if (hooks.onData) child.stderr.on('data', () => hooks.onData!('stderr'))
        errReader.on('line', (line) => hooks.onStderrLine!(line))
      } else {
        child.stderr.on('data', (chunk: Buffer) => {
          if (hooks.onData) hooks.onData('stderr')
          if (stderrTail.length < STDERR_TAIL_CAP) stderrTail += chunk.toString()
        })
      }
    }

    child.on('error', (err) => {
      hooks.onSpawnError?.(err)
      settle({ code: null, timedOut: false, spawnFailed: true, child })
    })
    child.on('close', (code) => {
      settle({ code, timedOut: false, spawnFailed: false, child })
    })
  })
}
