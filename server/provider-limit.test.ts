import { describe, it, expect } from 'vitest'
import { classifyProviderLimit, describeProviderLimit, extractLimitReset } from './provider-limit'

describe('classifyProviderLimit', () => {
  it('recognises the claude session-limit notice and its reset hint (run 52124009)', () => {
    const r = classifyProviderLimit("You've hit your session limit · resets 3am (Europe/Madrid)")
    expect(r).toEqual({ kind: 'session_limit', message: "You've hit your session limit · resets 3am (Europe/Madrid)", resetsAt: '3am (Europe/Madrid)' })
    expect(describeProviderLimit(r!)).toBe("You've hit your session limit · resets 3am (Europe/Madrid)")
  })

  it('recognises the API error wrapper (rate_limit / HTTP 429) and typographic apostrophes', () => {
    const wrapped = "Agent terminated early due to an API error: You’ve hit your session limit · resets 3am (Europe/Madrid) (error type rate_limit, HTTP 429, request id req_1, model sent to the API: claude-opus-5)"
    const r = classifyProviderLimit(wrapped)
    expect(r?.kind).toBe('session_limit')
    expect(r?.resetsAt).toBe('3am (Europe/Madrid)')
    expect(classifyProviderLimit('request failed: HTTP 429 Too Many Requests')?.kind).toBe('rate_limit')
    expect(classifyProviderLimit('{"error":{"type":"rate_limit_error"}}')?.kind).toBe('rate_limit')
  })

  it('covers codex and gemini quota notices', () => {
    expect(classifyProviderLimit("You've reached your usage limit. Try again in 2 hours.")?.kind).toBe('quota')
    expect(classifyProviderLimit('insufficient_quota: please check your plan')?.kind).toBe('quota')
    expect(classifyProviderLimit('429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric')?.kind).toBe('quota')
  })

  it('only judges the tail: a spec discussing rate limiting never trips it; empty/null are null', () => {
    const spec = '## Problem Statement\nThe API needs a rate limit per tenant so a HTTP 429 is returned when exceeded.\n' + 'x'.repeat(2000) + '\nAll done, tests green.'
    expect(classifyProviderLimit(spec)).toBeNull()
    expect(classifyProviderLimit('')).toBeNull()
    expect(classifyProviderLimit(null)).toBeNull()
    expect(classifyProviderLimit(undefined)).toBeNull()
    expect(classifyProviderLimit('VERIFICATION: PASS')).toBeNull()
  })

  it('extracts reset hints in the common shapes and caps their length', () => {
    expect(extractLimitReset('resets 3am (Europe/Madrid)')).toBe('3am (Europe/Madrid)')
    expect(extractLimitReset('limit reached, resets at 14:00.')).toBe('14:00')
    expect(extractLimitReset('resets in 2 hours')).toBe('2 hours')
    expect(extractLimitReset('no reset here')).toBeNull()
    expect(describeProviderLimit({ kind: 'quota', message: 'Quota exceeded', resetsAt: 'in 2 hours' })).toBe('Quota exceeded — resets in 2 hours')
    expect(describeProviderLimit({ kind: 'quota', message: 'Quota exceeded', resetsAt: null })).toBe('Quota exceeded')
  })
})
