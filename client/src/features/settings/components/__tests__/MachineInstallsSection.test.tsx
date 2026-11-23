import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '../../../../test-utils'
import { MachineInstallsSection } from '../MachineInstallsSection'

afterEach(() => { vi.unstubAllGlobals() })

describe('MachineInstallsSection', () => {
  it('lists the remembered installs and revokes one', async () => {
    const approval = { command: 'brew install terraform', manager: 'brew', tool: 'terraform', approvedAt: '2026-11-19 10:00:00', lastUsedAt: null, uses: 2 }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'DELETE' ? { ok: true, approvals: [] } : { approvals: [approval] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MachineInstallsSection />)
    expect(await screen.findByText('brew install terraform')).toBeInTheDocument()
    expect(screen.getByText(/Used 2 times/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Revoke: brew install terraform' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/machine-installs'), expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ command: 'brew install terraform' }) })))
    expect(await screen.findByTestId('machine-installs-empty')).toBeInTheDocument()
  })
})
