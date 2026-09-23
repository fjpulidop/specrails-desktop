import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'p1' }) }))
vi.mock('../../features/integrations/lib/jira-api', () => ({ jiraApi: { getConnection: vi.fn() } }))

import { useJiraConnection } from '../../features/integrations/hooks/useJiraConnection'
import { jiraApi } from '../../features/integrations/lib/jira-api'

const api = jiraApi as unknown as { getConnection: ReturnType<typeof vi.fn> }

describe('useJiraConnection — discardStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('surfaces discardStatus when the connection is connected + enabled', async () => {
    api.getConnection.mockResolvedValue({
      connected: true,
      connection: { enabled: true, jiraProjectKey: 'PROJ', discardStatus: 'Cancelled' },
    })
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(true)
    expect(result.current.discardStatus).toBe('Cancelled')
  })

  it('returns null discardStatus when sync is disabled (not connected)', async () => {
    api.getConnection.mockResolvedValue({
      connected: true,
      connection: { enabled: false, jiraProjectKey: 'PROJ', discardStatus: 'Cancelled' },
    })
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(false)
    expect(result.current.discardStatus).toBeNull()
  })

  it('returns null discardStatus when there is no connection at all', async () => {
    api.getConnection.mockResolvedValue({ connected: false })
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(false)
    expect(result.current.discardStatus).toBeNull()
  })

  it('returns null discardStatus when connected but the status is not configured', async () => {
    api.getConnection.mockResolvedValue({
      connected: true,
      connection: { enabled: true, jiraProjectKey: 'PROJ', discardStatus: null },
    })
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(true)
    expect(result.current.discardStatus).toBeNull()
  })

  it('falls back to null discardStatus on a fetch error', async () => {
    api.getConnection.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(false)
    expect(result.current.discardStatus).toBeNull()
  })
})
