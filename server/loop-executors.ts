/**
 * Production executors for the LoopRunManager. Thin glue that wires the engine's
 * injected `runAiStep` / `runShell` / `runDecider` hooks to the real spawn
 * machinery (`runAiCliInvocation` + the provider adapter + a shell spawn). This
 * file is process-spawning glue — like `browser-playwright.ts`, it is excluded
 * from coverage; the engine's traversal/decision logic is unit-tested against
 * fake executors in `loop-run-manager.test.ts`.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import treeKill from 'tree-kill'
import { getAdapter } from './providers'
import { ensureFrameworkAgents, ensureFrameworkCommandSubtrees } from './workspace-manager'
import { ensureClaudeTrusted } from './claude-trust'
import { runAiCliInvocation } from './spawn-lifecycle'
import { finaliseInvocationResult } from './result-event'
import { parseDeciderDecision } from './loop-decider'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { injectRepoMapEnv } from './repo-map'
import { isInteractiveJobsEnabled } from './feature-flags'
import type { ProviderAdapter } from './providers/types'
import {
  buildProviderEnv,
  buildProviderRepoAccessArgs,
  formatProviderCommand,
} from './providers/runtime'
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

/**
 * Env for a loop AI spawn (one-shot AND interactive — must stay byte-identical
 * between the two, the interactive session is a transport swap, not a policy
 * change). Relocated projects surface the repo via SPECRAILS_REPO_DIR — for an
 * ISOLATED rail the caller passes the WORKTREE as `repoDir`, so writes/git land
 * in the worktree, never the live repo (the workspace artifact indirection —
 * tickets/backlog/profiles/state — rides the executor's base env, see
 * `resolveLoopBaseEnv`). When the safe-PR flow is active
 * (SPECRAILS_RAIL_DELIVER_PR on), desktop owns version control — tell
 * specrails-core's implement to be git-agnostic (skip its Ship phase) via
 * SPECRAILS_GIT_AUTO=false so it never opens an uncoordinated PR alongside the
 * app's own draft-PR delivery. Default ON (flag=0/false/off disables). See
 * rail-isolation + the specrails-core SPECRAILS_GIT_AUTO contract.
 */
function aiStepEnv(env: NodeJS.ProcessEnv, repoDir: string | undefined): NodeJS.ProcessEnv {
  const base = repoDir ? { ...env, SPECRAILS_REPO_DIR: repoDir } : env
  // Deterministic repo map (zero-AI) so the pipeline's exploration phase
  // starts oriented instead of spending its first turns on `ls`/`find`.
  const withMap = injectRepoMapEnv(base, repoDir)
  return isRailPrDeliveryEnabled() ? { ...withMap, SPECRAILS_GIT_AUTO: 'false' } : withMap
}

/**
 * Relocated cwd is the workspace; the source repo is reached via the
 * `./project` symlink + SPECRAILS_REPO_DIR. Each provider must be told the
 * repo is an allowed working dir or it can READ but not WRITE source files:
 *  • claude: `--add-dir <repoDir>` extends its tool/edit roots.
 *  • codex: iteration 1 is rail-job (`danger-full-access`, writes anywhere),
 *    but every RESUME runs under `workspace-write`, whose only writable root
 *    is the spawn cwd (the workspace) — so repo edits fail with `Operation
 *    not permitted` and the loop spins forever on verify→fix. Add the repo
 *    (and cwd, defensively) to codex's sandbox writable_roots. Harmless
 *    no-op under danger-full-access on iteration 1.
 */
function aiStepExtraArgs(adapter: ProviderAdapter, cwd: string, repoDir: string | undefined): string[] | undefined {
  if (!repoDir) return undefined
  const args = buildProviderRepoAccessArgs(adapter, [repoDir, ...(adapter.id === 'codex' ? [cwd] : [])])
  return args.length > 0 ? args : undefined
}

export function createLoopExecutors(
  opts: {
    /** Base spawn env, or a LAZY provider re-resolved per step. Project-bound
     *  executors pass `() => resolveLoopBaseEnv(project)` so relocated projects
     *  inject core's workspace artifact indirection (and a project relocated
     *  AFTER server start is picked up without a restart). Default process.env. */
    env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv)
    /** Global Specrails Agents defaults seam: per-step SPECRAILS_PROFILE_PATH
     *  for ai-steps (per-agent model overrides). Re-resolved per step so a
     *  Settings change applies to the next step without restart; null ⇒ no
     *  injection (byte-identical legacy — core's own file fallback rules). */
    profilePathFor?: (provider: string) => string | null
  } = {},
): LoopExecutors {
  const resolveEnv = (): NodeJS.ProcessEnv =>
    typeof opts.env === 'function' ? opts.env() : opts.env ?? process.env
  // Deciders deliberately excluded: they run no pipeline agents.
  const withProfileEnv = (env: NodeJS.ProcessEnv, provider: string): NodeJS.ProcessEnv => {
    try {
      const profilePath = opts.profilePathFor?.(provider) ?? null
      return profilePath ? { ...env, SPECRAILS_PROFILE_PATH: profilePath } : env
    } catch {
      return env
    }
  }
  return {
    // Cheap working-tree fingerprint for the engine's non-convergence guard:
    // HEAD sha + the porcelain dirty set, hashed. Two identical fingerprints
    // across consecutive Decider 'continue' verdicts ⇒ the loop changed nothing
    // ⇒ abort `stalled`. Synchronous + best-effort: any git failure (no repo,
    // detached, etc.) returns null so the guard simply stays off. Never throws.
    repoStateHash(dir: string): string | null {
      try {
        const opt = { cwd: dir, encoding: 'utf-8' as const, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[] }
        const head = execFileSync('git', ['rev-parse', 'HEAD'], opt).trim()
        // `-z` NUL-delimited + include untracked so a brand-new file counts as
        // a change; stable ordering makes the hash deterministic per tree state.
        const porcelain = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], opt)
        return createHash('sha256').update(head).update('\0').update(porcelain).digest('hex')
      } catch {
        return null
      }
    },
    async runAiStep({ prompt, sessionId, provider, model, effort, cwd, repoDir, onLine, onRawLine, onSpawn, aiStepTimeoutMs }) {
      const adapter = getAdapter(provider)
      // First iteration spawns headless (rail-job); subsequent iterations resume
      // the session so the agent keeps prior context across iterations.
      const action = sessionId ? 'chat-resume' : 'rail-job'
      // Relocated project: spawn cwd is the workspace (where `.claude/commands`
      // live, so native `/specrails:*` slash commands resolve). Surface the repo
      // for the pipeline's I/O exactly like QueueManager: SPECRAILS_REPO_DIR +
      // claude `--add-dir <repoDir>` (see the shared helpers above). Best-effort
      // agent self-heal on Windows.
      const stepEnv = withProfileEnv(aiStepEnv(resolveEnv(), repoDir), provider)
      const extraArgs = aiStepExtraArgs(adapter, cwd, repoDir)
      const effectivePrompt = formatProviderCommand(
        adapter,
        prompt,
        cwd,
        sessionId ?? undefined,
      )
      const buildOpts = {
        prompt: effectivePrompt,
        model,
        sessionId: sessionId ?? undefined,
        reasoning_effort: effort,
        extraArgs,
      }
      if (repoDir) { try { ensureFrameworkAgents(cwd, adapter.projectDirName); ensureFrameworkCommandSubtrees(cwd, adapter.projectDirName) } catch { /* best-effort */ } }
      // Pre-trust the spawn dir so headless claude honours the overlaid
      // `.claude/settings.json` permissions.allow (else "workspace not trusted").
      try { ensureClaudeTrusted(adapter.id, [cwd, repoDir]) } catch { /* best-effort */ }
      let text = ''
      // The adapter parses provider failures (codex `turn.failed`, etc.) into a
      // structured `error` event on the stdout stream — capture its message so we
      // surface the REAL reason (e.g. "You've hit your usage limit") instead of
      // the `stderrTail`, which often holds only an informational line.
      let errorText: string | undefined
      const wallStartedAt = Date.now()
      const res = await runAiCliInvocation({
        adapter,
        action,
        buildOpts,
        cwd,
        env: buildProviderEnv(adapter, buildOpts, stepEnv),
        // 0 ⇒ watchdog disabled (factory loops run untimed; the loop's
        // maxIterations / cost cap remain the runaway guards).
        timeoutMs: (aiStepTimeoutMs ?? AI_STEP_TIMEOUT_MS) > 0 ? (aiStepTimeoutMs ?? AI_STEP_TIMEOUT_MS) : undefined,
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
      const failed =
        res.spawnFailed ||
        res.timedOut ||
        (res.code != null && res.code !== 0) ||
        errorText !== undefined
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
      } else if (errorText) {
        // A normalized provider error is terminal even if an upstream CLI
        // anomalously reports a clean process exit.
        const msg = `AI step: ${adapter.binary} reported an error — ${errorText}`
        console.error(`[loop] ${msg}`)
        onLine?.(msg, 'stderr')
      }
      const { result, estimated } = finaliseInvocationResult(adapter, res.events, {
        fallbackModel: model,
        durationMs: Math.max(0, Date.now() - wallStartedAt),
      })
      const tokensIn = result.tokens_in
      const tokensOut = result.tokens_out
      const tokensCacheRead = result.tokens_cache_read
      const tokensCacheCreate = result.tokens_cache_create
      const tokens = tokensIn === undefined && tokensOut === undefined
        ? undefined
        : (tokensIn ?? 0) + (tokensOut ?? 0)
      return {
        text,
        sessionId: res.sessionId ?? undefined,
        cost: result.total_cost_usd,
        // Derived scalar = input+output ONLY (legacy semantics). It feeds the
        // in-memory running total + cost-uncertainty heuristic AND the job-level
        // tokens_out counter (loop_runs / job.finalized), so it must NOT include
        // cache tokens or the claude loop-job token display would inflate. The
        // full cache breakdown is persisted to the ai_invocations row via the
        // structured tokensCacheRead/tokensCacheCreate fields below.
        tokens,
        tokensIn,
        tokensOut,
        tokensCacheRead,
        tokensCacheCreate,
        durationMs: result.duration_ms,
        durationApiMs: result.duration_api_ms,
        numTurns: result.num_turns,
        provider: adapter.id,
        model: result.model ?? model,
        estimated,
        failed,
        errorText,
      }
    },

    /**
     * Interactive upgrade for an ai-step (all-jobs-interactive default): when
     * the kill-switch is on (SPECRAILS_INTERACTIVE_JOBS !== 'false') AND the
     * provider supports persistent stdin (claude), return a resident-session
     * spawn plan — same binary, same cwd, same env, same repo extraArgs as the
     * one-shot spawn above, but with the `chat-stream` argv (prompt rides stdin
     * as the first stream-json frame; slash commands expand there too,
     * spike-verified on claude 2.1.198). Null ⇒ the engine one-shots the step
     * (non-claude providers, or the kill-switch) — byte-identical legacy.
     */
    planInteractiveAiStep({ provider, model, effort, cwd, repoDir, sessionId, aiStepTimeoutMs }) {
      if (!isInteractiveJobsEnabled()) return null
      const adapter = getAdapter(provider)
      if (!adapter.capabilities.persistentStdin) return null
      const stepEnv = withProfileEnv(aiStepEnv(resolveEnv(), repoDir), provider)
      const extraArgs = aiStepExtraArgs(adapter, cwd, repoDir)
      if (repoDir) { try { ensureFrameworkAgents(cwd, adapter.projectDirName); ensureFrameworkCommandSubtrees(cwd, adapter.projectDirName) } catch { /* best-effort */ } }
      // Pre-trust the spawn dir so headless claude honours the overlaid
      // `.claude/settings.json` permissions.allow (else "workspace not trusted").
      try { ensureClaudeTrusted(adapter.id, [cwd, repoDir]) } catch { /* best-effort */ }
      const buildOpts = {
        // chat-stream feeds the prompt over stdin per-turn, so the argv `prompt`
        // is unused — pass empty to satisfy the shared SpawnOptions shape.
        prompt: '',
        model,
        // Mid-pass continuity: resume the previous step's session, exactly like
        // the one-shot path's chat-resume. Absent on a fresh pass (the engine
        // drops the session id at an iterate-loop's loop-back).
        sessionId: sessionId ?? undefined,
        reasoning_effort: effort,
        extraArgs,
      }
      const args = adapter.buildArgs('chat-stream', buildOpts)
      return {
        adapter,
        spec: { binary: adapter.binary, args, cwd, env: buildProviderEnv(adapter, buildOpts, stepEnv) },
        // The loop's ai-step timeout bounds the WHOLE step, interactive
        // included. 0 ⇒ unbounded (the engine skips arming the step timer).
        stepTimeoutMs: aiStepTimeoutMs ?? AI_STEP_TIMEOUT_MS,
      }
    },

    async runShell({ command, cwd, onLine, onSpawn }) {
      return runShellCommand(command, cwd, resolveEnv(), SHELL_TIMEOUT_MS, onLine, onSpawn)
    },

    async runDecider({ systemPrompt, userPrompt, provider, model, effort, cwd, repoDir, onRawLine, onSpawn }) {
      const adapter = getAdapter(provider)
      let text = ''
      const baseEnv = resolveEnv()
      const decEnv = repoDir ? { ...baseEnv, SPECRAILS_REPO_DIR: repoDir } : baseEnv
      // spec-gen is a one-shot, system-prompted invocation (workspace-write on
      // codex, not full-access) — appropriate for a read-only judgment.
      const buildOpts = { prompt: userPrompt, systemPrompt, model, maxTurns: 1, reasoning_effort: effort, toolPolicy: 'read-only' as const }
      const wallStartedAt = Date.now()
      const res = await runAiCliInvocation({
        adapter,
        action: 'spec-gen',
        buildOpts,
        cwd,
        env: buildProviderEnv(adapter, buildOpts, decEnv),
        timeoutMs: DECIDER_TIMEOUT_MS,
        onSpawn,
        onStdoutLine: onRawLine,
        onEvent: (ev) => { if (ev.kind === 'text-delta') text += ev.text },
      })
      const decision = parseDeciderDecision(text)
      const { result, estimated } = finaliseInvocationResult(adapter, res.events, {
        fallbackModel: model,
        durationMs: Math.max(0, Date.now() - wallStartedAt),
      })
      const tokensIn = result.tokens_in
      const tokensOut = result.tokens_out
      const tokensCacheRead = result.tokens_cache_read
      const tokensCacheCreate = result.tokens_cache_create
      const tokens = tokensIn === undefined && tokensOut === undefined
        ? undefined
        : (tokensIn ?? 0) + (tokensOut ?? 0)
      return {
        ...decision,
        cost: result.total_cost_usd,
        // Derived scalar = input+output ONLY (legacy semantics). It feeds the
        // in-memory running total + cost-uncertainty heuristic AND the job-level
        // tokens_out counter (loop_runs / job.finalized), so it must NOT include
        // cache tokens or the claude loop-job token display would inflate. The
        // full cache breakdown is persisted to the ai_invocations row via the
        // structured tokensCacheRead/tokensCacheCreate fields below.
        tokens,
        tokensIn,
        tokensOut,
        tokensCacheRead,
        tokensCacheCreate,
        durationMs: result.duration_ms,
        durationApiMs: result.duration_api_ms,
        numTurns: result.num_turns,
        sessionId: res.sessionId ?? undefined,
        provider: adapter.id,
        model: result.model ?? model,
        estimated,
      }
    },
  }
}
