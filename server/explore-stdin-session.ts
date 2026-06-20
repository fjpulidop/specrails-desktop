// Persistent-stdin Explore transport (big bet #3).
//
// The default Explore turn spawns a fresh `claude` child per message (turns 2+
// pay `--resume` session-rehydration latency). This module keeps ONE child
// alive per conversation using claude's `--input-format stream-json` multi-turn
// transport: each user turn is written as a newline-delimited JSON message to
// the child's stdin, and the same long-lived child streams the response. The
// child stays resident between turns, so turns 2+ skip spawn + rehydration.
//
// Transport only — it owns spawning, the persistent stdout/stderr fan-out, and
// stdin framing. ChatManager drives per-turn rendering, persistence, and
// lifecycle through the handler hooks. Default OFF behind a flag; claude-only
// (gated by capabilities.persistentStdin); full fallback to the legacy
// spawn-per-turn path means zero behaviour change when disabled.

import type { ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { spawnAiCli } from './util/cli-prompt'

/**
 * Persistent-stdin Explore is opt-in. Default OFF — set
 * `SPECRAILS_EXPLORE_PERSISTENT_STDIN=1` to enable. Any other value (or unset)
 * keeps the legacy spawn-per-turn path, so this is also the escape hatch.
 */
export function isExplorePersistentStdinEnabled(): boolean {
  return process.env.SPECRAILS_EXPLORE_PERSISTENT_STDIN === '1'
}

/**
 * Frame one user turn as a stream-json input line for claude's
 * `--input-format stream-json` transport. Newline-terminated so the child reads
 * exactly one message per turn. Content is sent as a plain string (claude
 * accepts string content for user messages).
 */
export function frameStreamJsonUserMessage(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

/** Per-turn handlers ChatManager installs before writing each user message. */
export interface TurnHandlers {
  /** Each raw stdout line from the persistent child (adapter parse is caller's). */
  onLine: (line: string) => void
  /** Each raw stderr line/chunk. */
  onStderr: (chunk: string) => void
  /** The persistent child exited (crash, idle-kill, or shutdown). */
  onClose: (code: number | null) => void
}

interface Session {
  child: ChildProcess
  reader: Interface
  handlers: TurnHandlers | null
}

export interface SpawnSpec {
  binary: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Injectable spawn (tests). Defaults to spawnAiCli. */
  spawn?: typeof spawnAiCli
}

/**
 * Owns the long-lived claude children for persistent-stdin Explore. Keyed by
 * conversation id. One child per conversation; a single stdout reader fans each
 * line out to the conversation's currently-installed turn handler.
 */
export class ExploreStdinSessions {
  private _sessions = new Map<string, Session>()

  has(id: string): boolean {
    return this._sessions.has(id)
  }

  size(): number {
    return this._sessions.size
  }

  /**
   * Return the live child for a conversation, spawning one in persistent mode
   * if none exists. `isNew` is true only when a child was just spawned (the
   * caller writes the first turn either way).
   */
  getOrSpawn(id: string, spec: SpawnSpec): { child: ChildProcess; isNew: boolean } {
    const existing = this._sessions.get(id)
    if (existing && existing.child.pid && !existing.child.killed) {
      return { child: existing.child, isNew: false }
    }
    const spawn = spec.spawn ?? spawnAiCli
    const child = spawn(spec.binary, spec.args, {
      env: spec.env ?? process.env,
      // stdin MUST be piped — it is the per-turn transport.
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: spec.cwd,
    } as Parameters<typeof spawnAiCli>[2])

    const session: Session = { child, reader: null as unknown as Interface, handlers: null }

    if (child.stdout) {
      session.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      session.reader.on('line', (line) => session.handlers?.onLine(line))
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => session.handlers?.onStderr(chunk.toString()))
    }
    const onExit = (code: number | null) => {
      // Evict first so a handler that re-spawns inside onClose sees a clean slot.
      if (this._sessions.get(id) === session) this._sessions.delete(id)
      session.handlers?.onClose(code)
    }
    child.on('close', onExit)
    child.on('error', () => onExit(null))

    this._sessions.set(id, session)
    return { child, isNew: true }
  }

  /** Install the handlers for the current turn (replaces any prior turn's). */
  setHandlers(id: string, handlers: TurnHandlers): void {
    const s = this._sessions.get(id)
    if (s) s.handlers = handlers
  }

  /** Detach the current turn's handlers (between turns stray lines are dropped). */
  clearHandlers(id: string): void {
    const s = this._sessions.get(id)
    if (s) s.handlers = null
  }

  /**
   * Write one framed user turn to the persistent child's stdin. Returns false
   * ONLY when the data cannot be enqueued at all (no session / no stdin /
   * destroyed). `stream.write()` returning false means BACKPRESSURE (the bytes
   * are buffered and flush on 'drain') — NOT failure — so we must not treat it
   * as a dead child and fail the turn. Any non-throwing write is a success.
   */
  writeTurn(id: string, text: string): boolean {
    const s = this._sessions.get(id)
    if (!s || !s.child.stdin || s.child.stdin.destroyed) return false
    try {
      s.child.stdin.write(frameStreamJsonUserMessage(text)) // ignore backpressure boolean
      return true
    } catch {
      return false
    }
  }

  /** Kill and forget one conversation's persistent child (idempotent). */
  kill(id: string): void {
    const s = this._sessions.get(id)
    if (!s) return
    this._sessions.delete(id)
    try {
      s.reader?.close()
    } catch { /* best-effort */ }
    try {
      if (s.child.pid && !s.child.killed) s.child.kill('SIGTERM')
    } catch { /* already gone */ }
  }

  /** Kill every persistent child (shutdown / project removal). */
  killAll(): void {
    for (const id of Array.from(this._sessions.keys())) this.kill(id)
  }
}
