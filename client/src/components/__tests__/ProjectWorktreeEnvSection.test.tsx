import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { ProjectWorktreeEnvSection } from '../../features/settings/components/ProjectSettingsSections'

const desktop = vi.hoisted(() => ({ activeProjectId: 'proj-1' }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: desktop.activeProjectId }) }))
vi.mock('../../lib/api', () => ({ getApiBase: () => `/api/projects/${desktop.activeProjectId}` }))

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

describe('ProjectWorktreeEnvSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    desktop.activeProjectId = 'proj-1'
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

  function statusReport(entries: Array<[string, string]>, extra: Record<string, unknown> = {}) {
    return {
      loginShellRecovery: true, timeoutMs: 10000, checking: false,
      names: entries.map(([name, status]) => ({ name, status, shell: '/bin/zsh', checkedAt: '2026-10-09T10:00:00.000Z', exitCode: null })),
      ...extra,
    }
  }

  function mockStatusFetch(handler: (url: string, method: string) => unknown) {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/settings') && method === 'GET') return jsonRes({ worktreeEnvPassthrough: ['NODE_AUTH_TOKEN', 'AWS_PROFILE'] })
      const res = handler(url, method)
      if (res instanceof Promise) return res
      return jsonRes(res ?? {})
    }) as unknown as typeof fetch
  }

  it('renders a value-free status chip per saved name and explains unresolved ones', async () => {
    mockStatusFetch((url) => url.endsWith('/env-passthrough/status')
      ? statusReport([['NODE_AUTH_TOKEN', 'not-defined'], ['AWS_PROFILE', 'inherited']])
      : {})
    render(<ProjectWorktreeEnvSection />)
    const chip = await screen.findByTestId('worktree-env-status-NODE_AUTH_TOKEN')
    expect(chip).toHaveTextContent('Not defined')
    expect(chip).toHaveAttribute('data-status', 'not-defined')
    expect(screen.getByTestId('worktree-env-status-AWS_PROFILE')).toHaveTextContent('Inherited')
    const unresolved = screen.getByTestId('worktree-env-unresolved')
    expect(unresolved).toHaveTextContent('NODE_AUTH_TOKEN')
    expect(unresolved).toHaveTextContent('/bin/zsh does not export NODE_AUTH_TOKEN')
    expect(unresolved).not.toHaveTextContent('AWS_PROFILE')
  })

  it.each([
    ['probe-timeout', 'Shell timed out', 'took longer than 10 s'],
    ['probe-failed', 'Shell check failed', 'launch Specrails from a terminal'],
  ])('explains %s with its own hint', async (status, label, hint) => {
    mockStatusFetch((url) => url.endsWith('/env-passthrough/status') ? statusReport([['NODE_AUTH_TOKEN', status], ['AWS_PROFILE', 'recovered']]) : {})
    render(<ProjectWorktreeEnvSection />)
    expect(await screen.findByTestId('worktree-env-status-NODE_AUTH_TOKEN')).toHaveTextContent(label)
    expect(screen.getByTestId('worktree-env-status-AWS_PROFILE')).toHaveTextContent('From login shell')
    expect(screen.getByTestId('worktree-env-unresolved')).toHaveTextContent(hint)
  })

  it('rechecks on demand and shows the refreshed status', async () => {
    mockStatusFetch((url, method) => {
      if (url.endsWith('/env-passthrough/status')) return statusReport([['NODE_AUTH_TOKEN', 'probe-timeout'], ['AWS_PROFILE', 'inherited']])
      if (url.endsWith('/env-passthrough/recheck') && method === 'POST') return statusReport([['NODE_AUTH_TOKEN', 'recovered'], ['AWS_PROFILE', 'inherited']])
      return {}
    })
    render(<ProjectWorktreeEnvSection />)
    expect(await screen.findByTestId('worktree-env-status-NODE_AUTH_TOKEN')).toHaveTextContent('Shell timed out')
    fireEvent.click(screen.getByTestId('worktree-env-recheck'))
    await waitFor(() => expect(screen.getByTestId('worktree-env-status-NODE_AUTH_TOKEN')).toHaveTextContent('From login shell'))
    expect(screen.queryByTestId('worktree-env-unresolved')).toBeNull()
    expect(screen.getByTestId('worktree-env-recheck')).toHaveTextContent('Check again')
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c) => String(c[0]) === '/api/projects/proj-1/env-passthrough/recheck' && c[1]?.method === 'POST')).toBe(true)
  })

  it('reports an unavailable status without breaking the editor', async () => {
    mockStatusFetch((url) => url.endsWith('/env-passthrough/status') ? Promise.resolve(jsonRes({ error: 'down' }, false)) : {})
    render(<ProjectWorktreeEnvSection />)
    await waitFor(() => expect(screen.getByTestId('worktree-env-status-meta')).toHaveTextContent('Could not read the environment status.'))
    expect(screen.getByTestId('worktree-env-input')).toBeInTheDocument()
  })

  it('ignores a stale status response from the previous project after switching', async () => {
    let releaseFirst: (value: Response) => void = () => {}
    mockStatusFetch((url) => {
      if (url === '/api/projects/proj-1/env-passthrough/status') return new Promise<Response>((resolve) => { releaseFirst = resolve })
      if (url === '/api/projects/proj-2/env-passthrough/status') return statusReport([['NODE_AUTH_TOKEN', 'recovered'], ['AWS_PROFILE', 'inherited']])
      return {}
    })
    const view = render(<ProjectWorktreeEnvSection />)
    await screen.findByTestId('worktree-env-input')
    desktop.activeProjectId = 'proj-2'
    view.rerender(<ProjectWorktreeEnvSection />)
    await waitFor(() => expect(screen.getByTestId('worktree-env-status-NODE_AUTH_TOKEN')).toHaveTextContent('From login shell'))
    await act(async () => { releaseFirst(jsonRes(statusReport([['NODE_AUTH_TOKEN', 'probe-failed'], ['AWS_PROFILE', 'probe-failed']]))) })
    expect(screen.getByTestId('worktree-env-status-NODE_AUTH_TOKEN')).toHaveTextContent('From login shell')
    expect(screen.queryByTestId('worktree-env-unresolved')).toBeNull()
  })
})
