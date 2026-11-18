import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { MissionConnectorsSection, type MissionConnectorsPayload } from '../MissionConnectorsSection'

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response
}

function payload(overrides: Partial<MissionConnectorsPayload> = {}): MissionConnectorsPayload {
  return {
    detectedAt: '2026-11-18T10:00:00.000Z',
    claudeAccountListStale: false,
    measuring: false,
    providers: [
      {
        provider: 'claude',
        detected: true,
        userServersNeedToolSearch: true,
        connectors: [
          { name: 'claude.ai Google Drive', kind: 'account-connector', enabled: true, status: 'connected' },
          { name: 'claude.ai Gmail', kind: 'account-connector', enabled: true, status: 'needs-auth' },
          { name: 'tokensave', kind: 'mcp-server', enabled: true, size: { tools: 81, tokens: 23_044, measuredAt: 't' } },
        ],
      },
      {
        provider: 'codex',
        detected: true,
        connectors: [
          { name: 'blender', kind: 'mcp-server', enabled: true },
          { name: 'computer-use', kind: 'mcp-server', enabled: false, lock: 'disabled-in-provider' },
          { name: 'specrails', kind: 'mcp-server', enabled: false, lock: 'specrails-duplicate' },
        ],
      },
      { provider: 'gemini', detected: true, connectors: [] },
      { provider: 'kimi', detected: false, connectors: [] },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MissionConnectorsSection', () => {
  it('groups connectors per provider with kind, size, status and locked rows', async () => {
    global.fetch = vi.fn(async () => jsonResponse(true, payload())) as never
    render(<MissionConnectorsSection />)
    const claude = await screen.findByTestId('mission-connectors-claude')
    expect(within(claude).getByText('claude.ai Google Drive')).toBeInTheDocument()
    expect(within(claude).getAllByText('Account connector')).toHaveLength(2)
    expect(within(claude).getByText('81 tools · ≈23k tokens')).toBeInTheDocument()
    expect(within(claude).getByText(/Needs sign-in/)).toBeInTheDocument()
    expect(within(claude).getByText(/once Claude can look tools up on demand/)).toBeInTheDocument()
    expect(within(claude).getByText('Not loaded yet')).toBeInTheDocument()

    const codex = screen.getByTestId('mission-connectors-codex')
    expect(within(codex).getByRole('switch', { name: 'Use blender in Codex missions' })).toHaveAttribute('aria-checked', 'true')
    const duplicate = within(codex).getByRole('switch', { name: 'Use specrails in Codex missions' })
    expect(duplicate).toBeDisabled()
    expect(within(codex).getByText(/always left out/)).toBeInTheDocument()
    expect(within(codex).getByText('Turned off in your Codex config.')).toBeInTheDocument()
    // Providers without connectors are not listed.
    expect(screen.queryByTestId('mission-connectors-gemini')).not.toBeInTheDocument()
    expect(screen.getByText(/applies on the next mission turn/)).toBeInTheDocument()
  })

  it('turns a connector off with a PATCH and keeps the server view', async () => {
    const off = payload()
    off.providers[1]!.connectors[0] = { name: 'blender', kind: 'mcp-server', enabled: false }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => jsonResponse(true, init?.method === 'PATCH' ? off : payload()))
    global.fetch = fetchMock as never
    render(<MissionConnectorsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Use blender in Codex missions' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(patch[0]).toMatch(/\/api\/mission-connectors$/)
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ provider: 'codex', name: 'blender', enabled: false })
  })

  it('rolls the toggle back when saving fails', async () => {
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PATCH' ? jsonResponse(false, { error: 'boom' }, 500) : jsonResponse(true, payload())) as never
    render(<MissionConnectorsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Use claude.ai Google Drive in Claude missions' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(toggle).not.toBeDisabled()
  })

  it('refreshes and measures through the header actions', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, payload({ claudeAccountListStale: true })))
    global.fetch = fetchMock as never
    render(<MissionConnectorsSection />)
    await screen.findByText(/did not answer/)
    fireEvent.click(screen.getByTestId('mission-connectors-refresh'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('?refresh=1'))).toBe(true))
    fireEvent.click(screen.getByTestId('mission-connectors-measure'))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/measure') && (init as RequestInit | undefined)?.method === 'POST')).toBe(true))
  })

  it('says so when no provider has connectors', async () => {
    global.fetch = vi.fn(async () => jsonResponse(true, payload({ providers: [{ provider: 'claude', detected: false, connectors: [] }] }))) as never
    render(<MissionConnectorsSection />)
    expect(await screen.findByText(/No connectors or MCP servers found/)).toBeInTheDocument()
  })
})
