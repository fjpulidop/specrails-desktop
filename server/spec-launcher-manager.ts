import { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import { resolveCommand } from './command-resolver'
import { spawnClaude } from './util/cli-prompt'

// ─── SpecLauncherManager ──────────────────────────────────────────────────────

export class SpecLauncherManager {
  private _broadcast: (msg: WsMessage) => void
  private _cwd: string
  private _activeProcesses: Map<string, ChildProcess>
  private _buffers: Map<string, string>
  /**
   * Launches whose child was intentionally killed via cancel(). The close
   * handler short-circuits for these so a cancelled launch never emits a
   * follow-up spec_launcher_done/error (BUG-LONGTAIL-04).
   */
  private _cancelledIds = new Set<string>()
  /**
   * Set in shutdown() so any in-flight close handler skips broadcasting on a
   * removed/torn-down project (BUG-LONGTAIL-04).
   */
  private _disposed = false
  /** Pending SIGKILL escalation timers, keyed by launch id (BUG-LONGTAIL-02). */
  private _killTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(broadcast: (msg: WsMessage) => void, cwd: string) {
    this._broadcast = broadcast
    this._cwd = cwd
    this._activeProcesses = new Map()
    this._buffers = new Map()
  }

  isActive(launchId: string): boolean {
    return this._activeProcesses.has(launchId)
  }

  /**
   * SIGTERM the child's process tree, then arm an unref'd 2s SIGKILL escalation
   * (cleared on the child's 'close'). A child that swallows SIGTERM would
   * otherwise become an unkillable orphan running with
   * --dangerously-skip-permissions (BUG-LONGTAIL-02).
   */
  private _killWithEscalation(launchId: string, pid: number): void {
    try { treeKill(pid, 'SIGTERM') } catch { /* best-effort */ }
    const existing = this._killTimers.get(launchId)
    if (existing) clearTimeout(existing)
    const grace = setTimeout(() => {
      this._killTimers.delete(launchId)
      try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
    }, 2000)
    grace.unref?.()
    this._killTimers.set(launchId, grace)
  }

  private _clearKillTimer(launchId: string): void {
    const timer = this._killTimers.get(launchId)
    if (timer) {
      clearTimeout(timer)
      this._killTimers.delete(launchId)
    }
  }

  /**
   * Tear down before the project is removed (M12). This manager holds no DB
   * handle (its close handler only broadcasts), so it cannot crash the app — but
   * an orphaned `/opsx:ff` child runs with --dangerously-skip-permissions against
   * a removed project and keeps burning spend, so SIGTERM it. Idempotent.
   */
  shutdown(): void {
    this._disposed = true
    for (const [launchId, child] of this._activeProcesses) {
      if (child.pid) this._killWithEscalation(launchId, child.pid)
    }
    this._activeProcesses.clear()
    this._buffers.clear()
  }

  async launch(launchId: string, description: string): Promise<void> {
    const rawCommand = `/opsx:ff ${description}`
    const prompt = resolveCommand(rawCommand, this._cwd)
    if (prompt === rawCommand) {
      this._broadcastError(launchId, 'This project does not have the /opsx:ff command installed. Run "npx specrails-core@latest" to install it.')
      return
    }

    const args = [
      '--dangerously-skip-permissions',
      '--tools', 'default',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', prompt,
    ]

    // spawnClaude reroutes multi-line argv values through stdin on Windows.
    const child = spawnClaude(args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: this._cwd,
    })

    this._activeProcesses.set(launchId, child)
    this._buffers.set(launchId, '')

    // Surface ENOENT (e.g. claude not on PATH) instead of crashing the app.
    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[SpecLauncherManager] spawn failed for ${launchId}: ${err.message}`)
      this._activeProcesses.delete(launchId)
      this._buffers.delete(launchId)
      this._broadcast({
        type: 'spec_launcher_error',
        projectId: '',
        launchId,
        error: `Failed to launch claude: ${err.message}`,
        timestamp: new Date().toISOString(),
      })
    })
    /* c8 ignore stop */

    // Capture last change ID from output (opsx:ff usually prints the change name)
    let detectedChangeId: string | null = null

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* skip non-JSON */ }
      if (!parsed) return

      const eventType = parsed.type as string

      if (eventType === 'assistant') {
        const msg = parsed.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined
        const blocks = msg?.content ?? []

        const texts = blocks
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
        const newText = texts.join('')
        if (newText) {
          // Try to detect change ID from output (look for "openspec/changes/<id>" pattern)
          const changeMatch = newText.match(/openspec\/changes\/([^\s/]+)/)
          if (changeMatch) detectedChangeId = changeMatch[1]

          const prev = this._buffers.get(launchId) ?? ''
          this._buffers.set(launchId, prev + newText)
          this._broadcast({
            type: 'spec_launcher_stream',
            projectId: '',
            launchId,
            delta: newText,
            timestamp: new Date().toISOString(),
          })
        }

        for (const block of blocks) {
          if (block.type === 'tool_use' && block.name) {
            this._broadcast({
              type: 'spec_launcher_stream',
              projectId: '',
              launchId,
              delta: `<!--tool:${block.name}-->`,
              timestamp: new Date().toISOString(),
            })
          }
        }
      }
    })

    return new Promise<void>((resolve) => {
      child.on('close', (code) => {
        const fullText = this._buffers.get(launchId) ?? ''
        this._clearKillTimer(launchId)
        this._activeProcesses.delete(launchId)
        this._buffers.delete(launchId)
        // A cancel() killed this child intentionally, or shutdown() removed the
        // project — either way do NOT emit a follow-up done/error broadcast for
        // a cancelled/torn-down launch (BUG-LONGTAIL-04).
        if (this._cancelledIds.delete(launchId) || this._disposed) { resolve(); return }

        if (code === 0) {
          // Also try to extract change ID from full text
          if (!detectedChangeId) {
            const match = fullText.match(/openspec\/changes\/([^\s/]+)/)
            if (match) detectedChangeId = match[1]
          }
          this._broadcast({
            type: 'spec_launcher_done',
            projectId: '',
            launchId,
            changeId: detectedChangeId,
            timestamp: new Date().toISOString(),
          })
        } else {
          this._broadcastError(launchId, 'Spec generation failed')
        }

        resolve()
      })
    })
  }

  cancel(launchId: string): void {
    // Mark intentionally-cancelled BEFORE killing so the child's later 'close'
    // short-circuits instead of broadcasting a contradictory done/error for a
    // cancelled launch (BUG-LONGTAIL-04).
    this._cancelledIds.add(launchId)
    const child = this._activeProcesses.get(launchId)
    if (child?.pid) {
      this._killWithEscalation(launchId, child.pid)
    } else {
      // No live child to close-out, so the flag would otherwise leak.
      this._cancelledIds.delete(launchId)
    }
    this._activeProcesses.delete(launchId)
    this._buffers.delete(launchId)
    this._broadcastError(launchId, 'cancelled')
  }

  private _broadcastError(launchId: string, error: string): void {
    this._broadcast({
      type: 'spec_launcher_error',
      projectId: '',
      launchId,
      error,
      timestamp: new Date().toISOString(),
    })
  }
}
