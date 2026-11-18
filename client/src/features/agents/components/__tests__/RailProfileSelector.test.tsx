import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../../test-utils'
import { RailProfileSelector } from '../RailProfileSelector'

describe('RailProfileSelector', () => {
  beforeEach(() => {
    vi.mocked(global.fetch).mockReset()
  })

  it('requests and offers only profiles compatible with the Kimi rail', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: [
          { name: 'claude-default', provider: 'claude', isDefault: true, updatedAt: 1 },
          { name: 'kimi-default', provider: 'kimi', isDefault: true, updatedAt: 2 },
        ],
      }),
    } as Response)

    const onChange = vi.fn()
    render(<RailProfileSelector provider="kimi" value={null} onChange={onChange} />)
    const trigger = await screen.findByRole('combobox', { name: 'Agent profile for this rail' })
    // null = legacy: the trigger shows the "no profile" entry.
    expect(trigger).toHaveTextContent('No profile')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(screen.getByRole('option', { name: 'kimi-default' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'claude-default' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'kimi-default' }))
    expect(onChange).toHaveBeenCalledWith('kimi-default')
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toContain('provider=kimi')
  })

  it('clears an incompatible profile after an engine switch', async () => {
    const onChange = vi.fn()
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        profiles: [
          { name: 'kimi-default', provider: 'kimi', isDefault: true, updatedAt: 2 },
        ],
      }),
    } as Response)
    render(<RailProfileSelector provider="kimi" value="claude-default" onChange={onChange} />)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
  })

  it('maps the "no profile" entry back to null', async () => {
    const onChange = vi.fn()
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [{ name: 'kimi-default', provider: 'kimi', isDefault: true, updatedAt: 2 }] }),
    } as Response)
    render(<RailProfileSelector provider="kimi" value="kimi-default" onChange={onChange} />)
    const trigger = await screen.findByRole('combobox', { name: 'Agent profile for this rail' })
    expect(trigger).toHaveTextContent('kimi-default')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(screen.getByRole('option', { name: 'No profile' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
