import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '../../../../test-utils'
import { DailyResetResumeSetting } from '../DailyResetResumeSetting'

afterEach(() => { vi.unstubAllGlobals() })

describe('DailyResetResumeSetting', () => {
  it('is on by default and saves a change', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PUT' ? { ok: true } : {}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DailyResetResumeSetting />)
    const toggle = screen.getByRole('switch', { name: 'Resume runs held by the daily budget when the day resets' })
    expect(toggle).toBeChecked()
    expect(screen.getByText(/A run you paused, or one its own spend cap still holds, keeps waiting for you/)).toBeInTheDocument()
    await userEvent.click(toggle)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/settings'), expect.objectContaining({ method: 'PUT', body: JSON.stringify({ resumeOnDailyReset: false }) })))
    expect(toggle).not.toBeChecked()
  })

  it('shows the saved value and rolls back a failed save', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ resumeOnDailyReset: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DailyResetResumeSetting />)
    const toggle = screen.getByRole('switch', { name: 'Resume runs held by the daily budget when the day resets' })
    await waitFor(() => expect(toggle).not.toBeChecked())
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/settings'), expect.objectContaining({ method: 'PUT' }))
  })
})
