import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '../../../../test-utils'
import { LoopMigrationPanel } from '../LoopMigrationPanel'
import { loopsApi, type LoopMigrationReport } from '../../lib/loops-api'

const report: LoopMigrationReport = {
  loops: [
    { id: 'core', name: 'Current workflow', status: 'published', engine: 'core', hasLegacyGraph: false, state: 'current', issues: [] },
    { id: 'stale', name: 'Stale workflow', status: 'published', engine: 'core', hasLegacyGraph: false, state: 'invalid', issues: [{ code: 'unknown_kind', message: 'Unknown piece' }] },
    { id: 'legacy', name: 'Old loop', status: 'draft', engine: 'legacy', hasLegacyGraph: false, state: 'convertible', issues: [] },
  ],
  summary: { current: 1, invalid: 1, convertible: 1, needs_attention: 0, running: 0 },
}
beforeEach(() => { vi.restoreAllMocks() })

it('checks only when asked and offers the explicit conversion for convertible loops', async () => {
  const user = userEvent.setup(), onConvert = vi.fn()
  const migration = vi.spyOn(loopsApi, 'migration').mockResolvedValue(report)
  render(<LoopMigrationPanel onConvert={onConvert} />)
  expect(migration).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Check' }))
  expect(await screen.findByText(/Rejected by the installed Core: 1/)).toBeInTheDocument()
  expect(screen.getByText('Unknown piece')).toBeInTheDocument()
  // Up-to-date loops are summarized, not listed.
  expect(screen.queryByText('Current workflow')).not.toBeInTheDocument()
  // Only the convertible loop gets an action; the rejected definition stays for review.
  const convert = screen.getAllByRole('button', { name: 'Convert to Core' })
  expect(convert).toHaveLength(1)
  await user.click(convert[0])
  expect(onConvert).toHaveBeenCalledWith('legacy')
})

it('reports an unavailable check without stale results', async () => {
  const user = userEvent.setup()
  vi.spyOn(loopsApi, 'migration').mockResolvedValueOnce(report).mockRejectedValueOnce(new Error('Update Core'))
  render(<LoopMigrationPanel onConvert={() => {}} />)
  await user.click(screen.getByRole('button', { name: 'Check' }))
  expect(await screen.findByText('Old loop')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Check' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Update Core')
  expect(screen.queryByText('Old loop')).not.toBeInTheDocument()
})

it('confirms when every loop is current', async () => {
  const user = userEvent.setup()
  vi.spyOn(loopsApi, 'migration').mockResolvedValue({ loops: [report.loops[0]], summary: { ...report.summary, invalid: 0, convertible: 0 } })
  render(<LoopMigrationPanel onConvert={() => {}} />)
  await user.click(screen.getByRole('button', { name: 'Check' }))
  expect(await screen.findByText('Every loop already runs on Core and validates.')).toBeInTheDocument()
})
