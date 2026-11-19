import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '../../../../test-utils'
import { AutoContinueSection } from '../AutoContinueSection'

afterEach(() => { vi.unstubAllGlobals() })

describe('AutoContinueSection', () => {
  it('shows the app-wide setting, on by default, and saves a change', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PUT' ? { ok: true } : { autoContinueRuns: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AutoContinueSection />)
    const toggle = await screen.findByRole('switch', { name: 'Continue automatically, once' })
    expect(toggle).toBeChecked()
    expect(screen.getByText(/Never for credentials or secrets/)).toBeInTheDocument()
    await userEvent.click(toggle)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/settings'), expect.objectContaining({ method: 'PUT', body: JSON.stringify({ autoContinueRuns: false }) })))
    expect(toggle).not.toBeChecked()
  })
})
