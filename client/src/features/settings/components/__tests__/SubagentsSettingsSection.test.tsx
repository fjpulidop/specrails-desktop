import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [], activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { GlobalSubagentsSection, ProjectSubagentsSection } from '../SubagentsSettingsSection'

function respond(get: unknown, ok = true) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (!init?.method) return { ok: true, json: async () => get } as Response
    return { ok, status: ok ? 200 : 500, json: async () => ({}) } as Response
  }) as typeof fetch
  return calls
}

beforeEach(() => vi.clearAllMocks())

describe('ProjectSubagentsSection', () => {
  it('shows the stored value, explains cost and scope, and saves a change', async () => {
    const calls = respond({ allowSubagents: false })
    render(<ProjectSubagentsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Allow sub-agents in this project' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/uses its own tokens/)).toBeInTheDocument()
    expect(screen.getByText(/Implement pipelines are not affected/)).toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sub-agents allowed'))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    const patch = calls.find((call) => call.init?.method === 'PATCH')!
    expect(patch.url).toBe('/api/projects/p1/settings')
    expect(JSON.parse(String(patch.init!.body))).toEqual({ allowSubagents: true })
  })

  it('reverts the switch when saving fails', async () => {
    respond({ allowSubagents: true }, false)
    render(<ProjectSubagentsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Allow sub-agents in this project' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the sub-agent setting', expect.anything()))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })
})

describe('GlobalSubagentsSection', () => {
  it('reads and writes the app-wide setting', async () => {
    const calls = respond({ allowSubagents: true })
    render(<GlobalSubagentsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Allow sub-agents in missions without a project' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sub-agents turned off'))
    const put = calls.find((call) => call.init?.method === 'PUT')!
    expect(put.url).toMatch(/\/api\/settings$/)
    expect(JSON.parse(String(put.init!.body))).toEqual({ allowSubagents: false })
  })
})
