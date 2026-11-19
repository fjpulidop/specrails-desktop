import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'
import { toast } from 'sonner'
import { ProjectEnvFilesSection } from '../EnvFilesSection'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'proj-1' }) }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

const jsonRes = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response

describe('ProjectEnvFilesSection', () => {
  let patches: unknown[]
  let stored: Record<string, unknown>
  let failPatch: boolean
  beforeEach(() => {
    vi.clearAllMocks()
    patches = []
    stored = {}
    failPatch = false
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') { patches.push(JSON.parse(init.body as string)); return jsonRes({}, !failPatch) }
      return jsonRes(stored)
    }) as unknown as typeof fetch
  })

  it('is off by default and says what turning it on means', async () => {
    render(<ProjectEnvFilesSection />)
    const toggle = await screen.findByTestId('env-files-switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('env-files-consequence')).toHaveTextContent("Agents in this project's runs can read these files. They are never committed or shown in reviews.")
    fireEvent.click(toggle)
    await waitFor(() => expect(patches).toEqual([{ worktreeEnvFiles: true }]))
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toast.success).toHaveBeenCalledWith("Runs now get this project's .env files")
  })

  it('shows the stored value and reverts when saving fails', async () => {
    stored = { worktreeEnvFiles: true }
    failPatch = true
    render(<ProjectEnvFilesSection />)
    const toggle = await screen.findByTestId('env-files-switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(patches).toEqual([{ worktreeEnvFiles: false }]))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })
})
