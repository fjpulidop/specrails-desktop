import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ProjectWorktreeEnvSection } from '../settings/ProjectSettingsSections'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'proj-1' }) }))
vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

describe('ProjectWorktreeEnvSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/settings') && method === 'GET') {
        return jsonRes({ worktreeEnvPassthrough: ['AWS_PROFILE'] })
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        return jsonRes({ ok: true, settings: { worktreeEnvPassthrough: body.worktreeEnvPassthrough } })
      }
      return jsonRes({})
    }) as unknown as typeof fetch
  })

  it('adds pasted names, removes chips, and saves only the configured names', async () => {
    render(<ProjectWorktreeEnvSection />)
    const input = await screen.findByTestId('worktree-env-input')
    expect(within(screen.getByTestId('worktree-env-list')).getByText('AWS_PROFILE')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'NODE_AUTH_TOKEN, NPM_TOKEN NODE_AUTH_TOKEN' } })
    fireEvent.click(screen.getByTestId('worktree-env-add'))

    const list = within(screen.getByTestId('worktree-env-list'))
    expect(list.getByText('NODE_AUTH_TOKEN')).toBeInTheDocument()
    expect(list.getByText('NPM_TOKEN')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove AWS_PROFILE' }))
    fireEvent.click(screen.getByTestId('worktree-env-save'))

    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      const patch = calls.find((c) => String(c[0]).endsWith('/settings') && c[1]?.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(JSON.parse(patch![1]!.body as string)).toEqual({
        worktreeEnvPassthrough: ['NODE_AUTH_TOKEN', 'NPM_TOKEN'],
      })
    })
  })

  it('rejects KEY=value input before it can be saved as a secret', async () => {
    render(<ProjectWorktreeEnvSection />)
    const input = await screen.findByTestId('worktree-env-input')

    fireEvent.change(input, { target: { value: 'NODE_AUTH_TOKEN=secret' } })
    fireEvent.click(screen.getByTestId('worktree-env-add'))

    expect(screen.getByTestId('worktree-env-error')).toHaveTextContent('Add only variable names here')
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c) => String(c[0]).endsWith('/settings') && c[1]?.method === 'PATCH')).toBe(false)
  })
})
