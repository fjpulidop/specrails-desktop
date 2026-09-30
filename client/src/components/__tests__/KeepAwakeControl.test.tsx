import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KeepAwakeControl } from '../KeepAwakeControl'
const fixture = vi.hoisted(() => ({ native: true, awake: false, fail: false }))
vi.mock('../../lib/tauri-shell', () => ({ isTauri: () => fixture.native }))
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
beforeEach(() => {
  fixture.native = true; fixture.awake = false; fixture.fail = false
  invoke.mockReset().mockImplementation(async (command: string, args?: { enabled: boolean }) => {
    if (command === 'desktop_set_awake') {
      if (fixture.fail) throw new Error('unavailable')
      fixture.awake = !!args?.enabled
    }
    return { supported: true, awake: fixture.awake }
  })
})
describe('keep awake footer control', () => {
  it('starts off and toggles the native sleep assertion both ways', async () => {
    render(<KeepAwakeControl />)
    const button = await screen.findByRole('button', { name: 'Keep computer awake' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
    expect(invoke).toHaveBeenCalledWith('desktop_set_awake', { enabled: true })
    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'))
    expect(invoke).toHaveBeenCalledWith('desktop_set_awake', { enabled: false })
  })
  it('does not report active if the native assertion fails', async () => {
    fixture.fail = true
    render(<KeepAwakeControl />)
    const button = await screen.findByRole('button', { name: 'Keep computer awake' })
    fireEvent.click(button)
    await screen.findByRole('status')
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })
  it('is absent from browser-only sessions', () => {
    fixture.native = false
    render(<KeepAwakeControl />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })
})
