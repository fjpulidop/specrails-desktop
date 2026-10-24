import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MissionHomeHeader } from '../MissionHomeHeader'
import { purgeProjectCache } from '../../../../hooks/useProjectCache'

const setUiMode = vi.fn()

vi.mock('react-i18next', async (orig) => {
  const actual = await orig<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { count?: number; project?: string }) =>
        opts?.count !== undefined ? `${key}:${opts.count}` : key,
    }),
  }
})
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'p1', projects: [{ id: 'p1', name: 'Proj' }] }),
}))
vi.mock('../../../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: 'agent', setUiMode, toggleUiMode: vi.fn() }),
}))

describe('MissionHomeHeader', () => {
  beforeEach(() => {
    purgeProjectCache('p1')
    localStorage.clear()
    setUiMode.mockClear()
  })

  it('renders no counts before data loads, then honest counts incl. review', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    global.fetch = vi.fn(async (url: string) => {
      await gate
      if (String(url).includes('/tickets')) {
        return { ok: true, json: async () => ({ tickets: [{ status: 'todo' }, { status: 'on_review' }, { status: 'on_review' }] }) }
      }
      return { ok: true, json: async () => ({ jobs: [{ status: 'running' }] }) }
    }) as unknown as typeof fetch

    render(<MissionHomeHeader />)
    expect(screen.getByTestId('mission-home-status').textContent).toBe('')
    release()
    await waitFor(() => expect(screen.getByTestId('mission-home-review').textContent).toBe('missionHome.statusReview:2'))
    expect(screen.getByTestId('mission-home-status').textContent).toContain('missionHome.statusTodo:1')
    expect(screen.getByTestId('mission-home-status').textContent).toContain('missionHome.statusRunning:1')

    fireEvent.click(screen.getByTestId('mission-home-review'))
    expect(setUiMode).toHaveBeenCalledWith('kanban')
    expect(localStorage.length).toBeGreaterThan(0)
  })
})
