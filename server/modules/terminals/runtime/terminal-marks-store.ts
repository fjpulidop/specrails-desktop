import type { DbInstance } from '../../../db'

export interface CommandMark {
  id: number
  sessionId: string
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  command: string | null
  cwd: string | null
}

export interface AppendMarkInput {
  sessionId: string
  startedAt: number
  finishedAt?: number | null
  exitCode?: number | null
  command?: string | null
  cwd?: string | null
}

export const MARKS_PER_SESSION_CAP = 1000

export function appendMark(db: DbInstance, input: AppendMarkInput): CommandMark {
  const insert = db.prepare(`
    INSERT INTO terminal_command_marks (session_id, started_at, finished_at, exit_code, command, cwd)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction((row: AppendMarkInput) => {
    const result = insert.run(
      row.sessionId,
      row.startedAt,
      row.finishedAt ?? null,
      row.exitCode ?? null,
      row.command ?? null,
      row.cwd ?? null,
    )
    pruneSessionFifo(db, row.sessionId, MARKS_PER_SESSION_CAP)
    return result.lastInsertRowid as number
  })
  const id = tx(input)
  return {
    id,
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    exitCode: input.exitCode ?? null,
    command: input.command ?? null,
    cwd: input.cwd ?? null,
  }
}

export interface ListMarksOptions {
  limit?: number
  before?: number // started_at upper bound (exclusive) for pagination
}

function rowToMark(r: {
  id: number
  session_id: string
  started_at: number
  finished_at: number | null
  exit_code: number | null
  command: string | null
  cwd: string | null
}): CommandMark {
  return {
    id: r.id,
    sessionId: r.session_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    exitCode: r.exit_code,
    command: r.command,
    cwd: r.cwd,
  }
}

export function listMarks(db: DbInstance, sessionId: string, opts: ListMarksOptions = {}): CommandMark[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  if (typeof opts.before === 'number') {
    const rows = db.prepare(`
      SELECT * FROM terminal_command_marks
      WHERE session_id = ? AND started_at < ?
      ORDER BY started_at DESC, id DESC LIMIT ?
    `).all(sessionId, opts.before, limit) as Array<Parameters<typeof rowToMark>[0]>
    return rows.map(rowToMark)
  }
  const rows = db.prepare(`
    SELECT * FROM terminal_command_marks
    WHERE session_id = ?
    ORDER BY started_at DESC, id DESC LIMIT ?
  `).all(sessionId, limit) as Array<Parameters<typeof rowToMark>[0]>
  return rows.map(rowToMark)
}

export function deleteForSession(db: DbInstance, sessionId: string): void {
  db.prepare('DELETE FROM terminal_command_marks WHERE session_id = ?').run(sessionId)
}

export function pruneSessionFifo(db: DbInstance, sessionId: string, cap: number = MARKS_PER_SESSION_CAP): void {
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM terminal_command_marks WHERE session_id = ?').get(sessionId) as { c: number }
  if (countRow.c <= cap) return
  const excess = countRow.c - cap
  // Delete oldest excess rows for this session.
  db.prepare(`
    DELETE FROM terminal_command_marks
    WHERE id IN (
      SELECT id FROM terminal_command_marks
      WHERE session_id = ?
      ORDER BY started_at ASC, id ASC
      LIMIT ?
    )
  `).run(sessionId, excess)
}

/**
 * Mark all open (finished_at IS NULL) marks for a session as killed —
 * called when the session exits without a clean post-exec.
 */
export function markOpenAsKilled(db: DbInstance, sessionId: string, killedAt: number): number {
  const result = db.prepare(`
    UPDATE terminal_command_marks
    SET finished_at = ?, exit_code = NULL
    WHERE session_id = ? AND finished_at IS NULL
  `).run(killedAt, sessionId)
  return result.changes
}

export function getOpenMark(db: DbInstance, sessionId: string): CommandMark | null {
  const row = db.prepare(`
    SELECT * FROM terminal_command_marks
    WHERE session_id = ? AND finished_at IS NULL
    ORDER BY started_at DESC, id DESC LIMIT 1
  `).get(sessionId) as Parameters<typeof rowToMark>[0] | undefined
  return row ? rowToMark(row) : null
}

export function closeOpenMark(
  db: DbInstance,
  sessionId: string,
  finishedAt: number,
  exitCode: number | null,
  command?: string | null,
  cwd?: string | null,
): CommandMark | null {
  const open = getOpenMark(db, sessionId)
  if (!open) return null
  db.prepare(`
    UPDATE terminal_command_marks
    SET finished_at = ?, exit_code = ?,
        command = COALESCE(?, command),
        cwd     = COALESCE(?, cwd)
    WHERE id = ?
  `).run(finishedAt, exitCode, command ?? null, cwd ?? null, open.id)
  return getMark(db, open.id)
}

export function getMark(db: DbInstance, id: number): CommandMark | null {
  const row = db.prepare('SELECT * FROM terminal_command_marks WHERE id = ?').get(id) as Parameters<typeof rowToMark>[0] | undefined
  return row ? rowToMark(row) : null
}
