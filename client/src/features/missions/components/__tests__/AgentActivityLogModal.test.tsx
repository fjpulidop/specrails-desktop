import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }))

import { AgentActivityLogModal } from '../AgentActivityLogModal'
import { AgentActivityChip } from '../AgentActivityChip'
import type { AgentLiveTool } from '../../context/AgentChatContext'

const TOOLS: AgentLiveTool[] = [
  { id: 't1', tool: 'Bash', input: '{"command":"npm test"}', output: 'PASS (6)', toolId: 'tu_1', at: '2026-07-27T10:00:00.000Z' },
  { id: 't2', tool: 'mcp__specrails__specrails_rails', input: '{"action":"list"}' },
  { id: 't3', tool: 'Read', input: '{"file_path":"/x"}', output: 'nope', isError: true },
]

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

describe('AgentActivityLogModal', () => {
  it('renders one entry per tool call with input/output previews', () => {
    render(<AgentActivityLogModal tools={TOOLS} streaming={false} onClose={vi.fn()} />)
    expect(screen.getByTestId('agent-activity-log-modal')).toBeTruthy()
    expect(screen.getByText('Terminal')).toBeTruthy() // toolChipLabel(Bash)
    expect(screen.getByText('MCP · rails')).toBeTruthy()
    expect(screen.getByText('{"command":"npm test"}')).toBeTruthy()
    expect(screen.getByText('PASS (6)')).toBeTruthy()
    // Error entry uses the error label
    expect(screen.getByText('Error')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy() // count badge
  })

  it('copy-all writes the whole formatted log to the clipboard and toasts', async () => {
    render(<AgentActivityLogModal tools={TOOLS} streaming={false} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('agent-activity-copy-all'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    const written = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(written).toContain('Bash')
    expect(written).toContain('input: {"command":"npm test"}')
    expect(written).toContain('output: PASS (6)')
    expect(written).toContain('error: nope')
  })

  it('per-entry copy writes only that entry', async () => {
    render(<AgentActivityLogModal tools={TOOLS} streaming={false} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('agent-activity-copy-t2'))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('mcp__specrails__specrails_rails')),
    )
    const written = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(written).not.toContain('npm test')
  })

  it('shows the empty state and live badge', () => {
    render(<AgentActivityLogModal tools={[]} streaming onClose={vi.fn()} />)
    expect(screen.getByText('No tool activity in this turn yet.')).toBeTruthy()
    expect(screen.getByText('Live')).toBeTruthy()
    expect((screen.getByTestId('agent-activity-copy-all') as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes on Escape (Radix) and traps focus inside the panel', async () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button">behind</button>
        <AgentActivityLogModal tools={TOOLS} streaming={false} onClose={onClose} />
      </>,
    )
    const panel = screen.getByRole('dialog')
    expect(panel.getAttribute('data-dialog-layer')).toBe('entity')
    expect(panel.contains(document.activeElement)).toBe(true)
    const user = userEvent.setup()
    for (let i = 0; i < 8; i += 1) {
      await user.tab()
      expect(panel.contains(document.activeElement)).toBe(true)
    }
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the chip that opened it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open log</button>
          {open && <AgentActivityLogModal tools={TOOLS} streaming={false} onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'open log' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})

describe('AgentActivityChip (clickable variant)', () => {
  it('renders a button with the open-log affordance when onClick is provided', () => {
    const onClick = vi.fn()
    render(<AgentActivityChip tool="Bash" onClick={onClick} />)
    const btn = screen.getByTestId('agent-activity-chip')
    expect(btn.tagName).toBe('BUTTON')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('stays a plain div without onClick (BuilderConversation contract)', () => {
    render(<AgentActivityChip tool={null} />)
    expect(screen.queryByTestId('agent-activity-chip')).toBeNull()
    expect(screen.getByText('Thinking…')).toBeTruthy()
  })
})
