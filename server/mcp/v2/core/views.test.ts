import { describe, expect, it } from 'vitest'
import { optionsOf, resolveFields, resolveView } from './views'
import { matchesPointer, neutralize, untrusted } from './untrusted'

describe('views and fields', () => {
  it('defaults to summary and resolves detail sections', () => {
    expect(resolveView({})).toBe('summary')
    expect(resolveView({ view: 'detail' })).toBe('detail')
    expect(resolveFields({}, ['steps', 'logs'] as const)).toEqual([])
    expect(resolveFields({ view: 'detail' }, ['steps', 'logs'] as const)).toEqual(['steps', 'logs'])
    expect(resolveFields({ fields: ['logs'] }, ['steps', 'logs'] as const)).toEqual(['logs'])
    expect(() => resolveFields({ fields: ['nope'] }, ['steps', 'logs'] as const)).toThrow('Unknown fields nope. Allowed: steps, logs.')
  })

  it('reads options as an object, never null', () => {
    expect(optionsOf({ options: { a: 1 } })).toEqual({ a: 1 })
    expect(optionsOf({ options: [1] })).toEqual({})
    expect(optionsOf({})).toEqual({})
  })
})

describe('untrusted content', () => {
  it('validates pointer patterns and matches concrete pointers and their children', () => {
    expect(untrusted('/data/items/*/body', '/data/items/*/body')).toEqual(['/data/items/*/body'])
    expect(() => untrusted('data/body')).toThrow(/must start/)
    expect(matchesPointer('/data/items/*/body', '/data/items/3/body')).toBe(true)
    expect(matchesPointer('/data/logs', '/data/logs/12')).toBe(true)
    expect(matchesPointer('/data/items/*/body', '/data/items/3/title')).toBe(false)
    expect(matchesPointer('/data/items/*/body', '/data/items')).toBe(false)
  })

  it('strips invisible control and bidi-override characters', () => {
    expect(neutralize('ok‮evil\u0007 text\nnext\tcol')).toBe('okevil text\nnext\tcol')
  })
})
