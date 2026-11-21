import { describe, expect, it } from 'vitest'
import { initDesktopDb, setDesktopSetting } from '../../../desktop-db'
import { CONFIRM_ABOVE_USD_KEY, ConfirmationLedger, bindingArgs, readConfirmThreshold } from './confirm'
import { confirmNeeded } from './decision-state'

const binding = { session: 's1', tool: 'specrails_deliveries', args: { action: 'decide', ref: 'delivery:shop/57', decision: 'merge_local' }, version: 'v1abc' }

function ledger(start = 1_000_000) {
  const clock = { now: start }
  return { clock, ledger: new ConfirmationLedger({ secret: Buffer.alloc(32, 7), now: () => clock.now }) }
}

describe('confirmation tokens', () => {
  it('verifies a token for the same session, call, arguments and state version', () => {
    const { ledger: l } = ledger()
    const token = l.issue(binding)
    expect(token).toMatch(/^ct1\.[0-9a-z]+\.[\w-]+\.v1abc\.[\w-]+$/)
    expect(l.verify(token, binding)).toEqual({ ok: true })
  })

  it('ignores control fields (confirm, lang, view…) but binds every other argument', () => {
    const { ledger: l } = ledger()
    const token = l.issue(binding)
    expect(l.verify(token, { ...binding, args: { ...binding.args, confirm: token, lang: 'es', dryRun: false } })).toEqual({ ok: true })
    expect(l.verify(token, { ...binding, args: { ...binding.args, decision: 'discard' } })).toEqual({ ok: false, reason: 'mismatch' })
    expect(l.verify(token, { ...binding, session: 's2' })).toEqual({ ok: false, reason: 'mismatch' })
    expect(l.verify(token, { ...binding, tool: 'specrails_runs' })).toEqual({ ok: false, reason: 'mismatch' })
    expect(bindingArgs({ a: 1, confirm: 'x', view: 'detail', cursor: 'c' })).toEqual({ a: 1 })
  })

  it('is stale when the state version changed since the preview', () => {
    const { ledger: l } = ledger()
    const token = l.issue(binding)
    expect(l.verify(token, { ...binding, version: 'v2def' })).toEqual({ ok: false, reason: 'stale' })
  })

  it('is single use (replay is refused) and expires after 10 minutes', () => {
    const { ledger: l, clock } = ledger()
    const token = l.issue(binding)
    l.consume(token)
    expect(l.verify(token, binding)).toEqual({ ok: false, reason: 'replayed' })
    const later = l.issue(binding)
    clock.now += 10 * 60 * 1000
    expect(l.verify(later, binding)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects forged and malformed tokens, and tokens of another process', () => {
    const { ledger: l } = ledger()
    const token = l.issue(binding)
    const parts = token.split('.')
    expect(l.verify([...parts.slice(0, 3), 'v2def', parts[4]].join('.'), { ...binding, version: 'v2def' })).toEqual({ ok: false, reason: 'mismatch' })
    expect(l.verify('ct1.nope', binding)).toEqual({ ok: false, reason: 'malformed' })
    expect(l.verify(true, binding)).toEqual({ ok: false, reason: 'malformed' })
    expect(new ConfirmationLedger().verify(token, binding)).toEqual({ ok: false, reason: 'mismatch' })
  })
})

describe('costly threshold', () => {
  it('defaults to $0.50 and reads the person\'s setting', () => {
    const db = initDesktopDb(':memory:')
    expect(readConfirmThreshold(db)).toBe(0.5)
    setDesktopSetting(db, CONFIRM_ABOVE_USD_KEY, '2')
    expect(readConfirmThreshold(db)).toBe(2)
    setDesktopSetting(db, CONFIRM_ABOVE_USD_KEY, 'garbage')
    expect(readConfirmThreshold(db)).toBe(0.5)
  })

  it('asks for irreversible and external always, for costly above the threshold or more than one run', () => {
    expect(confirmNeeded('irreversible', {}, 0.5)).toBe(true)
    expect(confirmNeeded('external', { highUsd: 0 }, 0.5)).toBe(true)
    expect(confirmNeeded('costly', { highUsd: 0.4, runs: 1 }, 0.5)).toBe(false)
    expect(confirmNeeded('costly', { highUsd: 0.6, runs: 1 }, 0.5)).toBe(true)
    expect(confirmNeeded('costly', { highUsd: 0.1, runs: 3 }, 0.5)).toBe(true)
    expect(confirmNeeded('costly', { highUsd: null }, 0.5)).toBe(true)
    expect(confirmNeeded(null, { highUsd: 100 }, 0.5)).toBe(false)
  })
})
