import { describe, it, expect, beforeEach } from 'vitest'
import { initDb } from '../../../db'
import {
  appendMark,
  listMarks,
  deleteForSession,
  pruneSessionFifo,
  markOpenAsKilled,
  closeOpenMark,
  getOpenMark,
  MARKS_PER_SESSION_CAP,
} from './terminal-marks-store'
import type { DbInstance } from '../../../db'

describe('terminal-marks-store', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('appendMark inserts a row and returns it', () => {
    const m = appendMark(db, { sessionId: 's1', startedAt: 100, command: 'ls' })
    expect(m.id).toBeGreaterThan(0)
    expect(m.sessionId).toBe('s1')
    expect(m.startedAt).toBe(100)
    expect(m.finishedAt).toBeNull()
    expect(m.command).toBe('ls')
  })

  it('listMarks returns rows newest-first per session', () => {
    appendMark(db, { sessionId: 's1', startedAt: 100 })
    appendMark(db, { sessionId: 's1', startedAt: 200 })
    appendMark(db, { sessionId: 's2', startedAt: 150 })
    const list = listMarks(db, 's1')
    expect(list.map((m) => m.startedAt)).toEqual([200, 100])
    expect(list.every((m) => m.sessionId === 's1')).toBe(true)
  })

  it('listMarks honors before pagination cursor', () => {
    appendMark(db, { sessionId: 's1', startedAt: 100 })
    appendMark(db, { sessionId: 's1', startedAt: 200 })
    appendMark(db, { sessionId: 's1', startedAt: 300 })
    const page = listMarks(db, 's1', { before: 250 })
    expect(page.map((m) => m.startedAt)).toEqual([200, 100])
  })

  it('FIFO cap evicts oldest rows for that session only', () => {
    // Append cap+5 to s1 and 3 to s2.
    for (let i = 0; i < MARKS_PER_SESSION_CAP + 5; i++) {
      appendMark(db, { sessionId: 's1', startedAt: i })
    }
    for (let i = 0; i < 3; i++) {
      appendMark(db, { sessionId: 's2', startedAt: i })
    }
    const s1 = listMarks(db, 's1', { limit: 1000 })
    const s2 = listMarks(db, 's2', { limit: 1000 })
    expect(s1.length).toBe(MARKS_PER_SESSION_CAP)
    // The oldest 5 rows in s1 should be gone (started_at 0..4)
    const startedAts = s1.map((m) => m.startedAt).sort((a, b) => a - b)
    expect(startedAts[0]).toBe(5)
    expect(s2.length).toBe(3)
  })

  it('pruneSessionFifo no-op when below cap', () => {
    appendMark(db, { sessionId: 's1', startedAt: 1 })
    pruneSessionFifo(db, 's1', 100)
    expect(listMarks(db, 's1').length).toBe(1)
  })

  it('deleteForSession wipes only that session', () => {
    appendMark(db, { sessionId: 's1', startedAt: 1 })
    appendMark(db, { sessionId: 's2', startedAt: 1 })
    deleteForSession(db, 's1')
    expect(listMarks(db, 's1').length).toBe(0)
    expect(listMarks(db, 's2').length).toBe(1)
  })

  it('markOpenAsKilled sets finished_at on dangling rows', () => {
    appendMark(db, { sessionId: 's1', startedAt: 100 })
    expect(getOpenMark(db, 's1')?.finishedAt).toBeNull()
    const changes = markOpenAsKilled(db, 's1', 9999)
    expect(changes).toBe(1)
    expect(getOpenMark(db, 's1')).toBeNull()
    const list = listMarks(db, 's1')
    expect(list[0].finishedAt).toBe(9999)
    expect(list[0].exitCode).toBeNull()
  })

  it('closeOpenMark closes the most recent open mark with exit code and command', () => {
    appendMark(db, { sessionId: 's1', startedAt: 100 })
    const closed = closeOpenMark(db, 's1', 250, 0, 'ls -la', '/repo')
    expect(closed?.finishedAt).toBe(250)
    expect(closed?.exitCode).toBe(0)
    expect(closed?.command).toBe('ls -la')
    expect(closed?.cwd).toBe('/repo')
  })

  it('closeOpenMark returns null when no open mark exists', () => {
    expect(closeOpenMark(db, 's1', 1, 0)).toBeNull()
  })
})
