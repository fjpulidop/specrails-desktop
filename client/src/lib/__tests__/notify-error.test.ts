import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ error: vi.fn(() => 'toast-id') }))
vi.mock('sonner', () => ({ toast: { error: h.error } }))

import i18n from 'i18next'
import { humanDetail, notifyError } from '../notify-error'

const lastOptions = () => (h.error.mock.calls.at(-1) as unknown as [string, Record<string, unknown>])[1]

describe('humanDetail', () => {
  afterEach(() => { void i18n.changeLanguage('en') })

  it('drops empty text and bare status codes', () => {
    expect(humanDetail(undefined)).toBeUndefined()
    expect(humanDetail('   ')).toBeUndefined()
    expect(humanDetail('HTTP 409')).toBeUndefined()
    expect(humanDetail('Error: HTTP 500')).toBeUndefined()
    expect(humanDetail('502')).toBeUndefined()
    expect(humanDetail('spawn_failed')).toBeUndefined()
    expect(humanDetail('rail_ticket_cap_exceeded')).toBeUndefined()
  })

  it('keeps text that is already in the app language', () => {
    expect(humanDetail('The branch is behind its remote.')).toBe('The branch is behind its remote.')
  })

  it('hides server English when the app is in another language', async () => {
    await i18n.changeLanguage('es')
    expect(humanDetail('Unable to push: remote rejected the update')).toBeUndefined()
    expect(humanDetail('No se pudo empujar la rama')).toBe('No se pudo empujar la rama')
  })
})

describe('notifyError', () => {
  beforeEach(() => { h.error.mockClear(); void i18n.changeLanguage('en') })

  it('turns retry into the toast action and never uses the detail as the headline', () => {
    const retry = vi.fn()
    notifyError('Could not launch the rail', { detail: 'something odd', retry })
    expect(h.error).toHaveBeenCalledWith('Could not launch the rail', expect.objectContaining({ description: 'something odd' }))
    const action = lastOptions().action as { label: string; onClick: () => void }
    expect(action.label).toBe('Retry')
    action.onClick()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('omits the description for an HTTP status headline and keeps a custom action', () => {
    const onClick = vi.fn()
    notifyError('Launch failed', { detail: 'HTTP 409', action: { label: 'Raise limit', onClick } })
    const opts = lastOptions()
    expect(opts.description).toBeUndefined()
    expect((opts.action as { label: string }).label).toBe('Raise limit')
  })

  it('prefers retry over a custom action', () => {
    notifyError('x', { retry: vi.fn(), action: { label: 'Other', onClick: vi.fn() } })
    expect((lastOptions().action as { label: string }).label).toBe('Retry')
  })

  it('keeps untranslatable server text reachable as a tooltip, not as visible copy', async () => {
    await i18n.changeLanguage('es')
    notifyError('No se pudo lanzar', { detail: 'Unable to start: the repository is locked' })
    const description = lastOptions().description as { props: { title: string } }
    expect(description.props.title).toBe('Unable to start: the repository is locked')
  })
})
