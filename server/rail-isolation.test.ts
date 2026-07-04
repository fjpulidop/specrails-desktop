import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mutatesRepo, isRailWorktreesEnabled, isRailPrDeliveryEnabled, isolationApplies } from './rail-isolation'

const ORIG = process.env.SPECRAILS_RAIL_WORKTREES
const ORIG_PR = process.env.SPECRAILS_RAIL_DELIVER_PR
afterEach(() => {
  if (ORIG === undefined) delete process.env.SPECRAILS_RAIL_WORKTREES
  else process.env.SPECRAILS_RAIL_WORKTREES = ORIG
  if (ORIG_PR === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
  else process.env.SPECRAILS_RAIL_DELIVER_PR = ORIG_PR
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

describe('isRailWorktreesEnabled (default-on kill-switch)', () => {
  it('is ON when unset (default-on)', () => {
    delete process.env.SPECRAILS_RAIL_WORKTREES
    expect(isRailWorktreesEnabled()).toBe(true)
  })
  it('OFF only for 0/false/off (case-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'OFF', 'False']) {
      process.env.SPECRAILS_RAIL_WORKTREES = v
      expect(isRailWorktreesEnabled()).toBe(false)
    }
  })
  it('ON for explicit truthy AND any unrecognized value (incl. empty)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '']) {
      process.env.SPECRAILS_RAIL_WORKTREES = v
      expect(isRailWorktreesEnabled()).toBe(true)
    }
  })
})

describe('isRailPrDeliveryEnabled (default-on kill-switch)', () => {
  it('is ON when unset (default-on)', () => {
    delete process.env.SPECRAILS_RAIL_DELIVER_PR
    expect(isRailPrDeliveryEnabled()).toBe(true)
  })
  it('OFF only for 0/false/off (case-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'OFF', 'False']) {
      process.env.SPECRAILS_RAIL_DELIVER_PR = v
      expect(isRailPrDeliveryEnabled()).toBe(false)
    }
  })
  it('ON for explicit truthy AND any unrecognized value (incl. empty)', () => {
    for (const v of ['1', 'true', 'on', 'yes', '']) {
      process.env.SPECRAILS_RAIL_DELIVER_PR = v
      expect(isRailPrDeliveryEnabled()).toBe(true)
    }
  })
})

describe('isolationApplies', () => {
  const base = { loopsEnabled: true, scope: 'per-ticket' as const, ticketCount: 2, readOnly: false }
  beforeEach(() => { process.env.SPECRAILS_RAIL_WORKTREES = '1' }) // opt-in for these cases
  afterEach(() => { delete process.env.SPECRAILS_RAIL_WORKTREES })

  it('true for a multi-ticket per-ticket mutating loop when enabled', () => {
    expect(isolationApplies(base)).toBe(true)
  })
  it('true for a SINGLE-ticket rail too (concurrent single-ticket rails are concurrent writers)', () => {
    expect(isolationApplies({ ...base, ticketCount: 1 })).toBe(true)
  })
  it('false when the rail has no tickets', () => {
    expect(isolationApplies({ ...base, ticketCount: 0 })).toBe(false)
  })
  it('scope=all isolates when PR delivery is on (default) — to ship one combined PR', () => {
    delete process.env.SPECRAILS_RAIL_DELIVER_PR // default-on
    expect(isolationApplies({ ...base, scope: 'all' })).toBe(true)
  })
  it('scope=all stays on the shared cwd when PR delivery is off (legacy)', () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    expect(isolationApplies({ ...base, scope: 'all' })).toBe(false)
  })
  it('false for a read-only loop', () => {
    expect(isolationApplies({ ...base, readOnly: true })).toBe(false)
  })
  it('false when loops disabled', () => {
    expect(isolationApplies({ ...base, loopsEnabled: false })).toBe(false)
  })
  it('true when the flag is not set (default-on)', () => {
    delete process.env.SPECRAILS_RAIL_WORKTREES
    expect(isolationApplies(base)).toBe(true)
  })
  it('false when explicitly disabled with the kill-switch', () => {
    process.env.SPECRAILS_RAIL_WORKTREES = '0'
    expect(isolationApplies(base)).toBe(false)
  })
})
