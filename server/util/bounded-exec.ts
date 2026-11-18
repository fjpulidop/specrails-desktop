// Non-blocking, time-bounded child process execution.
//
// The server runs on one event loop: every `execSync` / `execFileSync` /
// `spawnSync` freezes HTTP, WebSocket and queue work for its whole duration
// (provider `--version` probes took ~1 s each; `npm install` up to 180 s).
// `execBounded` is the async replacement used on request and background paths:
// it buffers stdout/stderr, enforces a hard timeout and, on timeout, kills the
// WHOLE process tree (a shell or `npm` wrapper would otherwise leave its child
// running after the direct pid dies).

import { spawn } from 'child_process'
import { treeKillSafe } from './win-spawn'
import { gitInvocationEnv, isGitCommand } from './git-invocation'

export interface BoundedExecOptions {
  /** Hard ceiling in ms; the process tree is killed when it elapses. */
  timeoutMs: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Run `command` through the platform shell (cmd.exe on Windows, so `.cmd` shims resolve). */
  shell?: boolean
  /** Written to stdin, which is then closed. Without it stdin is ignored. */
  input?: string
  /** Max bytes kept per stream (excess is dropped, not an error). Default 4 MiB. */
  maxBuffer?: number
  /** Grace between the SIGTERM tree-kill and SIGKILL. Default 2000 ms. */
  killGraceMs?: number
}

export interface BoundedExecResult {
  stdout: string
  stderr: string
  /** Exit code; null when killed by a signal or when the spawn failed. */
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** True when stdout exceeded `maxBuffer` and the excess was dropped. Callers
   *  that must treat an overflow as a failure (like `execFileSync`'s ENOBUFS)
   *  check this instead of parsing a partial stream. */
  stdoutTruncated?: boolean
  /** Spawn failure (ENOENT, EACCES, …). */
  error?: Error
}

export class BoundedExecError extends Error {
  readonly result: BoundedExecResult
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
  readonly timedOut: boolean
  constructor(message: string, result: BoundedExecResult) {
    super(message)
    this.name = 'BoundedExecError'
    this.result = result
    this.stdout = result.stdout
    this.stderr = result.stderr
    this.status = result.code
    this.timedOut = result.timedOut
  }
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024

/** Run a command to completion without blocking the event loop. Never rejects. */
export function runBounded(command: string, args: readonly string[], opts: BoundedExecOptions): Promise<BoundedExecResult> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  const grace = opts.killGraceMs ?? 2000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let stdoutTruncated = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    let forceSettleTimer: NodeJS.Timeout | null = null
    const finish = (result: Omit<BoundedExecResult, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (forceSettleTimer) clearTimeout(forceSettleTimer)
      resolve({ stdout, stderr, timedOut, ...(stdoutTruncated ? { stdoutTruncated } : {}), ...result })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        // Read-only git skips optional index locks (see git-invocation.ts).
        env: isGitCommand(command) ? gitInvocationEnv(opts.env, args) : opts.env,
        shell: opts.shell ?? false,
        windowsHide: true,
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ stdout: '', stderr: '', code: null, signal: null, timedOut: false, error: err as Error })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      const pid = child.pid
      if (pid) {
        treeKillSafe(pid, 'SIGTERM')
        killTimer = setTimeout(() => treeKillSafe(pid, 'SIGKILL'), grace)
        killTimer.unref?.()
      } else {
        child.kill('SIGKILL')
      }
      // A grandchild that inherited our pipes can keep 'close' from firing;
      // never let the caller wait past the kill grace.
      forceSettleTimer = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), grace + 1000)
      forceSettleTimer.unref?.()
    }, opts.timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const room = maxBuffer - stdout.length
      if (chunk.length > room) stdoutTruncated = true
      if (room > 0) stdout += chunk.slice(0, room)
    })
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < maxBuffer) stderr += chunk.slice(0, maxBuffer - stderr.length) })
    child.on('error', (error) => finish({ code: null, signal: null, error }))
    child.on('close', (code, signal) => finish({ code, signal }))
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* child exited before reading stdin */ })
      child.stdin.end(opts.input)
    }
  })
}

function describe(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}

/**
 * Run a command and resolve its stdout. Rejects with `BoundedExecError` on a
 * spawn failure, a non-zero exit, a signal or a timeout.
 */
export async function execBounded(command: string, args: readonly string[], opts: BoundedExecOptions): Promise<string> {
  const result = await runBounded(command, args, opts)
  if (result.error) throw new BoundedExecError(`${describe(command, args)} failed to start: ${result.error.message}`, result)
  if (result.timedOut) throw new BoundedExecError(`${describe(command, args)} timed out after ${opts.timeoutMs} ms`, result)
  if (result.code !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' ')
    throw new BoundedExecError(
      `${describe(command, args)} exited with ${result.code ?? result.signal}${detail ? `: ${detail}` : ''}`,
      result,
    )
  }
  return result.stdout
}
