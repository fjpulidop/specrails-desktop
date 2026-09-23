import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { McpSettingsSection } from '../McpSettingsSection'
import { toast } from 'sonner'

interface Handler {
  match: (u: string, m: string) => boolean
  ok?: boolean
  status?: number
  body?: unknown
}

function mockApi(handlers: Handler[]) {
  global.fetch = vi.fn(async (url: unknown, opts?: { method?: string }) => {
    const u = String(url)
    const m = (opts?.method ?? 'GET').toUpperCase()
    const h = handlers.find((x) => x.match(u, m))
    return {
      ok: h?.ok ?? true,
      status: h?.status ?? 200,
      json: async () => h?.body ?? {},
    } as Response
  }) as never
}

const STATUS_OFF = {
  enabled: false,
  running: false,
  activeSessions: 0,
  toolCount: 5,
  tiers: { write: false, aiSpawn: false, destructive: false },
  tokenHint: '…ab12',
}
const STATUS_ON = {
  ...STATUS_OFF,
  enabled: true,
  running: true,
  activeSessions: 2,
}
const CONFIG = { httpUrl: 'http://127.0.0.1:4200/api/mcp', bridgeCommand: 'specrails-mcp', hasToken: true }

// jsdom lacks a clipboard; provide a writable stub so copy actions succeed.
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  })
})

describe('McpSettingsSection', () => {
  it('renders the off state with explainer and a Turn on button', async () => {
    mockApi([
      { match: (u) => u.endsWith('/mcp-admin/status'), body: STATUS_OFF },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
    ])
    render(<McpSettingsSection />)
    await screen.findByText('MCP server')
    expect(screen.getByText('MCP server off')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument()
    // Explainer text present.
    expect(screen.getByText(/Model Context Protocol/)).toBeInTheDocument()
    // Tier controls + config + token are hidden while disabled.
    expect(screen.queryByText('Permission tiers')).not.toBeInTheDocument()
  })

  it('enabling reveals tiers, config block, and token controls', async () => {
    mockApi([
      { match: (u, m) => u.endsWith('/mcp-admin/status') && m === 'GET', body: STATUS_OFF },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
      { match: (u, m) => u.endsWith('/mcp-admin/enable') && m === 'POST', body: { enabled: true, running: true } },
    ])
    render(<McpSettingsSection />)
    const turnOn = await screen.findByRole('button', { name: 'Turn on' })

    // After enabling, the status re-read returns the ON snapshot.
    mockApi([
      { match: (u) => u.endsWith('/mcp-admin/status'), body: STATUS_ON },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
      { match: (u, m) => u.endsWith('/mcp-admin/enable') && m === 'POST', body: { enabled: true, running: true } },
    ])
    fireEvent.click(turnOn)

    await screen.findByText('Permission tiers')
    expect(screen.getByText('Client config')).toBeInTheDocument()
    expect(screen.getByText('Access token')).toBeInTheDocument()
    // The bridge command appears in the (token-free) config block.
    expect(screen.getByText(/specrails-mcp/)).toBeInTheDocument()
    // Token hint is shown (last-4 only).
    expect(screen.getByText(/ab12/)).toBeInTheDocument()
  })

  it('Read tier is checked and disabled; toggling Write PATCHes tiers', async () => {
    mockApi([
      { match: (u) => u.endsWith('/mcp-admin/status'), body: STATUS_ON },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
      {
        match: (u, m) => u.endsWith('/mcp-admin/tiers') && m === 'PATCH',
        body: { ok: true, tiers: { write: true, aiSpawn: false, destructive: false } },
      },
    ])
    render(<McpSettingsSection />)
    const readBox = (await screen.findByLabelText('Read')) as HTMLInputElement
    expect(readBox.checked).toBe(true)
    expect(readBox.disabled).toBe(true)

    const writeBox = screen.getByLabelText('Write') as HTMLInputElement
    expect(writeBox.checked).toBe(false)
    fireEvent.click(writeBox)

    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      const patch = calls.find(
        (c) => String(c[0]).endsWith('/mcp-admin/tiers') && (c[1] as { method?: string })?.method === 'PATCH'
      )
      expect(patch).toBeTruthy()
      expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({ write: true })
    })
    await waitFor(() => expect((screen.getByLabelText('Write') as HTMLInputElement).checked).toBe(true))
  })

  it('Copy config writes the token-free config to the clipboard', async () => {
    mockApi([
      { match: (u) => u.endsWith('/mcp-admin/status'), body: STATUS_ON },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
    ])
    render(<McpSettingsSection />)
    const copyBtn = await screen.findByTestId('mcp-copy-config')
    fireEvent.click(copyBtn)
    await waitFor(() => {
      const written = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(written).toContain('specrails-mcp')
      // Token must never appear in the config block.
      expect(written).not.toMatch(/token/i)
    })
    await screen.findByText('Config copied')
  })

  it('Copy token fetches the token and copies it', async () => {
    mockApi([
      { match: (u) => u.endsWith('/mcp-admin/status'), body: STATUS_ON },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
      { match: (u, m) => u.endsWith('/mcp-admin/token') && m === 'GET', body: { token: 'secret-token-xyz' } },
    ])
    render(<McpSettingsSection />)
    const copyToken = await screen.findByTestId('mcp-copy-token')
    fireEvent.click(copyToken)
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('secret-token-xyz')
    })
    await screen.findByText('Token copied')
  })

  it('Regenerate confirms then POSTs and toasts success', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockApi([
      { match: (u) => u.endsWith('/mcp-admin/status'), body: STATUS_ON },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
      { match: (u, m) => u.endsWith('/mcp-admin/regenerate-token') && m === 'POST', body: { token: 'new' } },
    ])
    render(<McpSettingsSection />)
    const regen = await screen.findByTestId('mcp-regenerate-token')
    fireEvent.click(regen)
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      const post = calls.find(
        (c) => String(c[0]).endsWith('/mcp-admin/regenerate-token') && (c[1] as { method?: string })?.method === 'POST'
      )
      expect(post).toBeTruthy()
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    confirmSpy.mockRestore()
  })

  it('does not regenerate when the confirm is dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mockApi([
      { match: (u) => u.endsWith('/mcp-admin/status'), body: STATUS_ON },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
    ])
    render(<McpSettingsSection />)
    const regen = await screen.findByTestId('mcp-regenerate-token')
    fireEvent.click(regen)
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(
        calls.find((c) => String(c[0]).endsWith('/mcp-admin/regenerate-token'))
      ).toBeFalsy()
    })
    confirmSpy.mockRestore()
  })

  it('toasts on enable failure', async () => {
    mockApi([
      { match: (u, m) => u.endsWith('/mcp-admin/status') && m === 'GET', body: STATUS_OFF },
      { match: (u) => u.endsWith('/mcp-admin/config'), body: CONFIG },
      { match: (u, m) => u.endsWith('/mcp-admin/enable') && m === 'POST', ok: false, status: 409, body: { error: 'port busy' } },
    ])
    render(<McpSettingsSection />)
    const turnOn = await screen.findByRole('button', { name: 'Turn on' })
    fireEvent.click(turnOn)
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })
})
