import { afterEach, describe, expect, it, vi } from 'vitest'
import { postPrCiAdmissionDismiss, postPrCiAdmissionStart } from '../pr-ci'

afterEach(() => { vi.unstubAllGlobals() })

describe('mission-origin PR CI transport', () => {
  it('starts through the admission route with the ids encoded and no body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ loopRunIds: ['r1'] }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await postPrCiAdmissionStart('p 1', 'a/1')).toEqual({ kind: 'started', loopRunIds: ['r1'], prDeliveryId: null })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/projects\/p%201\/rails\/pr-ci\/admissions\/a%2F1\/start$/)
    expect(init).toEqual({ method: 'POST' })
  })

  it('maps a refusal to its code and detail, a network error to status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'pr_ci_already_running', detail: 'Already running.' }), { status: 409 })))
    expect(await postPrCiAdmissionStart('p1', 'a1')).toEqual({ kind: 'failed', status: 409, code: 'pr_ci_already_running', detail: 'Already running.' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await postPrCiAdmissionStart('p1', 'a1')).toEqual({ kind: 'failed', status: 0, code: null, detail: 'offline' })
  })

  it('dismisses through the admission route and never throws', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await postPrCiAdmissionDismiss('p1', 'a1')).toBe(true)
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/\/rails\/pr-ci\/admissions\/a1\/dismiss$/)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await postPrCiAdmissionDismiss('p1', 'a1')).toBe(false)
  })
})
