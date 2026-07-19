import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '../../../test-utils'
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

    render(<RailProfileSelector provider="kimi" value={null} onChange={vi.fn()} />)
    expect(await screen.findByRole('option', { name: 'kimi-default' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'claude-default' })).not.toBeInTheDocument()
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
})
