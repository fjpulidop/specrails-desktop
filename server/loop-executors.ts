/**
 * Production executors for the LoopRunManager. Thin glue that wires the engine's
 * injected `runAiStep` / `runShell` / `runDecider` hooks to the real spawn
 * machinery (`runAiCliInvocation` + the provider adapter + a shell spawn). This
 * file is process-spawning glue — like `browser-playwright.ts`, it is excluded
 * from coverage; the engine's traversal/decision logic is unit-tested against
 * fake executors in `loop-run-manager.test.ts`.
 */
import { spawn } from 'node:child_process'
import treeKill from 'tree-kill'
import { getAdapter } from './providers'
import { ensureFrameworkAgents } from './workspace-manager'
import { runAiCliInvocation } from './spawn-lifecycle'
import { finaliseInvocationResult } from './result-event'
import { parseDeciderDecision } from './loop-decider'
import type { LoopExecutors, ShellResult } from './loop-run-manager'

// Per-step wall-clock caps so a single hung step can't block the engine's
// overall deadline check (which only runs between nodes).
const AI_STEP_TIMEOUT_MS = 15 * 60_000
const DECIDER_TIMEOUT_MS = 3 * 60_000
const SHELL_TIMEOUT_MS = 10 * 60_000
const SHELL_OUTPUT_CAP = 256 * 1024

function runShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onLine?: (line: string, source?: 'stdout' | 'stderr') => void,
  onSpawn?: (child: ReturnType<typeof spawn>) => void
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
    const start = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: isWin,
      })
    } catch {
      resolve({ stdout: '', stderr: 'failed to spawn shell', exitCode: -1, durationMs: 0 })
      return
    }
    onSpawn?.(child)

    const done = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: Date.now() - start })
    }
    const timer = setTimeout(() => {
      if (child.pid) {
        try { treeKill(child.pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
      }
      stderr += '\n[loop] shell command timed out'
      done(-1)
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (c: Buffer) => { const s = c.toString(); if (stdout.length < SHELL_OUTPUT_CAP) stdout += s; onLine?.(s, 'stdout') })
    child.stderr?.on('data', (c: Buffer) => { const s = c.toString(); if (stderr.length < SHELL_OUTPUT_CAP) stderr += s; onLine?.(s, 'stderr') })
    child.on('error', () => done(-1))
    child.on('close', (code) => done(code))
  })
}

export function createLoopExecutors(opts: { env?: NodeJS.ProcessEnv } = {}): LoopExecutors {
  const env = opts.env ?? process.env
  return {
    async runAiStep({ prompt, sessionId, provider, model, effort, cwd, repoDir, onLine, onRawLine, onSpawn, aiStepTimeoutMs }) {
      const adapter = getAdapter(provider)
      // First iteration spawns headless (rail-job); subsequent iterations resume
      // the session so the agent keeps prior context across iterations.
      const action = sessionId ? 'chat-resume' : 'rail-job'
      // Relocated project: spawn cwd is the workspace (where `.claude/commands`
      // live, so native `/specrails:*` slash commands resolve). Surface the repo
      // for the pipeline's I/O exactly like QueueManager: SPECRAILS_REPO_DIR +
      // claude `--add-dir <repoDir>`. Best-effort agent self-heal on Windows.
      const stepEnv = repoDir ? { ...env, SPECRAILS_REPO_DIR: repoDir } : env
      // Relocated cwd is the workspace; the source repo is reached via the
      // `./project` symlink + SPECRAILS_REPO_DIR. Each provider must be told the
      // repo is an allowed working dir or it can READ but not WRITE source files:
      //  • claude: `--add-dir <repoDir>` extends its tool/edit roots.
      //  • codex: iteration 1 is rail-job (`danger-full-access`, writes anywhere),
      //    but every RESUME runs under `workspace-write`, whose only writable root
      //    is the spawn cwd (the workspace) — so repo edits fail with `Operation
      //    not permitted` and the loop spins forever on verify→fix. Add the repo
      //    (and cwd, defensively) to codex's sandbox writable_roots. Harmless
      //    no-op under danger-full-access on iteration 1.
      const extraArgs = !repoDir
        ? undefined
        : adapter.id === 'claude'
          ? ['--add-dir', repoDir]
          : adapter.id === 'codex'
            ? ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(repoDir)}, ${JSON.stringify(cwd)}]`]
            : undefined
      if (repoDir) { try { ensureFrameworkAgents(cwd, adapter.projectDirName) } catch { /* best-effort */ } }
      let text = ''
      // The adapter parses provider failures (codex `turn.failed`, etc.) into a
      // structured `error` event on the stdout stream — capture its message so we
      // surface the REAL reason (e.g. "You've hit your usage limit") instead of
      // the `stderrTail`, which often holds only an informational line.
      let errorText: string | undefined
      const res = await runAiCliInvocation({
        adapter,
        action,
        buildOpts: { prompt, model, sessionId: sessionId ?? undefined, reasoning_effort: effort, extraArgs },
        cwd,
        env: stepEnv,
        timeoutMs: aiStepTimeoutMs ?? AI_STEP_TIMEOUT_MS,
        onSpawn,
        // Two complementary streams, mirroring QueueManager's contract:
        //  • RAW JSONL via onStdoutLine → engine emits parsed `event`s that drive
        //    JobStatusPanel activity (LogViewer SKIPS these to avoid dupes).
        //  • display text/tools via onEvent → engine emits `log` lines that
        //    LogViewer actually RENDERS (the visible transcript).
        onStdoutLine: onRawLine,
        onEvent: (ev) => {
          if (ev.kind === 'text-delta') { text += ev.text; onLine?.(ev.text) }
          else if (ev.kind === 'tool-use') onLine?.(`🔧 ${ev.name} ${ev.inputPreview ?? ''}`.trim())
          else if (ev.kind === 'error' && ev.message) errorText = ev.message
        },
      })
      const failed = res.spawnFailed || res.timedOut || (res.code != null && res.code !== 0)
      if (res.spawnFailed) {
        errorText = errorText ?? `failed to spawn "${adapter.binary}" (on PATH?)`
        const msg = `AI step: ${errorText}`
        console.error(`[loop] ${msg}`)
        onLine?.(msg, 'stderr')
      } else if (res.timedOut) {
        // A wedged/unresponsive provider settles with code=null + timedOut. Count
        // it as a failure so the engine's fail-fast can bail instead of paying the
        // full timeout every pass.
        errorText = errorText ?? `${adapter.binary} timed out`
        const msg = `AI step: ${errorText}`
        console.error(`[loop] ${msg}`)
        onLine?.(msg, 'stderr')
      } else if (res.code != null && res.code !== 0) {
        // Prefer the adapter's structured error (e.g. codex `turn.failed`:
        // "You've hit your usage limit") over `stderrTail`, which for codex holds
        // only the informational "Reading additional input from stdin…" line.
        const reason = errorText ?? (res.stderrTail ? res.stderrTail.slice(0, 300) : '')
        const msg = `AI step: ${adapter.binary} exited code=${res.code}${reason ? ` — ${reason}` : ''}`
        console.error(`[loop] ${msg}`)
        onLine?.(msg, 'stderr')
      }
      const { result, estimated } = finaliseInvocationResult(adapter, res.events, { fallbackModel: model })
      return {
        text,
        sessionId: res.sessionId ?? undefined,
        cost: result.total_cost_usd,
        tokens: (result.tokens_in ?? 0) + (result.tokens_out ?? 0),
        durationMs: result.duration_ms,
        provider: adapter.id,
        model: result.model ?? model,
        estimated,
        failed,
        errorText,
      }
    },

    async runShell({ command, cwd, onLine, onSpawn }) {
      return runShellCommand(command, cwd, env, SHELL_TIMEOUT_MS, onLine, onSpawn)
    },

    async runDecider({ systemPrompt, userPrompt, provider, model, effort, cwd, repoDir, onRawLine, onSpawn }) {
      const adapter = getAdapter(provider)
      let text = ''
      const decEnv = repoDir ? { ...env, SPECRAILS_REPO_DIR: repoDir } : env
      // spec-gen is a one-shot, system-prompted invocation (workspace-write on
      // codex, not full-access) — appropriate for a read-only judgment.
      const res = await runAiCliInvocation({
        adapter,
        action: 'spec-gen',
        buildOpts: { prompt: userPrompt, systemPrompt, model, maxTurns: 1, reasoning_effort: effort },
        cwd,
        env: decEnv,
        timeoutMs: DECIDER_TIMEOUT_MS,
        onSpawn,
        onStdoutLine: onRawLine,
        onEvent: (ev) => { if (ev.kind === 'text-delta') text += ev.text },
      })
      const decision = parseDeciderDecision(text)
      const { result, estimated } = finaliseInvocationResult(adapter, res.events, { fallbackModel: model })
      return {
        ...decision,
        cost: result.total_cost_usd,
        tokens: (result.tokens_in ?? 0) + (result.tokens_out ?? 0),
        durationMs: result.duration_ms,
        provider: adapter.id,
        model: result.model ?? model,
        estimated,
      }
    },
  }
}
