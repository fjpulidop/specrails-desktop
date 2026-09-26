import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LegacyWorkflowUsage } from '../LegacyWorkflowUsage'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number }) => key + (values?.count === undefined ? '' : ` ${values.count}`) }) }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/current' }))
const summary = (total: number) => ({ total, byKind: { legacy_loop_traversal: total, queue_manager_slash: 0, merge_back: 0 }, lastAt: total ? '2026-09-26T12:00:00.000Z' : null, retirementEvidence: 'not-evaluated' })
const response = (value: unknown, ok = true) => ({ ok, json: async () => value } as Response)
afterEach(() => vi.unstubAllGlobals())

it('shows observed counts and keeps a zero distinct from retirement evidence', async () => {
  const fetch = vi.fn().mockResolvedValue(response(summary(0))); vi.stubGlobal('fetch', fetch)
  render(<LegacyWorkflowUsage projectId="a" />)
  expect(await screen.findByText('legacyUsage.total 0')).toBeInTheDocument()
  expect(screen.getByText('legacyUsage.evidence')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledWith('/api/projects/current/analytics/legacy-launches', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  fetch.mockResolvedValue(response(summary(7)))
  fireEvent.click(screen.getByRole('button'))
  expect(await screen.findByText('legacyUsage.total 7')).toBeInTheDocument()
  expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-09-26T12:00:00.000Z')
})

it.each([response({}, false), response({}), response({ ...summary(1), total: -1 })])('reports unavailable data instead of manufacturing zero', async result => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result))
  render(<LegacyWorkflowUsage projectId="a" />)
  expect(await screen.findByText('legacyUsage.unavailable')).toBeInTheDocument()
  expect(screen.queryByText('legacyUsage.total 0')).not.toBeInTheDocument()
})

it('ignores old-project responses and retains the correct project cache when refreshing fails', async () => {
  let resolveOld!: (value: Response) => void
  const fetch = vi.fn().mockResolvedValueOnce(response(summary(3)))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce(response(summary(8)))
    .mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', fetch)
  const { rerender } = render(<LegacyWorkflowUsage projectId="a" />)
  await screen.findByText('legacyUsage.total 3')
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  rerender(<LegacyWorkflowUsage projectId="b" />)
  expect(screen.queryByText('legacyUsage.total 3')).not.toBeInTheDocument()
  await screen.findByText('legacyUsage.total 8')
  await act(async () => resolveOld(response(summary(99))))
  expect(screen.queryByText('legacyUsage.total 99')).not.toBeInTheDocument()
  rerender(<LegacyWorkflowUsage projectId="a" />)
  expect(screen.getByText('legacyUsage.total 3')).toBeInTheDocument()
  expect(await screen.findByText('legacyUsage.unavailable')).toBeInTheDocument()
  expect(screen.queryByText('legacyUsage.total 8')).not.toBeInTheDocument()
})
