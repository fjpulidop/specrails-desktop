import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../../../lib/i18n'
import { setActiveProjectId } from '../../../../lib/api'
import type { RailState } from '../../../rails/components/RailsBoard'
import type { LocalTicket } from '../../../../types'

const notify = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/notify-error', () => ({ notifyError: notify }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }) }))

import { useRailLaunch } from '../useRailLaunch'

const rail: RailState = { id: 'rail-0', label: 'Rail 1', ticketIds: [14], mode: 'implement', status: 'idle', aiEngine: 'claude' }
const ticket = { id: 14, title: 'Slow-motion moment', status: 'todo' } as unknown as LocalTicket
const wrapper = ({ children }: { children: ReactNode }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>

function hook() {
  return renderHook(() => useRailLaunch({
    activeProjectId: 'p1', rails: [rail], tickets: [ticket], ticketMap: new Map([[14, ticket]]), updateRails: vi.fn(), railProviders: ['claude'],
    railPrDecisions: new Map(), railPrDecisionsHydrated: true, reviewWipLimit: null, pendingReview: [],
  }), { wrapper })
}

afterEach(() => { vi.unstubAllGlobals(); notify.mockReset(); setActiveProjectId(null) })

describe('a single rail launch', () => {
  it('runs the Launch-all checks first and blocks a signed-out provider with the same words', async () => {
    setActiveProjectId('p1')
    const fetchMock = vi.fn(async (url: string) => String(url).includes('/api/launch-preflight')
      ? new Response(JSON.stringify({ chips: [{ id: 'claude', kind: 'provider', state: 'fail', providerId: 'claude', status: 'signed-out' }], blocking: true, checkedAt: '' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = hook()
    await act(async () => { await result.current.handleToggle('rail-0') })
    expect(fetchMock.mock.calls[0][0]).toContain('/api/launch-preflight?projectId=p1&providers=claude')
    expect(notify).toHaveBeenCalledWith('Fix the failed check before launching.', expect.objectContaining({ detail: 'Claude signed out — sign in first' }))
    expect(fetchMock.mock.calls.some(([url]) => /\/rails\/\d+\/(tickets|launch)$/.test(String(url)))).toBe(false)
  })

  it('launches when nothing blocks', async () => {
    setActiveProjectId('p1')
    const fetchMock = vi.fn(async (url: string) => String(url).includes('/api/launch-preflight')
      ? new Response(JSON.stringify({ chips: [{ id: 'claude', kind: 'provider', state: 'ok', providerId: 'claude', status: 'signed-in' }], blocking: false, checkedAt: '' }), { status: 200 })
      : new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = hook()
    await act(async () => { await result.current.handleToggle('rail-0') })
    expect(notify).not.toHaveBeenCalledWith('Fix the failed check before launching.', expect.anything())
    expect(fetchMock.mock.calls.some(([url]) => /\/rails\/\d+\/launch$/.test(String(url)))).toBe(true)
  })
})
