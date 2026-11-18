import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { RunPortsSection } from '../RunPortsSection'
import type { RunPortsSnapshot } from '../../lib/run-ports-api'

afterEach(cleanup)

const run = { projectId: 'p1', projectName: 'Web app', railIndex: 1, ticketId: 7, branch: 'feat/7-x', runId: 'r1' }
const snapshot = (patch: Partial<RunPortsSnapshot> = {}): RunPortsSnapshot => ({
  supported: true,
  scannedAt: 1,
  leases: [],
  ports: [
    { port: 30100, host: '*', pid: 10, command: 'node', cwd: '/w', confidence: 'cwd', squatting: false, worktreePath: '/w', assigned: { start: 30100, end: 30109 }, run },
    { port: 30101, host: '*', pid: 11, command: 'python', cwd: '/tmp', confidence: 'none', squatting: true, worktreePath: '/w', assigned: { start: 30100, end: 30109 }, run },
  ],
  ...patch,
})

describe('RunPortsSection', () => {
  it('lists each run port with its rail, process and how it was attributed, flagging a squatter', () => {
    render(<RunPortsSection snapshot={snapshot()} />)
    const rows = screen.getAllByTestId('run-port')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText(':30100')).toBeTruthy()
    expect(rows[0].textContent).toContain('Rail 2 · #7 · Web app')
    expect(rows[0].textContent).toContain('folder')
    expect(within(rows[1]).getByLabelText("Another process is listening inside this run's assigned ports")).toBeTruthy()
    expect(rows[1].textContent).toContain('taken by another process')
  })

  it('stays out of the way when no run serves a port, and says when ports cannot be read', () => {
    const { container } = render(<RunPortsSection snapshot={snapshot({ ports: [] })} />)
    expect(container.innerHTML).toBe('')
    render(<RunPortsSection snapshot={snapshot({ ports: [], supported: false })} />)
    expect(screen.getByText("Listening ports can't be read on this system.")).toBeTruthy()
  })
})
