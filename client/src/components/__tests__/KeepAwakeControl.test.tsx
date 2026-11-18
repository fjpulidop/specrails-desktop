import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KeepAwakeIndicator, KeepAwakeSwitch, useKeepAwake } from '../KeepAwakeControl'
const fixture = vi.hoisted(() => ({ native: true, awake: false, fail: false }))
vi.mock('../../lib/tauri-shell', () => ({ isTauri: () => fixture.native }))
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

function Harness() {
  const keepAwake = useKeepAwake()
  return <><KeepAwakeIndicator keepAwake={keepAwake} /><KeepAwakeSwitch keepAwake={keepAwake} /></>
}

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
describe('keep awake', () => {
  it('the switch toggles the native sleep assertion both ways; the status bar icon shows only while active', async () => {
    render(<Harness />)
    const toggle = await screen.findByRole('switch', { name: 'Keep computer awake' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByTestId('keep-awake-indicator')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(invoke).toHaveBeenCalledWith('desktop_set_awake', { enabled: true })
    const indicator = screen.getByTestId('keep-awake-indicator')
    fireEvent.click(indicator)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(invoke).toHaveBeenCalledWith('desktop_set_awake', { enabled: false })
    expect(screen.queryByTestId('keep-awake-indicator')).not.toBeInTheDocument()
  })
  it('does not report active if the native assertion fails', async () => {
    fixture.fail = true
    render(<Harness />)
    const toggle = await screen.findByRole('switch', { name: 'Keep computer awake' })
    fireEvent.click(toggle)
    await screen.findByText('Could not change sleep prevention.')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
  it('is absent from browser-only sessions', () => {
    fixture.native = false
    render(<Harness />)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })
})
