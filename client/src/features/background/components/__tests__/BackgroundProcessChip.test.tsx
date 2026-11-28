import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BackgroundProcessChip } from '../BackgroundProcessChip'
import type { BackgroundProcess } from '../../../../types'

const base: BackgroundProcess = { processId: 'p1', pid: 4242, command: 'npm run dev', cwd: '/w', startedAt: Date.now(), status: 'running', chatId: 'c1', projectId: 'pr1' }

describe('BackgroundProcessChip', () => {
  it('offers Stop for a process the mission owns', () => {
    render(<BackgroundProcessChip process={base} accentVariant="accent-primary" onKill={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Stop npm run dev/i })).toBeInTheDocument()
  })

  it('[spec:mobile-device-testing/mission-processes] shows a mobile test without Stop: Specrails runs it elsewhere', () => {
    render(<BackgroundProcessChip process={{ ...base, pid: 0, observed: true, command: 'Test in Mobile Device · iOS · checkout' }} accentVariant="accent-primary" onKill={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByText(/Test in Mobile Device/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Stop/i })).not.toBeInTheDocument()
  })
})
