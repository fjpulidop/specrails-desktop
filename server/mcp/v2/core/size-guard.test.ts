import { describe, expect, it } from 'vitest'
import { success } from './envelope'
import { decodeCursor } from './cursor'
import { approxTokens, guardSize, viewCap, RESPONSE_BUDGET } from './size-guard'

const item = (index: number) => ({ id: `run-${index}`, title: `Implement feature number ${index}`, status: 'running', steps: [{ name: 'implement' }, { name: 'verify' }] })
const size = (value: unknown) => approxTokens(JSON.stringify(value))

describe('size guard', () => {
  it('returns the same envelope when it fits', () => {
    const envelope = success({ items: [item(1)] }, 'One run.')
    expect(guardSize(envelope, { capTokens: 1000 })).toBe(envelope)
  })

  it('drops trailing items of the largest array, whole items only, and resumes with a cursor', () => {
    const items = Array.from({ length: 200 }, (_, index) => item(index))
    const envelope = success({ items, meta: { project: 'shop' } }, 'Runs.')
    const guarded = guardSize(envelope, { capTokens: 600, baseOffset: 50, cursorKey: 'runs:list' })
    expect(size(guarded)).toBeLessThanOrEqual(600)
    const kept = (guarded.data as { items: unknown[] }).items
    expect(kept.length).toBeGreaterThan(0)
    expect(kept).toEqual(items.slice(0, kept.length))
    expect((guarded.data as { meta: unknown }).meta).toEqual({ project: 'shop' })
    expect(guarded.page?.truncated).toBe(true)
    expect(decodeCursor(guarded.page?.cursor, 'runs:list')).toEqual({ offset: 50 + kept.length, path: '/items', key: 'runs:list' })
    expect(guarded.summary).toBe('Runs.')
    expect(envelope.data).toEqual({ items, meta: { project: 'shop' } })
  })

  it('cuts further arrays when one is not enough and says so', () => {
    const data = { a: Array.from({ length: 80 }, (_, i) => item(i)), b: Array.from({ length: 79 }, (_, i) => item(i)) }
    const guarded = guardSize(success(data, 's'), { capTokens: 300 })
    expect(size(guarded)).toBeLessThanOrEqual(300)
    expect(guarded.warnings?.some((warning) => warning.startsWith('truncated /'))).toBe(true)
  })

  it('shortens long strings when arrays are not the problem, then omits data as a last resort', () => {
    const long = success({ body: 'x'.repeat(20_000) }, 's')
    const shortened = guardSize(long, { capTokens: 1500 })
    expect((shortened.data as { body: string }).body).toMatch(/chars cut\]$/)
    expect(shortened.warnings).toContain('long text shortened to 2000 characters')
    const huge = success(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, 'y'.repeat(400)])), 's')
    const omitted = guardSize(huge, { capTokens: 200 })
    expect(omitted.data).toEqual({ omitted: true, reason: 'response_too_large' })
    expect(size(omitted)).toBeLessThanOrEqual(200)
  })

  it('caps summary and detail views per the budgets', () => {
    expect(viewCap('summary')).toBe(RESPONSE_BUDGET.summaryCap)
    expect(viewCap('detail')).toBe(RESPONSE_BUDGET.detailCap)
  })
})
