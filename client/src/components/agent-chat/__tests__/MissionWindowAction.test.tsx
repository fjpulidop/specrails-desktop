import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MissionWindowAction, MissionWindowError } from '../MissionWindowAction'
import type { MissionWindowTransfer } from '../../../lib/mission-windows'

const mocks = vi.hoisted(() => ({
  active: null as { id: string; pinned_project_id: string | null } | null,
  windows: { available: true, current: null as MissionWindowTransfer | null, error: null as string | null,
    isPending: vi.fn(), attach: vi.fn(), detach: vi.fn(), clearError: vi.fn() },
}))
vi.mock('../../../context/AgentChatContext', () => ({ useAgentChat: () => ({ active: mocks.active }) }))
vi.mock('../../../context/MissionWindowsContext', () => ({ useMissionWindows: () => mocks.windows }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => ({
  'window.detach': 'Abrir en otra ventana', 'window.attach': 'Reintegrar misión',
  'window.failed': 'No se pudo trasladar la misión.', 'window.dismiss': 'Cerrar aviso',
} as Record<string, string>)[key] ?? key }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.active = { id: 'conversation-a', pinned_project_id: 'project-a' }
  mocks.windows.available = true; mocks.windows.current = null; mocks.windows.error = null
  mocks.windows.isPending.mockReturnValue(false)
  mocks.windows.attach.mockResolvedValue(true); mocks.windows.detach.mockResolvedValue(true)
})
afterEach(() => vi.restoreAllMocks())

describe.each(['MacIntel', 'Win32'])('mission native-window action (%s frontend)', platform => {
  beforeEach(() => { vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform) })

  it('passes the existing project and conversation to detach', () => {
    render(<MissionWindowAction />)
    const action = screen.getByRole('button', { name: 'Abrir en otra ventana' })
    expect(action).toHaveAttribute('title', 'Abrir en otra ventana')
    fireEvent.click(action)
    expect(mocks.windows.detach).toHaveBeenCalledExactlyOnceWith('project-a', 'conversation-a')
    expect(mocks.windows.attach).not.toHaveBeenCalled()
  })

  it('passes null for a Home mission instead of inferring an active project', () => {
    mocks.active = { id: 'home-conversation', pinned_project_id: null }
    render(<MissionWindowAction />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir en otra ventana' }))
    expect(mocks.windows.detach).toHaveBeenCalledExactlyOnceWith(null, 'home-conversation')
  })

  it('reintegrates its own detached conversation through the same action', () => {
    mocks.windows.current = { windowLabel: 'mission-a', projectId: 'project-a', conversationId: 'conversation-a', revision: 4, state: 'detached' }
    render(<MissionWindowAction />)
    fireEvent.click(screen.getByRole('button', { name: 'Reintegrar misión' }))
    expect(mocks.windows.attach).toHaveBeenCalledOnce()
    expect(mocks.windows.detach).not.toHaveBeenCalled()
  })

  it('disables repeated actions while a transfer is pending and becomes usable after failure recovery', () => {
    mocks.windows.isPending.mockReturnValue(true)
    const { rerender } = render(<MissionWindowAction />)
    const action = screen.getByRole('button', { name: 'Abrir en otra ventana' })
    expect(action).toBeDisabled()
    fireEvent.click(action)
    expect(mocks.windows.detach).not.toHaveBeenCalled()
    mocks.windows.isPending.mockReturnValue(false)
    rerender(<MissionWindowAction />)
    expect(action).toBeEnabled()
    fireEvent.click(action)
    expect(mocks.windows.detach).toHaveBeenCalledOnce()
  })
})

it.each(['unavailable', 'no-conversation'])('does not advertise detach for %s', scenario => {
  if (scenario === 'unavailable') mocks.windows.available = false
  else mocks.active = null
  render(<MissionWindowAction />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('shows a recoverable transfer error and dismisses only the notice', () => {
  mocks.windows.error = 'El borrador sigue disponible.'
  render(<MissionWindowError />)
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo trasladar la misión. El borrador sigue disponible.')
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso' }))
  expect(mocks.windows.clearError).toHaveBeenCalledOnce()
  expect(mocks.windows.attach).not.toHaveBeenCalled()
  expect(mocks.windows.detach).not.toHaveBeenCalled()
})
