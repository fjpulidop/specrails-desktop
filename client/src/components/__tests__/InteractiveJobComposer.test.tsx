import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { InteractiveJobComposer } from '../InteractiveJobComposer'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))

// Controllable shared-WS mock: tests push job.turn_* / job.finalized /
// job.interactive frames straight into the composer's registered handler.
const { wsHandlers } = vi.hoisted(() => ({
  wsHandlers: new Map<string, (msg: unknown) => void>(),
}))
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (msg: unknown) => void) => { wsHandlers.set(id, fn) },
    unregisterHandler: (id: string) => { wsHandlers.delete(id) },
    connectionStatus: 'connected',
  }),
}))

import { toast } from 'sonner'

function pushWs(msg: Record<string, unknown>): void {
  act(() => {
    for (const fn of wsHandlers.values()) fn(msg)
  })
}

const TOTALS = {
  tokens_in: 100,
  tokens_out: 200,
  tokens_cache_read: 0,
  tokens_cache_create: 0,
  total_cost_usd: 0.1234,
  num_turns: 3,
}

describe('InteractiveJobComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsHandlers.clear()
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  })

  describe('settle-mode matrix', () => {
    it("'finalize' keeps today's Finalize button (no auto hint, no wrap-up)", () => {
      render(<InteractiveJobComposer jobId="j1" settleMode="finalize" />)
      expect(screen.getByText('Finalize Job')).toBeInTheDocument()
      expect(screen.queryByText('Wrap up now')).not.toBeInTheDocument()
      expect(screen.queryByText(/finishes on its own/i)).not.toBeInTheDocument()
    })

    it("absent settleMode falls back to 'finalize' (legacy payloads)", () => {
      render(<InteractiveJobComposer jobId="j1" />)
      expect(screen.getByText('Finalize Job')).toBeInTheDocument()
    })

    it("'auto' shows the quiet hint + 'Wrap up now' secondary, NOT Finalize", () => {
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      expect(screen.queryByText('Finalize Job')).not.toBeInTheDocument()
      expect(screen.getByText(/finishes on its own/i)).toBeInTheDocument()
      expect(screen.getByText('Wrap up now')).toBeInTheDocument()
    })

    it("'auto' + loop-step relabels wrap-up to settling the current step", () => {
      render(<InteractiveJobComposer jobId="run-1" settleMode="auto" kind="loop-step" />)
      expect(screen.getByText('Settle this step')).toBeInTheDocument()
      expect(screen.queryByText('Wrap up now')).not.toBeInTheDocument()
    })
  })

  describe('send flow', () => {
    it('POSTs to /jobs/:id/messages and clears the textarea on 202', async () => {
      const user = userEvent.setup()
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      const textarea = screen.getByPlaceholderText(/Send a message to the running job/i)
      await user.type(textarea, 'add error handling')
      await user.click(screen.getByRole('button', { name: /Send/i }))
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/jobs/j1/messages',
          expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'add error handling' }) }),
        )
      })
      await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(''))
    })

    it('Cmd/Ctrl+Enter sends', async () => {
      const user = userEvent.setup()
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      const textarea = screen.getByPlaceholderText(/Send a message to the running job/i)
      await user.type(textarea, 'steer{Meta>}{Enter}{/Meta}')
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/jobs/j1/messages', expect.objectContaining({ method: 'POST' }))
      })
    })

    it('Send is disabled while the textarea is empty', () => {
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      expect(screen.getByRole('button', { name: /Send/i })).toBeDisabled()
    })
  })

  describe('live turn state (WS)', () => {
    it('job.turn_user flips the pill to working; queued turns show the indicator', () => {
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      expect(screen.getByText('Ready — send a prompt')).toBeInTheDocument()

      pushWs({ type: 'job.turn_user', jobId: 'j1', text: 'go', queued: false })
      expect(screen.getAllByText('Agent working…').length).toBeGreaterThan(0)
      expect(screen.queryByText(/queued message/)).not.toBeInTheDocument()

      pushWs({ type: 'job.turn_user', jobId: 'j1', text: 'more', queued: true })
      expect(screen.getByText('1 queued message')).toBeInTheDocument()
    })

    it('job.turn_done updates the live totals line and consumes one queued turn', () => {
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      pushWs({ type: 'job.turn_user', jobId: 'j1', text: 'go', queued: false })
      pushWs({ type: 'job.turn_user', jobId: 'j1', text: 'more', queued: true })

      pushWs({ type: 'job.turn_done', jobId: 'j1', totals: TOTALS })
      // 3 turns · $0.1234
      expect(screen.getByText(/3 turns/)).toBeInTheDocument()
      expect(screen.getByText(/\$0\.1234/)).toBeInTheDocument()
      // The queued prompt began streaming — indicator gone, still working.
      expect(screen.queryByText(/queued message/)).not.toBeInTheDocument()
      expect(screen.getAllByText('Agent working…').length).toBeGreaterThan(0)

      // Second turn done with nothing queued → back to ready.
      pushWs({ type: 'job.turn_done', jobId: 'j1', totals: { ...TOTALS, num_turns: 4 } })
      expect(screen.getByText('Ready — send a prompt')).toBeInTheDocument()
    })

    it('ignores frames for other jobs', () => {
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      pushWs({ type: 'job.turn_user', jobId: 'OTHER', text: 'go', queued: false })
      expect(screen.getByText('Ready — send a prompt')).toBeInTheDocument()
    })

    it('job.finalized stops the session and fires onFinalized', () => {
      const onFinalized = vi.fn()
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" onFinalized={onFinalized} />)
      pushWs({ type: 'job.turn_user', jobId: 'j1', text: 'go', queued: false })
      pushWs({ type: 'job.finalized', jobId: 'j1', status: 'completed', totals: TOTALS })
      expect(onFinalized).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/3 turns/)).toBeInTheDocument()
    })
  })

  describe('loop between-steps (409 + job.interactive)', () => {
    it('mounts in the gentle waiting state when initialAcceptingTurns=false', () => {
      render(
        <InteractiveJobComposer jobId="run-1" settleMode="auto" kind="loop-step" initialAcceptingTurns={false} />,
      )
      expect(screen.getAllByText('Waiting for the next step…').length).toBeGreaterThan(0)
      expect(screen.getByText(/deciding what runs next/i)).toBeInTheDocument()
      expect(screen.getByRole('textbox')).toBeDisabled()
    })

    it('a 409 on send flips to waiting WITHOUT an error toast and keeps the draft', async () => {
      const user = userEvent.setup()
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'no session' }) })
      render(<InteractiveJobComposer jobId="run-1" settleMode="auto" kind="loop-step" />)
      const textarea = screen.getByRole('textbox')
      await user.type(textarea, 'steer the step')
      await user.click(screen.getByRole('button', { name: /Send/i }))
      await waitFor(() => {
        expect(screen.getAllByText('Waiting for the next step…').length).toBeGreaterThan(0)
      })
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
      expect((textarea as HTMLTextAreaElement).value).toBe('steer the step')
    })

    it('a plain job 409 still surfaces the error toast (no waiting state)', async () => {
      const user = userEvent.setup()
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'no session' }) })
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" kind="job" />)
      await user.type(screen.getByRole('textbox'), 'hello')
      await user.click(screen.getByRole('button', { name: /Send/i }))
      await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled())
      expect(screen.queryByText('Waiting for the next step…')).not.toBeInTheDocument()
    })

    it('job.interactive acceptingTurns:true re-enables the composer', () => {
      render(
        <InteractiveJobComposer jobId="run-1" settleMode="auto" kind="loop-step" initialAcceptingTurns={false} />,
      )
      expect(screen.getByRole('textbox')).toBeDisabled()
      pushWs({ type: 'job.interactive', jobId: 'run-1', acceptingTurns: true, settleMode: 'auto' })
      expect(screen.getByRole('textbox')).toBeEnabled()
      expect(screen.queryByText(/deciding what runs next/i)).not.toBeInTheDocument()
    })

    it('job.interactive acceptingTurns:false parks the composer between steps', () => {
      render(<InteractiveJobComposer jobId="run-1" settleMode="auto" kind="loop-step" />)
      pushWs({ type: 'job.interactive', jobId: 'run-1', acceptingTurns: false, settleMode: 'auto' })
      expect(screen.getByRole('textbox')).toBeDisabled()
      expect(screen.getAllByText('Waiting for the next step…').length).toBeGreaterThan(0)
    })
  })

  describe('settle actions', () => {
    it('Finalize Job POSTs /finalize and shows the finalize toast', async () => {
      const user = userEvent.setup()
      render(<InteractiveJobComposer jobId="j1" settleMode="finalize" />)
      await user.click(screen.getByText('Finalize Job'))
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/jobs/j1/finalize', expect.objectContaining({ method: 'POST' }))
      })
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Finalizing interactive job…')
    })

    it('Wrap up now POSTs /finalize with the wrap-up toast', async () => {
      const user = userEvent.setup()
      render(<InteractiveJobComposer jobId="j1" settleMode="auto" />)
      await user.click(screen.getByText('Wrap up now'))
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/jobs/j1/finalize', expect.objectContaining({ method: 'POST' }))
      })
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Wrapping up the job…')
    })

    it('Settle this step POSTs /finalize with the step toast', async () => {
      const user = userEvent.setup()
      render(<InteractiveJobComposer jobId="run-1" settleMode="auto" kind="loop-step" />)
      await user.click(screen.getByText('Settle this step'))
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/jobs/run-1/finalize', expect.objectContaining({ method: 'POST' }))
      })
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Settling the step — the loop advances with what it produced')
    })

    it('a failed finalize surfaces the error toast and re-enables the action', async () => {
      const user = userEvent.setup()
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      render(<InteractiveJobComposer jobId="j1" settleMode="finalize" />)
      await user.click(screen.getByText('Finalize Job'))
      await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled())
      expect(screen.getByText('Finalize Job')).toBeInTheDocument()
    })
  })
})
