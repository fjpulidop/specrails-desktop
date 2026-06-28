import { describe, it, expect, beforeEach } from 'vitest'
import { initDesktopDb, type DbInstance } from './desktop-db'
import {
  BUILTIN_CONSTANTS,
  resolveConstants,
  loadConstantMap,
  listConstants,
  createConstant,
  updateConstant,
  deleteConstant,
  LoopConstantError,
} from './loop-constants'

let db: DbInstance
beforeEach(() => { db = initDesktopDb(':memory:') })

describe('loop-constants resolution', () => {
  it('resolves built-in sentinels (the verify/Decider contract)', () => {
    expect(BUILTIN_CONSTANTS.VERIFICATION_PASS).toBe('VERIFICATION: PASS')
    const out = resolveConstants('reported {{const:VERIFICATION_PASS}} ✓', loadConstantMap(db))
    expect(out).toBe('reported VERIFICATION: PASS ✓')
  })

  it('resolves custom constants and lets a custom value override at run time', () => {
    createConstant(db, { id: 'c1', name: 'TICKET_PREFIX', value: 'PROJ-' })
    expect(resolveConstants('{{const:TICKET_PREFIX}}123', loadConstantMap(db))).toBe('PROJ-123')
    updateConstant(db, 'c1', 'ACME-')
    expect(resolveConstants('{{const:TICKET_PREFIX}}123', loadConstantMap(db))).toBe('ACME-123')
  })

  it('drops unknown/deleted constant tokens to empty (never leaks the literal token)', () => {
    expect(resolveConstants('x {{const:NOPE}} y', loadConstantMap(db))).toBe('x  y')
  })
})

describe('loop-constants CRUD', () => {
  it('lists built-ins first, then custom alphabetically', () => {
    db.prepare('DELETE FROM loop_constants').run() // isolate from seeded defaults
    createConstant(db, { id: 'b', name: 'BETA', value: '2' })
    createConstant(db, { id: 'a', name: 'ALPHA', value: '1' })
    const list = listConstants(db)
    expect(list.filter((c) => c.builtin).map((c) => c.name)).toEqual(['VERIFICATION_PASS', 'VERIFICATION_FAIL', 'GUARDRAILS', 'ONE_PER_PASS', 'REMAINING_RULE', 'MERGE_SAFE'])
    expect(list.filter((c) => !c.builtin).map((c) => c.name)).toEqual(['ALPHA', 'BETA'])
  })

  it('exposes GUARDRAILS as a read-only built-in anti-gaming contract', () => {
    expect(BUILTIN_CONSTANTS.GUARDRAILS).toMatch(/do not weaken, delete, or skip tests/i)
    // resolves at run time wherever the token appears
    const out = resolveConstants('Rules:\n{{const:GUARDRAILS}}', loadConstantMap(db))
    expect(out).toContain('Guardrails')
    expect(out).toContain('Prefer fixing the production code')
    // listed as a built-in (read-only)
    expect(listConstants(db).find((c) => c.name === 'GUARDRAILS')?.builtin).toBe(true)
  })

  it('reserves GUARDRAILS — a custom constant cannot redefine it', () => {
    expect(() => createConstant(db, { id: 'g', name: 'GUARDRAILS', value: 'weakened' })).toThrow(/built-in/)
  })

  it('exposes ONE_PER_PASS as a read-only built-in (per-item loop discipline)', () => {
    expect(BUILTIN_CONSTANTS.ONE_PER_PASS).toMatch(/exactly one/i)
    expect(resolveConstants('{{const:ONE_PER_PASS}}', loadConstantMap(db))).toContain('Do NOT start, implement, or fix any other item')
    expect(listConstants(db).find((c) => c.name === 'ONE_PER_PASS')?.builtin).toBe(true)
    expect(() => createConstant(db, { id: 'o', name: 'ONE_PER_PASS', value: 'x' })).toThrow(/built-in/)
  })

  it('exposes REMAINING_RULE as a read-only built-in (only-unimplemented-is-remaining)', () => {
    const out = resolveConstants('{{const:REMAINING_RULE}}', loadConstantMap(db))
    expect(out).toContain('REMAINING: none')
    // the key distinction that stops the wasteful no-op pass
    expect(out).toMatch(/already works is NOT remaining/i)
    expect(listConstants(db).find((c) => c.name === 'REMAINING_RULE')?.builtin).toBe(true)
    expect(() => createConstant(db, { id: 'r', name: 'REMAINING_RULE', value: 'x' })).toThrow(/built-in/)
  })

  it('exposes MERGE_SAFE as a read-only built-in (anti-destructive merge contract)', () => {
    const out = resolveConstants('{{const:MERGE_SAFE}}', loadConstantMap(db))
    expect(out).toMatch(/KEEP BOTH sides/i)
    expect(out).toMatch(/RESOLVE: needs-review/)
    expect(out).toMatch(/conflict markers/i)
    expect(listConstants(db).find((c) => c.name === 'MERGE_SAFE')?.builtin).toBe(true)
    expect(() => createConstant(db, { id: 'm', name: 'MERGE_SAFE', value: 'x' })).toThrow(/built-in/)
  })

  it('seeds editable starter constants (migration 16) — present, custom, with the expected values', () => {
    const byName = new Map(listConstants(db).map((c) => [c.name, c]))
    expect(byName.get('MAIN_BRANCH')?.value).toBe('main')
    expect(byName.get('MAIN_BRANCH')?.builtin).toBeFalsy() // editable, not a read-only built-in
    expect(byName.get('PKG_MANAGER')?.value).toBe('npm')
    expect(byName.get('MIN_COVERAGE')?.value).toBe('80')
    // editable: a seeded default can be updated and deleted like any custom one
    const main = byName.get('MAIN_BRANCH')!
    expect(updateConstant(db, main.id, 'master').value).toBe('master')
    expect(deleteConstant(db, main.id)).toBe(true)
  })

  it('rejects invalid names, reserved (built-in) names, duplicates, and empty values', () => {
    expect(() => createConstant(db, { id: 'x', name: 'has space', value: 'v' })).toThrow(LoopConstantError)
    expect(() => createConstant(db, { id: 'x', name: 'VERIFICATION_PASS', value: 'v' })).toThrow(/built-in/)
    expect(() => createConstant(db, { id: 'x', name: 'OK', value: '' })).toThrow(/value/)
    createConstant(db, { id: 'd1', name: 'DUP', value: 'a' })
    expect(() => createConstant(db, { id: 'd2', name: 'DUP', value: 'b' })).toThrow(/already exists/)
  })

  it('update changes only the value; delete removes it', () => {
    createConstant(db, { id: 'c1', name: 'FOO', value: 'a' })
    expect(updateConstant(db, 'c1', 'b')).toEqual({ id: 'c1', name: 'FOO', value: 'b' })
    expect(() => updateConstant(db, 'missing', 'x')).toThrow(/not found/)
    expect(deleteConstant(db, 'c1')).toBe(true)
    expect(deleteConstant(db, 'c1')).toBe(false)
    expect(listConstants(db).some((c) => c.name === 'FOO')).toBe(false)
  })
})
