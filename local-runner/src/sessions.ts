import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { ChatMessage, SessionFile } from './types'

/**
 * Session persistence (design D7): one JSON file per session under
 * `$SPECRAILS_LOCAL_RUNNER_HOME/sessions` (default `~/.specrails/local-runner`),
 * mode 0600, LRU-capped at 200 files by mtime. The history excludes the system
 * message — it is rebuilt from argv on every spawn so a changed system prompt
 * (or a slash-command tail) applies to a resumed session.
 */
export const SESSION_LRU_CAP = 200

export function sessionsDir(env: Record<string, string | undefined>): string {
  const home = env.SPECRAILS_LOCAL_RUNNER_HOME ?? path.join(os.homedir(), '.specrails', 'local-runner')
  return path.join(home, 'sessions')
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  create(model: string, cwd: string): SessionFile {
    const now = new Date().toISOString()
    return { id: randomUUID(), model, cwd, createdAt: now, updatedAt: now, messages: [] }
  }

  /** Returns null when the id is unknown (the caller emits the missing-session diagnostic). */
  load(id: string): SessionFile | null {
    if (!isSafeId(id)) return null
    const file = path.join(this.dir, `${id}.json`)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionFile>
      if (!Array.isArray(parsed.messages)) return null
      return {
        id,
        model: typeof parsed.model === 'string' ? parsed.model : '',
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        messages: parsed.messages as ChatMessage[],
      }
    } catch {
      return null
    }
  }

  save(session: SessionFile): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    session.updatedAt = new Date().toISOString()
    const file = path.join(this.dir, `${session.id}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 })
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* best-effort on platforms without POSIX modes */
    }
    this.prune()
  }

  private prune(): void {
    let entries: Array<{ file: string; mtime: number }>
    try {
      entries = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const full = path.join(this.dir, f)
          return { file: full, mtime: fs.statSync(full).mtimeMs }
        })
    } catch {
      return
    }
    if (entries.length <= SESSION_LRU_CAP) return
    entries.sort((a, b) => b.mtime - a.mtime)
    for (const stale of entries.slice(SESSION_LRU_CAP)) {
      try {
        fs.unlinkSync(stale.file)
      } catch {
        /* already gone */
      }
    }
  }
}
