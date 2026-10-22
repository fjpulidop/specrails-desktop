import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ProjectAgentAuditSection } from '../ProjectSettingsSections'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'proj-1' }) }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

const jsonRes = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response

describe('ProjectAgentAuditSection', () => {
  let patches: unknown[]
  beforeEach(() => {
    vi.clearAllMocks()
    patches = []
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body as string))
        return jsonRes({ ok: true })
      }
      return jsonRes({ agentAuditRetentionDays: 45 })
    }) as unknown as typeof fetch
  })

  it('loads the project retention and saves a new value', async () => {
    render(<ProjectAgentAuditSection />)
    const input = await screen.findByTestId('agent-audit-retention-input')
    expect((input as HTMLInputElement).value).toBe('45')
    fireEvent.change(input, { target: { value: '90' } })
    fireEvent.click(screen.getByTestId('agent-audit-retention-save'))
    await waitFor(() => expect(patches).toEqual([{ agentAuditRetentionDays: 90 }]))
    expect(toast.success).toHaveBeenCalled()
  })

  it('rejects an out-of-range value without saving', async () => {
    render(<ProjectAgentAuditSection />)
    const input = await screen.findByTestId('agent-audit-retention-input')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('agent-audit-retention-save'))
    expect(toast.error).toHaveBeenCalled()
    expect(patches).toEqual([])
  })
})
