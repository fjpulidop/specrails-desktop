import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BackgroundProcessesPanel } from '../BackgroundProcessesPanel'
import type { BackgroundProcess } from '../../../../types'

afterEach(cleanup)
const proc = (patch: Partial<BackgroundProcess>): BackgroundProcess => ({ processId: 'a', projectId: 'p1', chatId: 'c1', pid: 42, command: 'npm run dev', cwd: '/x', startedAt: 10, status: 'running', ...patch })

describe('BackgroundProcessesPanel', () => {
  it('lists running processes first, opens a process and the full history', () => {
    const onSelect = vi.fn(); const onViewAll = vi.fn(); const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(<BackgroundProcessesPanel loading={false} error={null} onRefresh={onRefresh} onSelect={onSelect} onViewAll={onViewAll}
      processes={[proc({ processId: 'old', command: 'npm test', status: 'exited', startedAt: 99 }), proc({})]} />)
    expect(onRefresh).toHaveBeenCalledOnce()
    const rows = screen.getAllByRole('button').slice(0, 2)
    expect(rows[0].textContent).toContain('npm run dev')
    fireEvent.click(rows[0])
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ processId: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'View all processes' }))
    expect(onViewAll).toHaveBeenCalled()
  })

  it('shows an empty state', () => {
    render(<BackgroundProcessesPanel loading={false} error={null} onRefresh={vi.fn().mockResolvedValue(undefined)} onSelect={vi.fn()} onViewAll={vi.fn()} processes={[]} />)
    expect(screen.getByText(/No processes have been recorded/)).toBeTruthy()
  })
})
