import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within, waitFor } from '../../../../test-utils'
import { LoopRolesSection } from '../LoopRolesSection'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../../../providers/hooks/useProviderDetection', () => ({
  useProviderDetection: () => ({ providers: { 'lan-box': { id: 'lan-box', kind: 'local', models: ['qwen3', 'llama4'] } }, detected: ['claude', 'codex', 'lan-box'] }),
}))
import { toast } from 'sonner'

const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
const putBodies = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)) as { roles: Record<string, unknown> })

function mockServer(initial: Record<string, unknown> = {}, put?: (body: { roles: Record<string, unknown> }) => Response) {
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('/api/projects/p1/agent-runtime/loop-roles')
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { roles: Record<string, unknown> }
      return put ? put(body) : response({ roles: body.roles })
    }
    return response({ roles: initial })
  })
}

beforeEach(() => { vi.clearAllMocks() })

describe('LoopRolesSection', () => {
  it('loads the stored roles per project and renders verifier + decider rows with inherit selected when absent', async () => {
    mockServer({ decider: { provider: 'codex', model: 'gpt-5.5', effort: 'low' } })
    render(<LoopRolesSection projectId="p1" providers={['claude', 'codex']} enabled />)
    const verifier = within(await screen.findByRole('group', { name: 'Verifier' }))
    expect(verifier.getByLabelText('Inherit primary')).toBeChecked()
    expect(verifier.queryByLabelText('Model')).toBeNull()
    const decider = within(screen.getByRole('group', { name: 'Decider' }))
    expect(decider.getByLabelText('Codex')).toBeChecked()
    expect(decider.getByLabelText('Model')).toHaveValue('gpt-5.5')
    expect(decider.getByLabelText('Reasoning effort')).toHaveValue('low')
    expect(putBodies()).toHaveLength(0)
  })

  it('PUTs optimistically when a provider, model or effort changes and clears the role on inherit', async () => {
    mockServer()
    const user = userEvent.setup()
    render(<LoopRolesSection projectId="p1" providers={['claude', 'codex']} enabled />)
    const verifier = within(await screen.findByRole('group', { name: 'Verifier' }))
    await user.click(verifier.getByLabelText('Codex'))
    expect(putBodies().at(-1)).toEqual({ roles: { verifier: { provider: 'codex' } } })
    await user.selectOptions(await verifier.findByLabelText('Model'), 'gpt-5.5')
    expect(putBodies().at(-1)).toEqual({ roles: { verifier: { provider: 'codex', model: 'gpt-5.5' } } })
    await user.selectOptions(verifier.getByLabelText('Reasoning effort'), 'high')
    expect(putBodies().at(-1)).toEqual({ roles: { verifier: { provider: 'codex', model: 'gpt-5.5', effort: 'high' } } })
    await user.click(verifier.getByLabelText('Inherit primary'))
    expect(putBodies().at(-1)).toEqual({ roles: {} })
    await waitFor(() => expect(verifier.getByLabelText('Inherit primary')).toBeChecked())
  })

  it('offers a free-text model with the discovered datalist for a local engine', async () => {
    mockServer()
    const user = userEvent.setup()
    render(<LoopRolesSection projectId="p1" providers={['claude', 'lan-box']} enabled />)
    const decider = within(await screen.findByRole('group', { name: 'Decider' }))
    await user.click(decider.getByLabelText('lan-box'))
    const input = await decider.findByLabelText('Model')
    expect(input.tagName).toBe('INPUT')
    expect(Array.from(document.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'))).toEqual(['qwen3', 'llama4'])
    await user.type(input, 'qwen3')
    await user.tab()
    expect(putBodies().at(-1)).toEqual({ roles: { decider: { provider: 'lan-box', model: 'qwen3' } } })
  })

  it('reverts to the previous roles and toasts when the server refuses', async () => {
    mockServer({}, () => response({ error: 'invalid_loop_roles', message: 'provider not detected' }, false))
    const user = userEvent.setup()
    render(<LoopRolesSection projectId="p1" providers={['claude', 'codex']} enabled />)
    const decider = within(await screen.findByRole('group', { name: 'Decider' }))
    await user.click(decider.getByLabelText('Claude'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('provider not detected'))
    expect(decider.getByLabelText('Inherit primary')).toBeChecked()
  })

  it('disables the rows with a hint while the runtime is off', async () => {
    mockServer()
    render(<LoopRolesSection projectId="p1" providers={['claude', 'codex']} enabled={false} />)
    const verifier = await screen.findByRole('group', { name: 'Verifier' })
    expect(screen.getByRole('status')).toHaveTextContent('runtime is disabled')
    expect(within(verifier).getByLabelText('Codex')).toBeDisabled()
  })

  it('surfaces a load failure without breaking the block', async () => {
    global.fetch = vi.fn().mockResolvedValue(response({ error: 'loop_roles_read_failed' }, false))
    render(<LoopRolesSection projectId="p1" providers={['claude']} enabled />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Verifier' })).toBeInTheDocument()
  })
})
