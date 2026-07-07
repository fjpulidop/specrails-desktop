import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { BackgroundProcessesProvider, useBackgroundProcesses } from '../BackgroundProcessesContext'

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
    unregisterHandler: () => { capturedHandler = null },
  }),
}))

vi.mock('../AgentChatContext', () => ({
  useAgentChat: () => ({
    active: { id: 'chat-1', pinned_project_id: 'proj-1' },
    draftPinnedProjectId: null,
  }),
}))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'proj-1' }),
}))

let latest = { labels: '', kill: async (_pid: number) => undefined as void }
function Probe() {
  const ctx = useBackgroundProcesses()
  latest = {
    labels: ctx.processes.map((p) => `${p.pid}:${p.command}`).join('|'),
    kill: ctx.kill,
  }
  return <div data-testid="processes">{latest.labels}</div>
}

function send(msg: unknown) {
  act(() => { capturedHandler?.(msg) })
}

beforeEach(() => {
  capturedHandler = null
  latest = { labels: '', kill: async (_pid: number) => undefined }
  global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
})

describe('BackgroundProcessesProvider', () => {
  it('filters process events by active project/chat and preserves append order', () => {
    render(<BackgroundProcessesProvider><Probe /></BackgroundProcessesProvider>)
    send({ type: 'background_process.started', projectId: 'proj-1', process: { pid: 1, command: 'npm run dev', cwd: '/repo', startedAt: 10, status: 'running', chatId: 'chat-1', projectId: 'proj-1' } })
    send({ type: 'background_process.started', projectId: 'proj-2', process: { pid: 2, command: 'vite', cwd: '/repo', startedAt: 11, status: 'running', chatId: 'chat-1', projectId: 'proj-2' } })
    send({ type: 'background_process.started', projectId: 'proj-1', process: { pid: 3, command: 'npm test', cwd: '/repo', startedAt: 12, status: 'running', chatId: 'chat-2', projectId: 'proj-1' } })
    send({ type: 'background_process.started', projectId: 'proj-1', process: { pid: 4, command: 'npm run watch', cwd: '/repo', startedAt: 13, status: 'running', chatId: 'chat-1', projectId: 'proj-1' } })

    expect(latest.labels).toBe('1:npm run dev|4:npm run watch')

    send({ type: 'background_process.exited', projectId: 'proj-1', process: { pid: 1, command: 'npm run dev', cwd: '/repo', startedAt: 10, status: 'exited', chatId: 'chat-1', projectId: 'proj-1', exitCode: 0 } })
    expect(latest.labels).toBe('4:npm run watch')
  })

  it('kills through the project-scoped API without confirmation state', async () => {
    render(<BackgroundProcessesProvider><Probe /></BackgroundProcessesProvider>)
    await latest.kill(77)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-1/background-processes/77?chatId=chat-1'),
      { method: 'DELETE' },
    )
  })
})
