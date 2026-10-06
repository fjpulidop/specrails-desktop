import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { AgentsCatalogTab } from '../AgentsCatalogTab'

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => '/api/projects/project-1',
}))

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'project-1',
    projects: [{ id: 'project-1', provider: 'claude' }],
  }),
}))

vi.mock('../../../missions/context/MinimizedChatsContext', () => ({
  useMinimizedChats: () => ({ minimize: vi.fn() }),
  usePendingRestore: () => {},
}))

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

const runtimeRoles = [
  {
    id: 'sr-architect',
    kind: 'upstream',
    roleId: 'architect',
    description: 'Runtime-defined by specrails-core: the implement pipeline runs this role from the Core runtime definition below, not from an installed file.',
    body: 'Runtime architect definition',
  },
  {
    id: 'sr-developer',
    kind: 'upstream',
    roleId: 'developer',
    description: 'Runtime-defined by specrails-core: the implement pipeline runs this role from the Core runtime definition below, not from an installed file.',
    body: 'Runtime developer definition',
  },
  {
    id: 'sr-reviewer',
    kind: 'upstream',
    roleId: 'reviewer',
    description: 'Runtime-defined by specrails-core: the implement pipeline runs this role from the Core runtime definition below, not from an installed file.',
    body: 'Runtime reviewer definition',
  },
]

describe('AgentsCatalogTab', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let catalog: unknown[]

  beforeEach(() => {
    catalog = [...runtimeRoles, { id: 'custom-pentester', kind: 'custom', model: 'opus', description: 'Pentest' }]
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/profiles/catalog?provider=claude')) return response({ agents: catalog })
      if (url.endsWith('/profiles/catalog/custom-pentester?provider=claude')) {
        return response({ id: 'custom-pentester', body: '# custom pentester body' })
      }
      return response({ error: 'unexpected' }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('lists the runtime-defined baseline roles read-only with the catalog body, without fetching a file', async () => {
    render(<AgentsCatalogTab />)

    await screen.findByRole('button', { name: /sr-developer/ })
    expect(screen.getByText('Baseline roles defined by the specrails-core runtime; read-only.')).toBeInTheDocument()

    // The first entry (sr-architect) is selected; its body comes from the catalog.
    expect(await screen.findByText('Runtime architect definition')).toBeInTheDocument()
    expect(screen.getByText('specrails-core runtime definition')).toBeInTheDocument()
    expect(screen.getByText('read-only')).toBeInTheDocument()
    expect(screen.getByText(/Runtime-defined by specrails-core/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/\.claude\/agents\/sr-architect\.md/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /sr-developer/ }))
    expect(await screen.findByText('Runtime developer definition')).toBeInTheDocument()
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContainEqual(
      expect.stringMatching(/\/profiles\/catalog\/sr-/),
    )
  })

  it('keeps custom agents editable and loads their body from the catalog file endpoint', async () => {
    render(<AgentsCatalogTab />)

    await userEvent.click(await screen.findByRole('button', { name: /custom-pentester/ }))

    expect(await screen.findByText('# custom pentester body')).toBeInTheDocument()
    expect(screen.getByText('.claude/agents/custom-pentester.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/profiles/catalog/custom-pentester?provider=claude',
      )
    })
  })

  it('shows an empty state that no longer asks to install upstream agents', async () => {
    catalog = []
    render(<AgentsCatalogTab />)

    expect(await screen.findByText('No custom agents yet')).toBeInTheDocument()
    expect(screen.getByText(/defined by the specrails-core runtime and need no installation/)).toBeInTheDocument()
    expect(screen.queryByText(/npx specrails-core/)).not.toBeInTheDocument()
  })
})
