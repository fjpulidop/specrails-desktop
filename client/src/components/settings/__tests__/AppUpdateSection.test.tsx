import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../test-utils'
import { AppUpdateSection } from '../AppUpdateSection'

const mockCheck = vi.fn()
vi.mock('@tauri-apps/plugin-updater', () => ({ check: (...a: unknown[]) => mockCheck(...a) }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '2.18.2') }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))

import { toast } from 'sonner'

function setTauriRuntime(on: boolean) {
  const w = window as unknown as Record<string, unknown>
  if (on) w.__TAURI_INTERNALS__ = {}
  else delete w.__TAURI_INTERNALS__
}

beforeEach(() => {
  vi.clearAllMocks()
  setTauriRuntime(true)
})

describe('AppUpdateSection', () => {
  it('renders the heading, installed version and check button', async () => {
    render(<AppUpdateSection />)
    expect(screen.getByText('Specrails Desktop')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Check for updates/i })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('2.18.2')).toBeInTheDocument())
  })

  it('up-to-date: shows the confirmation line and success toast', async () => {
    mockCheck.mockResolvedValue(null)
    render(<AppUpdateSection />)
    fireEvent.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => expect(screen.getByText("You're on the latest version")).toBeInTheDocument())
    expect(toast.success).toHaveBeenCalled()
  })

  it('update available: surfaces the standard update card via toast.custom', async () => {
    mockCheck.mockResolvedValue({
      currentVersion: '2.18.2',
      version: '2.19.0',
      downloadAndInstall: vi.fn(),
    })
    render(<AppUpdateSection />)
    fireEvent.click(screen.getByRole('button', { name: /Check for updates/i }))
    await waitFor(() => expect(screen.getByText('Update available: 2.19.0')).toBeInTheDocument())
    expect(toast.custom).toHaveBeenCalled()
  })

  it('check failure: error toast, button re-enabled', async () => {
    mockCheck.mockRejectedValue(new Error('network down'))
    render(<AppUpdateSection />)
    const btn = screen.getByRole('button', { name: /Check for updates/i })
    fireEvent.click(btn)
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(btn).not.toBeDisabled()
  })

  it('outside the desktop app: renders the unavailable note instead of the button', () => {
    setTauriRuntime(false)
    render(<AppUpdateSection />)
    expect(screen.getByText(/only available in the desktop app/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Check for updates/i })).not.toBeInTheDocument()
  })
})
