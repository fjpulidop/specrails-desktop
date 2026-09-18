import { describe, it, expect, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '../../../../test-utils'
import { TestConnectionButton } from '../TestConnectionButton'

describe('TestConnectionButton', () => {
  it('is disabled without a base URL and reports malformed replies as errors', async () => {
    const user = userEvent.setup()
    const onError = vi.fn(), onResult = vi.fn()
    const { rerender } = render(<TestConnectionButton baseUrl="  " onResult={onResult} onError={onError} />)
    expect(screen.getByRole('button')).toBeDisabled()
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ nope: true }) } as Response)
    rerender(<TestConnectionButton baseUrl="http://x/v1" onResult={onResult} onError={onError} />)
    await user.click(screen.getByRole('button'))
    expect(onError).toHaveBeenCalledWith('Could not test the connection.')
    expect(onResult).not.toHaveBeenCalled()
    // Non-JSON body on a 500 → the i18n fallback message.
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => { throw new Error('bad json') } } as unknown as Response)
    await user.click(screen.getByRole('button'))
    expect(onError).toHaveBeenLastCalledWith('Could not test the connection.')
    // Omits apiKeyEnv when empty and tolerates a missing models array.
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ reachable: true, authState: 'authenticated', latencyMs: 5 }) } as Response)
    await user.click(screen.getByRole('button'))
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ baseUrl: 'http://x/v1' })
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ reachable: true, models: [] }))
  })
})
