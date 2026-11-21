import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, createJob, appendEvent, type DbInstance } from '../../../db'
import type { ProjectContext } from '../../../project-registry'
import { deliveredGoalLine } from './pr-naming'
import { answeredCommitMessage, worktreeCommitMessage } from './rail-isolated-launch-support'

// Live case (ext campaign, contra-c): the ticket said "Keep todos across restarts",
// the person answered "keep it in memory", the run delivered in-memory only, and
// the commit/PR subject still read "feat: keep todos across restarts (#1)".
describe('commit subject after an answer that changed the goal', () => {
  let db: DbInstance
  let dir: string
  const ctx = () => ({ db, getTicketSpec: () => ({ title: 'Keep todos across restarts', labels: [] }) }) as unknown as ProjectContext
  const proposal = (whatChanges: string) => {
    const change = path.join(dir, 'openspec', 'changes', 'in-memory-todos')
    fs.mkdirSync(change, { recursive: true })
    fs.writeFileSync(path.join(change, 'proposal.md'), `## Why\nThe person chose memory only.\n\n## What Changes\n${whatChanges}\n`)
  }

  beforeEach(() => {
    db = initDb(':memory:')
    createJob(db, { id: 'run-1', command: 'loop: Implement #1', started_at: '2026-11-19T10:00:00.000Z' })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answered-goal-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('keeps the ticket title when nobody answered anything', () => {
    proposal('- Keep the todo list in memory only.')
    expect(worktreeCommitMessage(ctx(), 1, 'run-1', false, { worktreePath: dir }).split('\n')[0]).toBe('feat: keep todos across restarts (1)')
  })

  it('says what was delivered, keeps the ticket reference and the title in the body', () => {
    appendEvent(db, 'run-1', 0, { event_type: 'log', source: 'stdout', payload: JSON.stringify({ line: '\n▶ Answer received — the run continues: Memory only' }) })
    proposal('- Keep the todo list **in memory only**; nothing is written to disk.\n- Document it in the README.')
    const message = worktreeCommitMessage(ctx(), 1, 'run-1', false, { worktreePath: dir })
    expect(message.split('\n')[0]).toBe('feat: keep the todo list in memory only; nothing is written to disk (1)')
    expect(message).toContain('Ticket title: Keep todos across restarts')
  })

  it('falls back to the ticket title without a proposal, and leaves partial commits alone', () => {
    appendEvent(db, 'run-1', 0, { event_type: 'log', source: 'stdout', payload: 'human decision received' })
    expect(worktreeCommitMessage(ctx(), 1, 'run-1', false, { worktreePath: dir }).split('\n')[0]).toBe('feat: keep todos across restarts (1)')
    proposal('- Memory only.')
    expect(worktreeCommitMessage(ctx(), 1, 'run-1', true, { worktreePath: dir }).split('\n')[0]).toBe('chore: keep todos across restarts (1)')
  })

  it('rebuilds the message at settle time for a run recovered after a restart (bench5), null without an answer', () => {
    proposal('- total() stays numeric and a new formatMoney(cents) returns the money string.')
    expect(answeredCommitMessage(ctx(), 1, 'run-1', dir)).toBeNull()
    appendEvent(db, 'run-1', 0, { event_type: 'log', source: 'stdout', payload: JSON.stringify({ line: '\n▶ Answer received — the run continues: Keep total() numeric' }) })
    expect(answeredCommitMessage(ctx(), 1, 'run-1', dir)!.split('\n')[0]).toBe('feat: total() stays numeric and a new formatMoney(cents) returns the money… (1)')
  })

  it('reads the first bullet or sentence of What Changes without Markdown', () => {
    expect(deliveredGoalLine('\n\n- Add `applyDiscount()` to [cart](src/cart.js). Tests too.')).toBe('Add applyDiscount() to cart')
    expect(deliveredGoalLine('1. Return integer cents')).toBe('Return integer cents')
    expect(deliveredGoalLine('### Heading\n- x y')).toBe('x y')
    expect(deliveredGoalLine('-')).toBeNull()
    expect(deliveredGoalLine(null)).toBeNull()
  })
})
