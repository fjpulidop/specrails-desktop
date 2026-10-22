import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [], activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { ProjectReviewWipSection } from '../ProjectSettingsSections'
import { REVIEW_WIP_LIMIT_CHANGED_EVENT } from '../../../../lib/review-wip'

function respond(get: unknown, patch: { ok: boolean; body?: unknown } = { ok: true }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (!init?.method) return { ok: true, json: async () => get } as Response
    return { ok: patch.ok, status: patch.ok ? 200 : 400, json: async () => patch.body ?? {} } as Response
  }) as typeof fetch
  return calls
}

beforeEach(() => vi.clearAllMocks())

describe('ProjectReviewWipSection (review-wip-limit)', () => {
  it('defaults to no limit, suggests 5 with a help sentence, and saves it', async () => {
    const calls = respond({ reviewWipLimit: null })
    const changed = vi.fn()
    window.addEventListener(REVIEW_WIP_LIMIT_CHANGED_EVENT, changed)
    render(<ProjectReviewWipSection />)
    const input = await screen.findByTestId('review-wip-input') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('No limit')
    expect(screen.getByText(/We suggest 5/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('review-wip-suggest'))
    expect(input.value).toBe('5')
    fireEvent.click(screen.getByTestId('review-wip-save'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Review limit set to 5'))
    const patch = calls.find((call) => call.init?.method === 'PATCH')!
    expect(patch.url).toBe('/api/projects/p1/settings')
    expect(JSON.parse(String(patch.init!.body))).toEqual({ reviewWipLimit: 5 })
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ limit: 5 })
    window.removeEventListener(REVIEW_WIP_LIMIT_CHANGED_EVENT, changed)
  })

  it('clears the limit with an empty value (null)', async () => {
    const calls = respond({ reviewWipLimit: 3 })
    render(<ProjectReviewWipSection />)
    const input = await screen.findByTestId('review-wip-input') as HTMLInputElement
    expect(input.value).toBe('3')
    expect(screen.queryByTestId('review-wip-suggest')).toBeNull()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('review-wip-save'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Review limit removed'))
    expect(JSON.parse(String(calls.find((call) => call.init?.method === 'PATCH')!.init!.body))).toEqual({ reviewWipLimit: null })
  })

  it.each(['0', '2.5', '101', '-1'])('rejects %s locally without saving', async (value) => {
    const calls = respond({ reviewWipLimit: null })
    render(<ProjectReviewWipSection />)
    const input = await screen.findByTestId('review-wip-input')
    fireEvent.change(input, { target: { value } })
    fireEvent.click(screen.getByTestId('review-wip-save'))
    expect(toast.error).toHaveBeenCalledWith('Enter a whole number from 1 to 100, or leave it empty for no limit.')
    expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(false)
  })

  it('surfaces a server validation error', async () => {
    respond({ reviewWipLimit: null }, { ok: false, body: { error: 'reviewWipLimit must be an integer' } })
    render(<ProjectReviewWipSection />)
    const input = await screen.findByTestId('review-wip-input')
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.click(screen.getByTestId('review-wip-save'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the review limit', { description: 'reviewWipLimit must be an integer' }))
  })
})
