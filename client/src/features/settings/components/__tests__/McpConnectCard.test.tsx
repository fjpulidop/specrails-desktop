import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../../../lib/notify-error', () => ({ notifyError: vi.fn() }))

import { McpConnectCard } from '../McpConnectCard'
import { McpPreferencesCard } from '../McpPreferencesCard'
import { toast } from 'sonner'
import { notifyError } from '../../../../lib/notify-error'

type Call = { url: string; method: string; body?: unknown }
let calls: Call[]

function mockFetch(handler: (url: string, method: string, body: unknown) => { status?: number; body: unknown }) {
  calls = []
  global.fetch = vi.fn(async (url: unknown, opts?: { method?: string; body?: string }) => {
    const method = (opts?.method ?? 'GET').toUpperCase()
    const body = opts?.body ? JSON.parse(opts.body) : undefined
    calls.push({ url: String(url), method, body })
    const answer = handler(String(url), method, body)
    const status = answer.status ?? 200
    return { ok: status < 400, status, json: async () => answer.body } as Response
  }) as never
}

const CODEX_COMMAND = 'codex mcp add specrails --env SPECRAILS_MCP_PORT=4200 -- /opt/node /opt/specrails-mcp.js'
const state = (codex: string, claude = 'not_connected') => ({
  available: true,
  clients: [
    { client: 'claude', installed: false, configPath: '/h/.claude.json', state: claude, command: 'claude mcp add …' },
    { client: 'codex', installed: true, configPath: '/h/.codex/config.toml', state: codex, command: CODEX_COMMAND },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
})

describe('McpConnectCard', () => {
  it('lists both clients with their state and copies the exact command', async () => {
    mockFetch(() => ({ body: state('not_connected') }))
    render(<McpConnectCard />)
    const codex = await screen.findByTestId('mcp-connect-codex')
    expect(within(codex).getByText('Not connected')).toBeInTheDocument()
    expect(within(codex).getByText('/h/.codex/config.toml')).toBeInTheDocument()
    expect(within(screen.getByTestId('mcp-connect-claude')).getByText('Not found on this Mac or PC')).toBeInTheDocument()
    fireEvent.click(within(codex).getByTestId('mcp-copy-command-codex'))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CODEX_COMMAND))
    expect(await within(codex).findByText('Command copied')).toBeInTheDocument()
  })

  it('connects in one click and shows the verified round trip', async () => {
    let connected = false
    mockFetch((url, method) => {
      if (method === 'POST') {
        connected = true
        return { body: { outcome: 'create', file: '/h/.codex/config.toml', backup: '/h/.codex/config.toml.bak-specrails-1', mcpEnabled: true, verify: { ok: true, toolCount: 15, approxTokens: 5981 } } }
      }
      return { body: state(connected ? 'connected' : 'not_connected') }
    })
    render(<McpConnectCard />)
    const codex = await screen.findByTestId('mcp-connect-codex')
    fireEvent.click(within(codex).getByRole('button', { name: /Connect Codex/ }))
    expect(await within(codex).findByText('Verified · 15 tools · ≈6.0k tokens')).toBeInTheDocument()
    expect(within(codex).getByText('Backup: /h/.codex/config.toml.bak-specrails-1')).toBeInTheDocument()
    expect(within(codex).getByText(/Start a new Codex session/)).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ client: 'codex', remove: false, force: false })
    expect(toast.success).toHaveBeenCalledWith('Codex is connected to Specrails')
    await waitFor(() => expect(within(codex).getByText('Connected')).toBeInTheDocument())
    expect(within(codex).getByRole('button', { name: /Disconnect/ })).toBeInTheDocument()
  })

  it('disconnects a connected client', async () => {
    mockFetch((url, method) => (method === 'POST' ? { body: { outcome: 'remove', file: 'f', backup: 'f.bak' } } : { body: state('connected') }))
    render(<McpConnectCard />)
    const codex = await screen.findByTestId('mcp-connect-codex')
    fireEvent.click(within(codex).getByRole('button', { name: /Disconnect/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Codex no longer loads Specrails'))
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ client: 'codex', remove: true })
  })

  it('offers to replace a foreign "specrails" entry, then forces', async () => {
    mockFetch((url, method, body) => {
      if (method === 'POST') {
        return (body as { force: boolean }).force
          ? { body: { outcome: 'update', file: '/h/.codex/config.toml', backup: null, mcpEnabled: false } }
          : { status: 409, body: { outcome: 'conflict', reason: 'foreign_entry', file: '/h/.codex/config.toml', error: 'x' } }
      }
      return { body: state('conflict') }
    })
    render(<McpConnectCard />)
    const codex = await screen.findByTestId('mcp-connect-codex')
    fireEvent.click(within(codex).getByRole('button', { name: /Connect Codex/ }))
    expect(await screen.findByText('Replace the existing "specrails" server?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'POST')[1]!.body).toMatchObject({ force: true })
    expect(await within(codex).findByText('Saved. Turn the MCP server on to check the connection.')).toBeInTheDocument()
  })

  it('reports a failed check and a failed request', async () => {
    mockFetch((url, method) => (method === 'POST'
      ? { body: { outcome: 'create', file: 'f', backup: null, mcpEnabled: true, verify: { ok: false, error: 'Specrails app is not running.' } } }
      : { body: state('not_connected') }))
    render(<McpConnectCard />)
    const codex = await screen.findByTestId('mcp-connect-codex')
    fireEvent.click(within(codex).getByRole('button', { name: /Connect Codex/ }))
    expect(await within(codex).findByText('Saved, but the check failed: Specrails app is not running.')).toBeInTheDocument()
    expect(notifyError).toHaveBeenCalledWith('Codex was saved, but the connection check failed', expect.objectContaining({ detail: 'Specrails app is not running.' }))

    mockFetch((url, method) => (method === 'POST' ? { status: 500, body: { error: 'disk full' } } : { body: state('not_connected') }))
    fireEvent.click(within(codex).getByRole('button', { name: /Connect Codex/ }))
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith('Could not connect Codex', expect.objectContaining({ detail: 'disk full' })))
  })
})

describe('McpPreferencesCard', () => {
  const VALUE = { confirmAboveUsd: 0.5, v2: { enabled: true, forcedByEnv: false } }

  it('saves the Ask before spending threshold on Enter and rejects bad amounts', async () => {
    const onChange = vi.fn()
    mockFetch((url, method, body) => ({ body: { ok: true, confirmAboveUsd: (body as { confirmAboveUsd: number }).confirmAboveUsd, v2: VALUE.v2 } }))
    render(<McpPreferencesCard value={VALUE} onChange={onChange} />)
    const input = screen.getByLabelText(/Ask before spending/) as HTMLInputElement
    expect(input.value).toBe('0.5')
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ confirmAboveUsd: 2, v2: VALUE.v2 }))
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { confirmAboveUsd: 2 } })
    expect(calls[0]!.url).toMatch(/\/api\/mcp-admin\/preferences$/)

    fireEvent.change(input, { target: { value: '-3' } })
    fireEvent.blur(input)
    expect(notifyError).toHaveBeenCalledWith('Enter an amount from 0 to 1000')
    expect(input.value).toBe('0.5')
    expect(calls).toHaveLength(1)
  })

  it('switches the simplified MCP tools off (on by default), and locks the switch when the environment sets it', async () => {
    const onChange = vi.fn()
    mockFetch(() => ({ body: { ok: true, confirmAboveUsd: 0.5, v2: { enabled: false, forcedByEnv: false } } }))
    const { rerender } = render(<McpPreferencesCard value={VALUE} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Simplified MCP tools' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ confirmAboveUsd: 0.5, v2: { enabled: false, forcedByEnv: false } }))
    expect(calls[0]!.body).toEqual({ v2: false })
    rerender(<McpPreferencesCard value={{ ...VALUE, v2: { enabled: true, forcedByEnv: true } }} onChange={onChange} />)
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(screen.getByText('Set by SPECRAILS_MCP_V2 in the environment.')).toBeInTheDocument()
  })

  it('restores the value when saving fails', async () => {
    mockFetch(() => ({ status: 400, body: { error: 'confirmAboveUsd must be a number from 0 to 1000' } }))
    render(<McpPreferencesCard value={VALUE} onChange={vi.fn()} />)
    const input = screen.getByLabelText(/Ask before spending/) as HTMLInputElement
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.blur(input)
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith('Could not save the MCP setting', expect.objectContaining({ detail: 'confirmAboveUsd must be a number from 0 to 1000' })))
    expect(input.value).toBe('0.5')
  })
})
