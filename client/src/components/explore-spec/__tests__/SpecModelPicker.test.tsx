import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import { SpecModelPicker, useDefaultSpecModel } from '../SpecModelPicker'
import { renderHook } from '@testing-library/react'

describe('SpecModelPicker', () => {
  it('renders the loading state when loading=true', () => {
    render(
      <SpecModelPicker value={null} allowed={[]} loading={true} onChange={() => {}} />,
    )
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('renders the selected model label when not loading', () => {
    render(
      <SpecModelPicker
        value="opus"
        allowed={[
          { value: 'sonnet', label: 'Claude Sonnet' },
          { value: 'opus', label: 'Claude Opus' },
        ]}
        loading={false}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('Claude Opus')).toBeInTheDocument()
  })

  it('disables the trigger while the allow-list is empty', () => {
    render(
      <SpecModelPicker value={null} allowed={[]} loading={false} onChange={() => {}} />,
    )
    expect(screen.getByTestId('spec-model-picker')).toBeDisabled()
  })

  it('accepts a safe custom alias exactly when the provider advertises it', () => {
    const onChange = vi.fn()
    render(
      <SpecModelPicker
        value="moonshot-team/private-coder:v1"
        allowed={[{ value: 'k3', label: 'Kimi K3' }]}
        customModelAliases
        loading={false}
        onChange={onChange}
      />,
    )
    const input = screen.getByTestId('spec-model-picker')
    fireEvent.change(input, { target: { value: 'Moonshot-Team/Private_Coder:v2' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('Moonshot-Team/Private_Coder:v2')
  })
})

describe('useDefaultSpecModel', () => {
  it('fetches and exposes the resolved default + allowed list', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: 'opus',
        provider: 'claude',
        allowed: [
          { value: 'sonnet', label: 'Claude Sonnet' },
          { value: 'opus', label: 'Claude Opus' },
        ],
        customModelAliases: false,
      }),
    })
    const { result } = renderHook(() => useDefaultSpecModel('proj-1', true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.model).toBe('opus')
    expect(result.current.provider).toBe('claude')
    expect(result.current.allowed).toHaveLength(2)
    expect(result.current.customModelAliases).toBe(false)
  })

  it('falls back to a safe local list when the endpoint fails', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    })
    const { result } = renderHook(() => useDefaultSpecModel('proj-1', true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeTruthy()
    expect(result.current.model).toBe('sonnet')
    expect(result.current.allowed.length).toBeGreaterThan(0)
  })

  it('preserves the exact server-resolved Kimi alias and editable capability', async () => {
    const alias = 'Moonshot-Team/Private_Coder:v2'
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: alias,
        provider: 'kimi',
        allowed: [{ value: 'k3', label: 'Kimi K3' }],
        customModelAliases: true,
        providers: ['kimi'],
      }),
    })
    const { result } = renderHook(() => useDefaultSpecModel('proj-1', true, 'kimi'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.model).toBe(alias)
    expect(result.current.customModelAliases).toBe(true)
  })

  it('preserves Kimi and falls back to K3 when the endpoint fails', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    })
    const { result } = renderHook(() => useDefaultSpecModel('proj-1', true, 'kimi'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeTruthy()
    expect(result.current.provider).toBe('kimi')
    expect(result.current.providers).toEqual(['kimi'])
    expect(result.current.model).toBe('k3')
    expect(result.current.allowed.map((model) => model.value)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
    expect(result.current.customModelAliases).toBe(true)
  })

  it('fails closed for an unknown provider instead of showing Claude models', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    })
    const { result } = renderHook(() => useDefaultSpecModel('proj-1', true, 'future-provider'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.provider).toBe('future-provider')
    expect(result.current.providers).toEqual(['future-provider'])
    expect(result.current.model).toBeNull()
    expect(result.current.allowed).toEqual([])
  })

  it('does nothing while disabled', () => {
    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>
    fetchSpy.mockClear()
    renderHook(() => useDefaultSpecModel('proj-1', false))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
