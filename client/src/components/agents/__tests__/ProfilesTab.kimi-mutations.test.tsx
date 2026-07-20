import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '../../../test-utils'
import userEvent from '@testing-library/user-event'
import { ProfilesTab } from '../ProfilesTab'

vi.mock('../../../lib/api', () => ({
  getApiBase: () => '/api/projects/project-1',
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

const kimiProfile = {
  schemaVersion: 1 as const,
  name: 'team',
  description: 'Kimi profile',
  provider: 'kimi',
  orchestrator: { model: 'k3' },
  agents: [
    { id: 'sr-architect', model: 'k3', required: true },
    { id: 'sr-developer', model: 'k3', required: true },
    { id: 'sr-reviewer', model: 'k3', required: true },
  ],
  routing: [{ default: true, agent: 'sr-developer' }],
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('ProfilesTab Kimi mutations', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/profiles/context')) {
        return response({
          primaryProvider: 'kimi',
          providers: ['claude', 'kimi'],
          catalogs: {
            claude: {
              models: [{ value: 'sonnet', label: 'Claude Sonnet' }],
              defaultModel: 'sonnet',
              baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
            },
            kimi: {
              models: [{ value: 'k3', label: 'Kimi K3' }],
              defaultModel: 'k3',
              baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
            },
          },
        })
      }
      if (url.endsWith('/profiles?provider=kimi') && !init?.method) {
        return response({
          profiles: [{
            name: 'team',
            description: 'Kimi profile',
            provider: 'kimi',
            isDefault: false,
          }],
        })
      }
      if (url.endsWith('/profiles/catalog?provider=kimi')) {
        return response({ agents: [] })
      }
      if (url.includes('/profiles/team/duplicate?provider=kimi')) {
        return response({ profile: { ...kimiProfile, name: 'team-copy' } }, 201)
      }
      if (url.includes('/profiles/team?provider=kimi') && init?.method === 'DELETE') {
        return response({ ok: true })
      }
      if (url.includes('/profiles/') && url.includes('provider=kimi')) {
        return response({ profile: kimiProfile })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('duplicates within the selected Kimi provider namespace', async () => {
    const user = userEvent.setup()
    render(<ProfilesTab />)

    await screen.findByText('team')
    await user.click(screen.getByTitle('Duplicate'))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/profiles/team/duplicate?provider=kimi',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'team-copy', provider: 'kimi' }),
        }),
      )
    })
  })

  it('deletes only the selected Kimi provider profile', async () => {
    const user = userEvent.setup()
    render(<ProfilesTab />)

    await screen.findByText('team')
    await user.click(screen.getByTitle('Delete'))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/project-1/profiles/team?provider=kimi',
        { method: 'DELETE' },
      )
    })
  })
})
