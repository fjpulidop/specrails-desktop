import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KeepAwakeIndicator, KeepAwakeSwitch, requestKeepAwakeToggle, useKeepAwake } from '../KeepAwakeControl'
import { PALETTE_ACTIONS } from '../command-palette/palette-actions'
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
  it('turns on from the command palette even when no switch is on screen (nothing running)', async () => {
    function IndicatorOnly() { const keepAwake = useKeepAwake(); return <KeepAwakeIndicator keepAwake={keepAwake} /> }
    render(<IndicatorOnly />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_system_status'))
    const action = PALETTE_ACTIONS.find((candidate) => candidate.id === 'keepAwake.toggle')!
    expect(action.when({} as never)).toBe(true)
    action.run({} as never)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop_set_awake', { enabled: true }))
    expect(await screen.findByTestId('keep-awake-indicator')).toBeInTheDocument()
    requestKeepAwakeToggle()
    await waitFor(() => expect(screen.queryByTestId('keep-awake-indicator')).not.toBeInTheDocument())
  })

  it('offers the palette action only in the desktop app', () => {
    fixture.native = false
    expect(PALETTE_ACTIONS.find((candidate) => candidate.id === 'keepAwake.toggle')!.when({} as never)).toBe(false)
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
