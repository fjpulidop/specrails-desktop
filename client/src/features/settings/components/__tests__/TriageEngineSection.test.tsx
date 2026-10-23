import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'
import { TriageEngineSection } from '../TriageEngineSection'

const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
let stored: Record<string, unknown>
let refuse = false

beforeEach(() => {
  vi.clearAllMocks()
  refuse = false
  // The file still holds a legacy loop role the triage UI must never drop.
  stored = { verifier: { provider: 'claude', model: 'sonnet' } }
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/providers/detected')) return response({ detected: ['claude', 'codex'], providers: {} })
    if (String(url).endsWith('/agent-runtime/loop-roles')) {
      if (init?.method === 'PUT') {
        if (refuse) return response({ error: 'invalid_loop_roles', message: 'Loop role "triage": provider "codex" is not detected' }, false)
        stored = (JSON.parse(String(init.body)) as { roles: Record<string, unknown> }).roles
        return response({ roles: stored })
      }
      return response({ roles: stored })
    }
    return response({})
  })
})

const puts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) as { roles: Record<string, unknown> } }))

describe('TriageEngineSection', () => {
  it('starts on the primary provider and saves a triage engine, keeping the other loop roles', async () => {
    render(<TriageEngineSection projectId="p1" providers={['claude', 'codex']} />)
    expect(await screen.findByRole('heading', { name: 'Spec triage engine' })).toBeInTheDocument()
    const primary = await screen.findByRole('radio', { name: 'Primary provider' })
    expect(primary).toBeChecked()
    expect(screen.queryByLabelText('Model')).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.url).toContain('/api/projects/p1/agent-runtime/loop-roles')
    expect(puts()[0]!.body.roles).toEqual({ verifier: { provider: 'claude', model: 'sonnet' }, triage: { provider: 'codex' } })

    // A model choice is saved with the provider; the default is the cheapest model.
    const model = await screen.findByLabelText('Model')
    expect(screen.getByRole('option', { name: 'Cheapest model (default)' })).toBeInTheDocument()
    const option = model.querySelectorAll('option')[1]!
    fireEvent.change(model, { target: { value: option.value } })
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]!.body.roles.triage).toEqual({ provider: 'codex', model: option.value })

    // Back to the primary removes the triage role only.
    fireEvent.click(screen.getByRole('radio', { name: 'Primary provider' }))
    await waitFor(() => expect(puts()).toHaveLength(3))
    expect(puts()[2]!.body.roles).toEqual({ verifier: { provider: 'claude', model: 'sonnet' } })
  })

  it('reverts a refused save and says why', async () => {
    refuse = true
    render(<TriageEngineSection projectId="p1" providers={['claude', 'codex']} />)
    fireEvent.click(await screen.findByRole('radio', { name: /Codex/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Loop role "triage": provider "codex" is not detected'))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Primary provider' })).toBeChecked())
  })

  it('explains an unreadable engine without blocking the page', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string) => String(url).endsWith('/loop-roles') ? response({}, false) : response({ detected: [], providers: {} }))
    render(<TriageEngineSection projectId="p1" providers={['claude']} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Triage keeps using the primary provider')
  })
})
