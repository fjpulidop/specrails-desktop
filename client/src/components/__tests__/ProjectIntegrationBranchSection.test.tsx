import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProjectIntegrationBranchSection } from '../settings/ProjectSettingsSections'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'proj-1' }) }))
vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

describe('ProjectIntegrationBranchSection', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/integration-branch')) {
        return jsonRes({ configured: '', branch: 'main', source: 'repo-default' })
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        return jsonRes({ ok: true })
      }
      return jsonRes({})
    }) as unknown as typeof fetch
  })

  it('shows the resolved base branch after loading', async () => {
    render(<ProjectIntegrationBranchSection />)
    const resolved = await screen.findByTestId('integration-branch-resolved')
    expect(resolved.textContent).toContain('main')
  })

  it('saves a typed integration branch via PATCH /settings', async () => {
    render(<ProjectIntegrationBranchSection />)
    const input = await screen.findByTestId('integration-branch-input')
    fireEvent.change(input, { target: { value: 'develop' } })
    fireEvent.click(screen.getByTestId('integration-branch-save'))

    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      const patch = calls.find((c) => String(c[0]).endsWith('/settings') && c[1]?.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(JSON.parse(patch![1]!.body as string)).toEqual({ integrationBranch: 'develop' })
    })
  })
})
