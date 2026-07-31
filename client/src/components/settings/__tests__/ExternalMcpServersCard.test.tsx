import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { ExternalMcpServersCard } from '../ExternalMcpServersCard'
import { toast } from 'sonner'

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response
}

const EMPTY_PAYLOAD = {
  discovered: { claude: [], gemini: [], kimi: [], codexNative: [], orphanIds: [] },
  settings: { version: 1, servers: {} },
}

const DISCOVERED_PAYLOAD = {
  discovered: {
    claude: [{ id: 'd:claude:jira', name: 'jira' }],
    gemini: [],
    kimi: [],
    codexNative: ['native-tool'],
    orphanIds: [] as string[],
  },
  settings: { version: 1, servers: {} },
}

const STORED_PAYLOAD = {
  discovered: {
    claude: [],
    gemini: [],
    kimi: [],
    codexNative: [],
    orphanIds: ['d:claude:jira'],
  },
  settings: {
    version: 1,
    servers: {
      'd:claude:jira': { source: 'discovered', sourceProvider: 'claude', name: 'jira', providers: { kimi: true } },
      'c:mi-tool': {
        source: 'custom',
        name: 'mi-tool',
        providers: { claude: true },
        transport: { command: 'npx', args: [], env: {} },
      },
    },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ExternalMcpServersCard', () => {
  it('renders discovered candidates with the provider matrix and codex-native display rows', async () => {
    global.fetch = vi.fn(async () => jsonResponse(true, DISCOVERED_PAYLOAD)) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-row-d:claude:jira')
    expect(screen.getByText('jira')).toBeInTheDocument()
    // Four matrix checkboxes per row.
    expect(screen.getByLabelText('jira · claude')).toBeInTheDocument()
    expect(screen.getByLabelText('jira · kimi')).toBeInTheDocument()
    // Codex-native row is display-only (no provider toggles inside it).
    const codexRow = screen.getByTestId('external-mcp-codex-native-tool')
    expect(codexRow.querySelectorAll('button, input')).toHaveLength(0)
    // Consent warning copy present.
    expect(screen.getByText(/without tool-approval prompts/)).toBeInTheDocument()
  })

  it('ticking a provider PATCHes the full registry with the new selection', async () => {
    const calls: { url: string; body?: unknown }[] = []
    global.fetch = vi.fn(async (url: unknown, opts?: { method?: string; body?: string }) => {
      const u = String(url)
      if ((opts?.method ?? 'GET') === 'PATCH') {
        calls.push({ url: u, body: JSON.parse(opts!.body!) })
        return jsonResponse(true, DISCOVERED_PAYLOAD)
      }
      return jsonResponse(true, DISCOVERED_PAYLOAD)
    }) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-row-d:claude:jira')
    fireEvent.click(screen.getByLabelText('jira · kimi'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toEqual({
      servers: {
        'd:claude:jira': {
          source: 'discovered',
          sourceProvider: 'claude',
          name: 'jira',
          providers: { kimi: true },
        },
      },
    })
  })

  it('shows the orphan badge for stored selections missing from their source', async () => {
    global.fetch = vi.fn(async () => jsonResponse(true, STORED_PAYLOAD)) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-row-d:claude:jira')
    expect(screen.getByTestId('external-mcp-orphan')).toBeInTheDocument()
  })

  it('surfaces a typed server rejection and reverts the optimistic state', async () => {
    global.fetch = vi.fn(async (url: unknown, opts?: { method?: string }) => {
      if ((opts?.method ?? 'GET') === 'PATCH') return jsonResponse(false, { error: 'duplicate_server_name' })
      return jsonResponse(true, STORED_PAYLOAD)
    }) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-row-c:mi-tool')
    fireEvent.click(screen.getByLabelText('mi-tool · gemini'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // Reverted: gemini stays unticked for the custom entry.
    expect(screen.getByLabelText('mi-tool · gemini')).toHaveAttribute('aria-checked', 'false')
  })

  it('adds a custom server through the form', async () => {
    const calls: { body?: { servers: Record<string, unknown> } }[] = []
    global.fetch = vi.fn(async (url: unknown, opts?: { method?: string; body?: string }) => {
      if ((opts?.method ?? 'GET') === 'PATCH') {
        calls.push({ body: JSON.parse(opts!.body!) })
        return jsonResponse(true, EMPTY_PAYLOAD)
      }
      return jsonResponse(true, EMPTY_PAYLOAD)
    }) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-card')
    fireEvent.click(screen.getByTestId('external-mcp-add'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mi-tool' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText('Arguments'), { target: { value: '-y some-mcp' } })
    // Env pair editor: add one KEY=VALUE row; an empty-key row is dropped on save.
    fireEvent.click(screen.getByTestId('external-mcp-env-add'))
    fireEvent.click(screen.getByTestId('external-mcp-env-add'))
    fireEvent.change(screen.getByLabelText('KEY 1'), { target: { value: 'TOKEN' } })
    fireEvent.change(screen.getByLabelText('value 1'), { target: { value: 'x' } })
    // Enable-for pills apply the matrix at creation time.
    fireEvent.click(screen.getByTestId('external-mcp-form-provider-claude'))
    fireEvent.click(screen.getByTestId('external-mcp-form-save'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body!.servers['c:mi-tool']).toEqual({
      source: 'custom',
      name: 'mi-tool',
      providers: { claude: true },
      transport: { command: 'npx', args: ['-y', 'some-mcp'], env: { TOKEN: 'x' } },
    })
  })

  it('rejects the reserved specrails name inline — Save disabled, no network call', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(true, EMPTY_PAYLOAD))
    global.fetch = fetchMock as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-card')
    fireEvent.click(screen.getByTestId('external-mcp-add'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'specrails' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } })
    expect(screen.getByTestId('external-mcp-name-hint')).toBeInTheDocument()
    expect(screen.getByTestId('external-mcp-form-save')).toBeDisabled()
    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByTestId('external-mcp-form-save'))
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('flags a duplicate custom name inline', async () => {
    global.fetch = vi.fn(async () => jsonResponse(true, STORED_PAYLOAD)) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-card')
    fireEvent.click(screen.getByTestId('external-mcp-add'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mi-tool' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } })
    expect(screen.getByTestId('external-mcp-name-hint')).toBeInTheDocument()
    expect(screen.getByTestId('external-mcp-form-save')).toBeDisabled()
  })

  it('removes a stored entry via the trash action', async () => {
    const calls: { body?: { servers: Record<string, unknown> } }[] = []
    global.fetch = vi.fn(async (url: unknown, opts?: { method?: string; body?: string }) => {
      if ((opts?.method ?? 'GET') === 'PATCH') {
        calls.push({ body: JSON.parse(opts!.body!) })
        return jsonResponse(true, EMPTY_PAYLOAD)
      }
      return jsonResponse(true, STORED_PAYLOAD)
    }) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-row-c:mi-tool')
    fireEvent.click(screen.getByTestId('external-mcp-remove-c:mi-tool'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(Object.keys(calls[0].body!.servers)).toEqual(['d:claude:jira'])
  })

  it('shows the empty state when nothing is discovered or stored', async () => {
    global.fetch = vi.fn(async () => jsonResponse(true, EMPTY_PAYLOAD)) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-card')
    expect(screen.getByText(/No MCP servers found/)).toBeInTheDocument()
  })
})

describe('ExternalMcpServersCard — edit custom entries', () => {
  it('discovered rows never render an edit action', async () => {
    global.fetch = vi.fn(async () => jsonResponse(true, STORED_PAYLOAD)) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-row-d:claude:jira')
    expect(screen.queryByTestId('external-mcp-edit-d:claude:jira')).not.toBeInTheDocument()
    expect(screen.getByTestId('external-mcp-edit-c:mi-tool')).toBeInTheDocument()
  })

  it('edit prefills the form and a rename re-keys the entry in one PATCH', async () => {
    const calls: { body?: { servers: Record<string, unknown> } }[] = []
    global.fetch = vi.fn(async (url: unknown, opts?: { method?: string; body?: string }) => {
      if ((opts?.method ?? 'GET') === 'PATCH') {
        calls.push({ body: JSON.parse(opts!.body!) })
        return jsonResponse(true, EMPTY_PAYLOAD)
      }
      return jsonResponse(true, STORED_PAYLOAD)
    }) as never
    render(<ExternalMcpServersCard />)
    await screen.findByTestId('external-mcp-row-c:mi-tool')
    fireEvent.click(screen.getByTestId('external-mcp-edit-c:mi-tool'))
    // Prefilled from the stored entry.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('mi-tool')
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('npx')
    // Own name is exempt from the duplicate check.
    expect(screen.queryByTestId('external-mcp-name-hint')).not.toBeInTheDocument()
    expect(screen.getByTestId('external-mcp-form-save')).toBeEnabled()
    // Rename + change command.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'mi-tool2' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'bunx' } })
    fireEvent.click(screen.getByTestId('external-mcp-form-save'))
    await waitFor(() => expect(calls).toHaveLength(1))
    const servers = calls[0].body!.servers
    expect(servers['c:mi-tool']).toBeUndefined()
    expect(servers['c:mi-tool2']).toEqual({
      source: 'custom',
      name: 'mi-tool2',
      providers: { claude: true }, // matrix preserved through the edit
      transport: { command: 'bunx', args: [], env: {} },
    })
    // The untouched discovered entry rides along unchanged.
    expect(servers['d:claude:jira']).toBeDefined()
  })
})
