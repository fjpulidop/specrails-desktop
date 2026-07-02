import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import { StatusBar } from '../StatusBar'

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../NotificationCenter', () => ({ NotificationCenter: () => null }))

describe('StatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "connected" text when connectionStatus is connected', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="connected" />)
    expect(screen.getByText('connected')).toBeInTheDocument()
  })

  it('shows "reconnecting..." text when connectionStatus is connecting', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="connecting" />)
    expect(screen.getByText('reconnecting...')).toBeInTheDocument()
  })

  it('shows "disconnected" text when connectionStatus is disconnected', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="disconnected" />)
    expect(screen.getByText('disconnected')).toBeInTheDocument()
  })

  it('green indicator is present when connected', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="connected" />)
    const indicator = document.querySelector('.bg-accent-success')
    expect(indicator).toBeInTheDocument()
  })

  it('minimal: hides the connection cluster while healthy and never fetches stats', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="connected" minimal />)
    // Cluster rendered but faded out + aria-hidden ("silence means healthy").
    expect(screen.getByText('connected').parentElement).toHaveAttribute('aria-hidden', 'true')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('minimal: still surfaces a disconnected state', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="disconnected" minimal />)
    expect(screen.getByText('disconnected').parentElement).not.toHaveAttribute('aria-hidden')
  })

  it('minimal: never renders the spend figure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobsToday: 2, costToday: 1, totalCostUsd: 12.34 }),
    })
    render(<StatusBar connectionStatus="connected" minimal />)
    await waitFor(() => expect(screen.queryByText(/\$12\.34/)).not.toBeInTheDocument())
  })

  it('orange indicator is present when connecting', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="connecting" />)
    const indicator = document.querySelector('.bg-accent-warning')
    expect(indicator).toBeInTheDocument()
  })

  it('red indicator is present when disconnected', () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    render(<StatusBar connectionStatus="disconnected" />)
    const indicator = document.querySelector('.bg-destructive')
    expect(indicator).toBeInTheDocument()
  })

  it('fetches and displays stats when available', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobsToday: 5,
        costToday: 0.25,
        totalCostUsd: 1.50,
      }),
    })
    render(<StatusBar connectionStatus="connected" />)

    await waitFor(() => {
      expect(screen.getByText('$1.50')).toBeInTheDocument()
    })
  })

  it('does not show stats when fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error'))
    render(<StatusBar connectionStatus="connected" />)
    // Wait a tick so the fetch can resolve
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it('shows "Connection restored" toast on reconnect', async () => {
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockResolvedValue({ ok: false })
    const { rerender } = render(<StatusBar connectionStatus="connected" />)
    // Simulate disconnect then reconnect
    rerender(<StatusBar connectionStatus="disconnected" />)
    rerender(<StatusBar connectionStatus="connected" />)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Connection restored')
    })
  })

  it('prefixes ~ and marks data-estimated when cost includes an estimate (BUG-27)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobsToday: 3,
        costToday: 0.5,
        totalCostUsd: 1.5,
        estimatedCostToday: 0.3,
        estimatedCostUsd: 0.4,
        includesEstimated: true,
      }),
    })
    render(<StatusBar connectionStatus="connected" />)

    const el = await screen.findByText('~$1.50')
    expect(el).toBeInTheDocument()
    expect(el).toHaveAttribute('data-estimated', 'true')
  })

  it('does NOT prefix ~ on a pure-claude (authoritative) cost (legacy)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobsToday: 3,
        costToday: 0.5,
        totalCostUsd: 1.5,
        // no estimated fields → legacy claude-only path
      }),
    })
    render(<StatusBar connectionStatus="connected" />)

    const el = await screen.findByText('$1.50')
    expect(el).toBeInTheDocument()
    expect(el).not.toHaveAttribute('data-estimated')
    expect(screen.queryByText('~$1.50')).not.toBeInTheDocument()
  })

  it('does not show cost when totalCostUsd is 0', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobsToday: 0,
        costToday: 0,
        totalCostUsd: 0,
      }),
    })
    render(<StatusBar connectionStatus="connected" />)

    // Wait a tick so the fetch can resolve
    await new Promise((r) => setTimeout(r, 50))
    // No dollar amount shown when cost is 0
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })
})
