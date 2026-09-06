import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { BackgroundProcessChip } from '../../BackgroundProcessChip'
import type { BackgroundProcess } from '../../../types'

function proc(pid: number, command: string, status: BackgroundProcess['status'] = 'running'): BackgroundProcess {
  return {
    pid,
    command,
    cwd: '/repo',
    startedAt: Date.now() - 65_000,
    status,
    chatId: 'chat-1',
    projectId: 'proj-1',
  }
}

describe('BackgroundProcessChip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-07T10:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens logs from the body and stops from the separate button with the full process identity', async () => {
    const kill = vi.fn()
    const open = vi.fn()
    const first = proc(1, 'npm run dev')
    render(
      <div>
        <BackgroundProcessChip process={first} accentVariant="accent-primary" onKill={kill} onOpen={open} />
        <BackgroundProcessChip process={proc(2, 'npm test')} accentVariant="accent-info" onKill={kill} onOpen={open} />
      </div>,
    )

    const chips = screen.getAllByTestId('background-process-chip')
    expect(chips[0].className).toContain('text-accent-primary')
    expect(chips[1].className).toContain('text-accent-info')
    expect(chips[0]).toHaveTextContent('Running')
    fireEvent.click(screen.getByRole('button', { name: 'View logs for npm run dev' }))
    expect(open).toHaveBeenCalledWith(first)
    expect(kill).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByLabelText('Stop npm run dev')) })
    expect(kill).toHaveBeenCalledWith(first)
    expect(open).toHaveBeenCalledOnce()
  })

  it('renders terminal status without a kill action', () => {
    const kill = vi.fn()
    const open = vi.fn()
    render(<BackgroundProcessChip process={proc(3, 'npm run dev', 'failed')} accentVariant="accent-primary" onKill={kill} onOpen={open} />)

    expect(screen.getByTestId('background-process-chip')).toHaveTextContent('Failed')
    expect(screen.queryByLabelText('Stop npm run dev')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View logs for npm run dev' }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('prevents duplicate stop requests and surfaces a retryable stop failure without opening logs', async () => {
    let reject!: (error: Error) => void
    const kill = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no }))
    const open = vi.fn()
    render(<BackgroundProcessChip process={proc(4, 'npm test')} accentVariant="accent-primary" onKill={kill} onOpen={open} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop npm test' }))
    expect(screen.getByRole('button', { name: 'Stop npm test' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop npm test' }))
    await act(async () => { reject(new Error('Process still running')) })
    expect(kill).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not stop the process. Try again.')
    expect(screen.getByRole('button', { name: 'Stop npm test' })).toBeEnabled()
  })

  it('freezes terminal elapsed time at endedAt', () => {
    const process = { ...proc(4, 'npm test', 'exited'), endedAt: Date.now() - 5_000 }
    render(<BackgroundProcessChip process={process} accentVariant="accent-primary" onKill={vi.fn()} onOpen={vi.fn()} />)
    const before = screen.getByTestId('background-process-chip').textContent
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByTestId('background-process-chip').textContent).toBe(before)
  })

  it('allows retry after an asynchronous stop error despite the stopping status', async () => {
    const kill = vi.fn()
    render(<BackgroundProcessChip process={{ ...proc(7, 'npm dev'), status: 'stopping', error: 'Signal failed' }} accentVariant="accent-primary" onKill={kill} onOpen={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not stop the process.')
    const button = screen.getByRole('button', { name: 'Stop npm dev' })
    expect(button).toBeEnabled()
    await act(async () => { fireEvent.click(button) })
    expect(kill).toHaveBeenCalledOnce()
  })
})
