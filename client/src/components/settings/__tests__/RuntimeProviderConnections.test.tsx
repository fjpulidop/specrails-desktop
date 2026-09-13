import { it, expect, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '../../../test-utils'
import { RuntimeProviderConnections } from '../RuntimeProviderConnections'

it('edits global connections through the app endpoint and retains a rejected draft', async () => {
  const user = userEvent.setup()
  global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }] }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Provider is referenced by a project' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }] }) })
  render(<RuntimeProviderConnections />)
  await screen.findByDisplayValue('claude')
  await user.click(screen.getByRole('button', { name: 'Add local / API provider' }))
  expect(screen.getByLabelText('API base URL')).toHaveValue('http://127.0.0.1:11434/v1')
  await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Provider is referenced')
  expect(screen.getByLabelText('API base URL')).toBeInTheDocument()
  expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/runtime-providers')
})
