import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { ProjectAgentEnvModeSection } from '../AgentEnvModeSection'

const desktop = vi.hoisted(() => ({ activeProjectId: 'proj-1' }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: desktop.activeProjectId }) }))
vi.mock('../../../../lib/api', () => ({ getApiBase: () => `/api/projects/${desktop.activeProjectId}` }))

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

const STATUS = {
  mode: 'inherit',
  names: ['HOME', 'PATH', 'SPECRAILS_BUNDLED_CORE_PATH'],
  passthrough: ['NODE_AUTH_TOKEN'],
  providers: [
    { id: 'claude', displayName: 'Claude', patterns: ['ANTHROPIC_*'], names: ['ANTHROPIC_API_KEY'] },
    { id: 'codex', displayName: 'Codex', patterns: ['CODEX_*'], names: [] },
  ],
}

let patchOk = true
function fetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/settings') && method === 'GET') return jsonRes({ agentEnvMode: 'inherit' })
    if (url.endsWith('/settings') && method === 'PATCH') {
      return patchOk ? jsonRes({ ok: true, settings: JSON.parse(String(init?.body)) }) : jsonRes({ error: 'boom' }, false, 400)
    }
    if (url.endsWith('/agent-env/status')) return jsonRes(STATUS)
    return jsonRes({})
  })
}

describe('ProjectAgentEnvModeSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    patchOk = true
    desktop.activeProjectId = 'proj-1'
    global.fetch = fetchMock() as unknown as typeof fetch
  })

  it('shows the current mode and the variable names (never values) per provider', async () => {
    render(<ProjectAgentEnvModeSection />)
    expect(await screen.findByTestId('agent-env-mode-inherit')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('agent-env-mode-minimal')).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(screen.getByTestId('agent-env-shared')).toBeInTheDocument())
    expect(within(screen.getByTestId('agent-env-shared')).getByText('PATH')).toBeInTheDocument()
    expect(within(screen.getByTestId('agent-env-passthrough')).getByText('NODE_AUTH_TOKEN')).toBeInTheDocument()
    expect(within(screen.getByTestId('agent-env-provider-claude')).getByText('ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.getByText(/CODEX_\*/)).toBeInTheDocument()
  })

  it('saves the minimal mode through the project settings PATCH', async () => {
    render(<ProjectAgentEnvModeSection />)
    fireEvent.click(await screen.findByTestId('agent-env-mode-minimal'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    const patch = calls.find((c) => String(c[0]).endsWith('/settings') && c[1]?.method === 'PATCH')
    expect(JSON.parse(patch![1]!.body as string)).toEqual({ agentEnvMode: 'minimal' })
    expect(screen.getByTestId('agent-env-mode-minimal')).toHaveAttribute('aria-checked', 'true')
  })

  it('reverts the selection when the save fails', async () => {
    patchOk = false
    render(<ProjectAgentEnvModeSection />)
    fireEvent.click(await screen.findByTestId('agent-env-mode-minimal'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByTestId('agent-env-mode-inherit')).toHaveAttribute('aria-checked', 'true')
  })

  it('reports an unavailable status without breaking the mode selector', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/agent-env/status')
      ? jsonRes({}, false, 500)
      : jsonRes({ agentEnvMode: 'minimal' })) as unknown as typeof fetch
    render(<ProjectAgentEnvModeSection />)
    expect(await screen.findByTestId('agent-env-mode-minimal')).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByText('Could not read the list of variables.')).toBeInTheDocument())
  })
})
