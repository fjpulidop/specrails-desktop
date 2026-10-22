import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const readMock = vi.fn()
const saveMock = vi.fn()
vi.mock('../../../../lib/app-updater', () => ({
  readUpdateChannel: () => readMock(),
  saveUpdateChannel: (channel: string) => saveMock(channel),
}))

import { toast } from 'sonner'
import { UpdateChannelSection } from '../UpdateChannelSection'

beforeEach(() => {
  vi.clearAllMocks()
  readMock.mockResolvedValue('latest')
  saveMock.mockResolvedValue(undefined)
})

describe('UpdateChannelSection', () => {
  it('shows the persisted channel with its description', async () => {
    readMock.mockResolvedValue('stable')
    render(<UpdateChannelSection />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Stable' })).toBeChecked())
    expect(screen.getByText(/at least a week on Latest/)).toBeInTheDocument()
  })

  it('persists a new channel', async () => {
    render(<UpdateChannelSection />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Latest' })).toBeChecked())
    fireEvent.click(screen.getByRole('radio', { name: 'Stable' }))
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('stable'))
    expect(screen.getByRole('radio', { name: 'Stable' })).toBeChecked()
    expect(toast.success).toHaveBeenCalled()
  })

  it('reverts when saving fails', async () => {
    saveMock.mockRejectedValue(new Error('HTTP 500'))
    render(<UpdateChannelSection />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Latest' })).toBeChecked())
    fireEvent.click(screen.getByRole('radio', { name: 'Stable' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole('radio', { name: 'Latest' })).toBeChecked()
  })
})
