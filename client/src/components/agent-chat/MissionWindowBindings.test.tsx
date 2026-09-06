import { act, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MissionWindowsProvider } from '../../context/MissionWindowsContext'
import { MissionWindowBindings } from './MissionWindowBindings'
import type { MissionWindowBridge, MissionWindowEvent, MissionWindowSnapshot, MissionWindowTransfer } from '../../lib/mission-windows'
import { __clearComposerDrafts, captureComposerDraft } from '../../lib/agent-composer-drafts'

const mocks = vi.hoisted(() => ({ chat: {} as Record<string, unknown>, desktop: {} as Record<string, unknown>, workspace: { captureWorkspace: vi.fn(), restoreWorkspace: vi.fn() }, terminals: { ensureProject: vi.fn(), setVisibility: vi.fn(), setUserHeight: vi.fn(), setActive: vi.fn(), getState: vi.fn() } }))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => mocks.chat }))
vi.mock('../../hooks/useDesktop', () => ({ useDesktop: () => mocks.desktop }))
vi.mock('../../context/AgentWorkspaceContext', () => ({ useAgentWorkspace: () => mocks.workspace }))
vi.mock('../../context/TerminalsContext', () => ({ useTerminals: () => mocks.terminals }))

function snapshot(id: string, projectId: string): MissionWindowSnapshot {
  return { version: 1, conversationId: id, projectId, capturedAt: 1, composer: { text: `draft ${id}`, references: [], attachments: [] }, scroll: { top: 99 }, workspace: {
    codePaneOpen: false, jobsPaneOpen: false, analyticsPaneOpen: false, browserOpen: false, pendingCaptures: [],
    terminal: { activeId: `terminal-${id}`, visibility: 'restored', userHeight: 240 }, codeSelection: { path: 'src/main.ts', repositoryId: `repo-${id}` },
  } }
}
function transfer(id: string, projectId: string, revision: number): MissionWindowTransfer { return { windowLabel: `window-${id}`, projectId, conversationId: id, revision, state: 'attaching', snapshot: snapshot(id, projectId) } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); return { promise, resolve } }

function fixture() {
  let receive!: (event: MissionWindowEvent) => void
  const committed: string[] = []
  const select = vi.fn()
  const bridge: MissionWindowBridge = { supported: async () => true, list: async () => [], current: async () => null,
    detach: vi.fn(), ready: vi.fn(), attach: vi.fn(), cancel: vi.fn(), discard: vi.fn(), focus: vi.fn(), ack: vi.fn(),
    listen: async callback => { receive = callback; return () => {} },
  }
  function Host() {
    const [active, setActive] = useState<string | null>(null)
    const [projectId, setProjectId] = useState<string | null>(null)
    mocks.chat = { active: active ? { id: active } : null, selectConversation: async (id: string) => { select(id); setActive(id) } }
    mocks.desktop = { activeProjectId: projectId, setActiveProjectId: setProjectId }
    useLayoutEffect(() => { committed.push(`${active}:${projectId}`) }, [active, projectId])
    return <><MissionWindowBindings /><div data-testid="committed-view">{active}:{projectId}</div></>
  }
  render(<MissionWindowsProvider bridge={bridge}><Host /></MissionWindowsProvider>)
  return { bridge, committed, select, emit: (value: MissionWindowTransfer) => receive({ kind: 'attaching', transfer: value, registered: true }) }
}
afterEach(() => { __clearComposerDrafts(); vi.clearAllMocks() })

describe('MissionWindowBindings with real ownership controller', () => {
  it('acknowledges only after the target conversation and project have committed to the view', async () => {
    const f = fixture()
    const target = transfer('c1', 'p1', 1)
    vi.mocked(f.bridge.ack).mockImplementation(async () => {
      expect(screen.getByTestId('committed-view')).toHaveTextContent('c1:p1')
      expect(f.committed).toContain('c1:p1')
      return target
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => f.emit(target))
    await waitFor(() => expect(f.bridge.ack).toHaveBeenCalledWith('window-c1', 1))
    expect(captureComposerDraft('c1').text).toBe('draft c1')
    expect(mocks.terminals.setActive).toHaveBeenCalledWith('p1', 'terminal-c1')
  })

  it('restores two simultaneous native closes in order instead of replacing the first pending React commit', async () => {
    const f = fixture()
    const first = transfer('c1', 'p1', 1), second = transfer('c2', 'p2', 2)
    const acknowledgeFirst = deferred<void>()
    vi.mocked(f.bridge.ack).mockImplementation(async label => {
      if (label === first.windowLabel) {
        expect(screen.getByTestId('committed-view')).toHaveTextContent('c1:p1')
        await acknowledgeFirst.promise
        return first
      }
      expect(screen.getByTestId('committed-view')).toHaveTextContent('c2:p2')
      return second
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => { f.emit(first); f.emit(second) })
    await waitFor(() => expect(f.bridge.ack).toHaveBeenCalledWith('window-c1', 1))
    expect(f.select.mock.calls.map(call => call[0])).toEqual(['c1'])
    await act(async () => { acknowledgeFirst.resolve() })
    await waitFor(() => expect(f.bridge.ack).toHaveBeenCalledWith('window-c2', 2))
    expect(f.select.mock.calls.map(call => call[0])).toEqual(['c1', 'c2'])
    expect(captureComposerDraft('c1').text).toBe('draft c1')
    expect(captureComposerDraft('c2').text).toBe('draft c2')
  })
})
