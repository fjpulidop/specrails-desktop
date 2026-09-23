import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { MissionWindowsProvider, useMissionWindows } from '../MissionWindowsContext'
import type { MissionWindowBridge } from '../../lib/mission-windows'

function Consumer() {
  const windows = useMissionWindows()
  return <div>{windows.initialized ? (windows.isEditable('c1') ? 'editable' : 'frozen') : 'initializing'}<span>{windows.available ? 'native' : 'browser'}</span></div>
}
describe('MissionWindowsProvider', () => {
  it('keeps existing browser-only consumers usable without an outer provider', () => {
    render(<Consumer />)
    expect(screen.getByText('editable')).toBeInTheDocument()
  })
  it('hydrates native ownership and removes its listener on unmount under StrictMode', async () => {
    const unlisten = vi.fn()
    const bridge: MissionWindowBridge = {
      supported: vi.fn(async () => true), list: vi.fn(async () => []), current: vi.fn(async () => null),
      detach: vi.fn(), ready: vi.fn(), attach: vi.fn(), ack: vi.fn(), cancel: vi.fn(), focus: vi.fn(), discard: vi.fn(),
      listen: vi.fn(async () => unlisten),
    }
    const view = render(<StrictMode><MissionWindowsProvider bridge={bridge}><Consumer /></MissionWindowsProvider></StrictMode>)
    await waitFor(() => expect(screen.getByText('native')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('editable')).toBeInTheDocument())
    expect(bridge.listen).toHaveBeenCalledTimes(1)
    act(() => view.unmount())
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
