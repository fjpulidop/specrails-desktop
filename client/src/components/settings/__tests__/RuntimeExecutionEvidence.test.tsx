import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '../../../test-utils'
import { RuntimeExecutionEvidence } from '../RuntimeExecutionEvidence'
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response
beforeEach(() => { global.fetch = vi.fn() })
it('lazily discovers opaque sources and pages output in a keyboard reachable scrolling pane', async () => {
  const user = userEvent.setup()
  vi.mocked(fetch).mockResolvedValueOnce(response({ schemaVersion: 1, available: true, items: [{ id: 'check-id', label: 'Medical alerts', repositoryId: 'backend-2', status: 'passed', disposition: 'executed', sources: [{ id: 'source-id', displayPath: 'helper.cjs' }] }] }))
    .mockResolvedValueOnce(response({ schemaVersion: 1, available: true, text: '<script>literal</script>\n' + 'output\n'.repeat(100), nextCursor: 'bound-cursor', truncated: true }))
    .mockResolvedValueOnce(response({ schemaVersion: 1, available: true, text: 'second page' }))
  render(<RuntimeExecutionEvidence projectId="p1" runId="run-1" />)
  expect(fetch).not.toHaveBeenCalled()
  await user.click(screen.getByText('Verification evidence'))
  expect(await screen.findByText('backend-2 · Medical alerts')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'helper.cjs' }))
  const pane = await screen.findByLabelText('Verification output')
  expect(pane).toHaveAttribute('tabindex', '0')
  expect(pane).toHaveClass('overflow-auto', 'max-h-64')
  expect(pane.querySelector('script')).toBeNull()
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('id=check-id&section=source&sourceId=source-id'), expect.anything())
  await user.click(screen.getByRole('button', { name: 'Next output page' }))
  expect(await screen.findByText('second page')).toBeInTheDocument()
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('cursor=bound-cursor'), expect.anything())
})
it('discards a late source response when switching projects', async () => {
  let finish!: (value: Response) => void
  vi.mocked(fetch).mockResolvedValueOnce(response({ schemaVersion: 1, available: true, items: [{ id: 'old', label: 'Old', repositoryId: 'r', status: 'passed', disposition: 'executed', sources: [] }] }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(response({ schemaVersion: 1, available: true, items: [] }))
  const user = userEvent.setup()
  const view = render(<RuntimeExecutionEvidence projectId="p1" runId="run-1" />)
  await user.click(screen.getByText('Verification evidence'))
  await user.click(await screen.findByRole('button', { name: 'stdout' }))
  view.rerender(<RuntimeExecutionEvidence projectId="p2" runId="run-2" />)
  finish(response({ schemaVersion: 1, available: true, text: 'stale secret' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
  expect(screen.queryByText('stale secret')).not.toBeInTheDocument()
})
