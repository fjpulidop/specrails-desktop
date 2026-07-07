import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

  it('renders the command with rotated accent classes and kills immediately', () => {
    const kill = vi.fn()
    render(
      <div>
        <BackgroundProcessChip process={proc(1, 'npm run dev')} accentVariant="accent-primary" onKill={kill} />
        <BackgroundProcessChip process={proc(2, 'npm test')} accentVariant="accent-info" onKill={kill} />
      </div>,
    )

    const chips = screen.getAllByTestId('background-process-chip')
    expect(chips[0].className).toContain('text-accent-primary')
    expect(chips[1].className).toContain('text-accent-info')
    fireEvent.click(screen.getByLabelText('Kill npm run dev'))
    expect(kill).toHaveBeenCalledWith(1)
  })

  it('renders terminal status without a kill action', () => {
    const kill = vi.fn()
    render(<BackgroundProcessChip process={proc(3, 'npm run dev', 'failed')} accentVariant="accent-primary" onKill={kill} />)

    expect(screen.getByTestId('background-process-chip')).toHaveTextContent('failed')
    expect(screen.queryByLabelText('Kill npm run dev')).toBeNull()
  })
})
