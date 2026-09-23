import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'p1' }) }))
vi.mock('../../lib/jira-api', () => ({ jiraApi: { getConnection: vi.fn() } }))

import { useJiraConnection } from '../useJiraConnection'
import { jiraApi } from '../../lib/jira-api'

const api = jiraApi as unknown as { getConnection: ReturnType<typeof vi.fn> }

describe('useJiraConnection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports connected + key when a connection is enabled', async () => {
    api.getConnection.mockResolvedValue({ connected: true, connection: { enabled: true, jiraProjectKey: 'PROJ' } })
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(true)
    expect(result.current.jiraProjectKey).toBe('PROJ')
  })

  it('reports NOT connected when sync is disabled', async () => {
    api.getConnection.mockResolvedValue({ connected: true, connection: { enabled: false, jiraProjectKey: 'PROJ' } })
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(false)
  })

  it('reports NOT connected when there is no connection', async () => {
    api.getConnection.mockResolvedValue({ connected: false })
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(false)
    expect(result.current.jiraProjectKey).toBeNull()
  })

  it('falls back to not-connected on a fetch error', async () => {
    api.getConnection.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useJiraConnection())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(false)
  })
})
