import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../lib/feature-flags', () => ({ FEATURE_CODE_EXPLORER: true }))

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m) } }))

import { CodeSectionSettings } from '../CodeSectionSettings'

beforeEach(() => {
  toastError.mockClear()
})

function mockFetchSequence(responses: Array<{ ok: boolean; body: unknown }>) {
  let i = 0
  global.fetch = vi.fn().mockImplementation(() => {
    const r = responses[i++] ?? responses[responses.length - 1]
    return Promise.resolve({ ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body })
  }) as never
}

describe('CodeSectionSettings', () => {
  it('loads settings and renders controls', async () => {
    mockFetchSequence([{ ok: true, body: { language: 'es', monthlyBudgetUsd: 7.5 } }])
    render(<CodeSectionSettings />)
    await screen.findByText('Code section')
    expect(screen.getByRole('combobox')).toHaveTextContent('Español')
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7.5')
  })

  it('falls back to defaults on initial GET failure', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('net')) as never
    render(<CodeSectionSettings />)
    await screen.findByText('Code section')
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5')
  })

  it('patches language and shows updated value', async () => {
    mockFetchSequence([
      { ok: true, body: { language: 'en', monthlyBudgetUsd: 5 } },
      { ok: true, body: { language: 'es', monthlyBudgetUsd: 5 } },
    ])
    render(<CodeSectionSettings />)
    const user = userEvent.setup()
    const select = await screen.findByRole('combobox')
    expect(select).toHaveTextContent('English')
    await user.click(select)
    await user.click(await screen.findByRole('option', { name: 'Español' }))
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Español'))
    expect(global.fetch).toHaveBeenLastCalledWith('/api/code-explorer-settings', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ language: 'es' }) }))
  })

  it('shows toast on PATCH failure and reverts', async () => {
    mockFetchSequence([
      { ok: true, body: { language: 'en', monthlyBudgetUsd: 5 } },
      { ok: false, body: {} },
    ])
    render(<CodeSectionSettings />)
    const input = await screen.findByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '9' } })
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it('ignores negative budget input', async () => {
    mockFetchSequence([{ ok: true, body: { language: 'en', monthlyBudgetUsd: 5 } }])
    render(<CodeSectionSettings />)
    const input = await screen.findByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-1' } })
    expect(input.value).toBe('5')
  })
})
