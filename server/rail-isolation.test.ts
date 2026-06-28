import { describe, it, expect, afterEach } from 'vitest'
import { mutatesRepo, isRailWorktreesEnabled, isolationApplies } from './rail-isolation'

const ORIG = process.env.SPECRAILS_RAIL_WORKTREES
afterEach(() => {
  if (ORIG === undefined) delete process.env.SPECRAILS_RAIL_WORKTREES
  else process.env.SPECRAILS_RAIL_WORKTREES = ORIG
})

describe('mutatesRepo', () => {
  it('defaults to true when no readOnly flag', () => {
    expect(mutatesRepo({})).toBe(true)
    expect(mutatesRepo({ readOnly: false })).toBe(true)
  })
  it('is false only when explicitly read-only', () => {
    expect(mutatesRepo({ readOnly: true })).toBe(false)
  })
})

describe('isRailWorktreesEnabled (kill-switch, default on)', () => {
  it('is on when unset', () => {
    delete process.env.SPECRAILS_RAIL_WORKTREES
    expect(isRailWorktreesEnabled()).toBe(true)
  })
  it('off for 0/false/off (case-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'OFF', 'False']) {
      process.env.SPECRAILS_RAIL_WORKTREES = v
      expect(isRailWorktreesEnabled()).toBe(false)
    }
  })
  it('on for any other value', () => {
    process.env.SPECRAILS_RAIL_WORKTREES = '1'
    expect(isRailWorktreesEnabled()).toBe(true)
  })
})

describe('isolationApplies', () => {
  const base = { loopsEnabled: true, scope: 'per-ticket' as const, ticketCount: 2, readOnly: false }
  afterEach(() => { delete process.env.SPECRAILS_RAIL_WORKTREES })

  it('true for multi-ticket per-ticket mutating loop with kill-switch off', () => {
    expect(isolationApplies(base)).toBe(true)
  })
  it('false when only one ticket', () => {
    expect(isolationApplies({ ...base, ticketCount: 1 })).toBe(false)
  })
  it('false for scope=all (single run)', () => {
    expect(isolationApplies({ ...base, scope: 'all' })).toBe(false)
  })
  it('false for a read-only loop', () => {
    expect(isolationApplies({ ...base, readOnly: true })).toBe(false)
  })
  it('false when loops disabled', () => {
    expect(isolationApplies({ ...base, loopsEnabled: false })).toBe(false)
  })
  it('false when the kill-switch is set', () => {
    process.env.SPECRAILS_RAIL_WORKTREES = '0'
    expect(isolationApplies(base)).toBe(false)
  })
})
