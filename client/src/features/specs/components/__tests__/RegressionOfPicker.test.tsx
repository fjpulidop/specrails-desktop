import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/current' }))

import { RegressionOfPicker, isBugTicket } from '../RegressionOfPicker'
import { CreateTicketModal } from '../CreateTicketModal'

const deliveries = [
  { id: 'del-1', loopId: 'factory:implement', loopName: 'Implement', decision: 'merged', ticketIds: [4], createdAt: '2026-10-10T10:00:00.000Z' },
  { id: 'del-2', loopId: null, loopName: 'Quick', decision: 'on_review', ticketIds: [], createdAt: '2026-10-11 10:00:00' },
]
const response = (value: unknown, ok = true) => ({ ok, json: async () => value } as Response)
afterEach(() => vi.unstubAllGlobals())

describe('isBugTicket', () => {
  it('matches the bug label case-insensitively', () => {
    expect(isBugTicket(['Bug'])).toBe(true)
    expect(isBugTicket(['area:bugfix'])).toBe(false)
  })
})

describe('RegressionOfPicker', () => {
  it('lists recent deliveries and reports the picked id', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ deliveries })); vi.stubGlobal('fetch', fetch)
    const onChange = vi.fn()
    render(<RegressionOfPicker value={null} onChange={onChange} />)
    const select = await screen.findByRole('combobox')
    await waitFor(() => expect(select).not.toBeDisabled())
    expect(screen.getAllByRole('option')).toHaveLength(3)
    fireEvent.change(select, { target: { value: 'del-1' } })
    expect(onChange).toHaveBeenCalledWith('del-1')
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(fetch).toHaveBeenCalledWith('/api/projects/current/analytics/loop-economics/deliveries?limit=50', expect.anything())
  })

  it('keeps an existing link that is no longer recent and survives a failed load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, false)))
    render(<RegressionOfPicker value="old-delivery" onChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled())
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('old-delivery')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })
})

describe('CreateTicketModal regressionOf', () => {
  it('shows the picker only for bug tickets and sends metadata.regressionOf', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ deliveries })))
    const onCreate = vi.fn(async () => true)
    render(<CreateTicketModal open allLabels={['bug']} onClose={vi.fn()} onCreate={onCreate} />)
    expect(screen.queryByTestId('regression-of-picker')).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/title/i), { target: { value: 'Crash on save' } })
    const labelInput = screen.getByPlaceholderText(/Type to add labels/i)
    fireEvent.change(labelInput, { target: { value: 'bug' } })
    fireEvent.keyDown(labelInput, { key: 'Enter' })
    expect(await screen.findByTestId('regression-of-picker')).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: /regression/i })
    await waitFor(() => expect(select).not.toBeDisabled())
    fireEvent.change(select, { target: { value: 'del-1' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ labels: ['bug'], metadata: { regressionOf: 'del-1' } }))
  })
})
