import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MissionHomeHeader } from '../MissionHomeHeader'
import { purgeProjectCache } from '../../../../hooks/useProjectCache'

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

function mockTickets(tickets: Array<{ status: string }>, gate: Promise<void> = Promise.resolve()) {
  global.fetch = vi.fn(async () => {
    await gate
    return { ok: true, json: async () => ({ tickets }) }
  }) as unknown as typeof fetch
}

describe('MissionHomeHeader', () => {
  beforeEach(() => {
    purgeProjectCache('p1')
    localStorage.clear()
  })

  it('shows nothing before data loads, then only the backlog (reviews and runs are the inbox\'s and the live board\'s)', async () => {
    let release: () => void = () => {}
    mockTickets([{ status: 'todo' }, { status: 'on_review' }, { status: 'on_review' }], new Promise<void>((r) => { release = r }))
    render(<MissionHomeHeader />)
    expect(screen.getByTestId('mission-home-status').textContent).toBe('')
    release()
    await waitFor(() => expect(screen.getByTestId('mission-home-status').textContent).toBe('missionHome.statusTodo:1'))
    expect(screen.queryByTestId('mission-home-review')).toBeNull()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('says nothing for an empty backlog', async () => {
    mockTickets([{ status: 'done' }])
    render(<MissionHomeHeader />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.getByTestId('mission-home-status').textContent).toBe('')
  })
})
