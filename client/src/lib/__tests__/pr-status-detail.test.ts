import { afterEach, describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { localizeStatusDetail } from '../pr-status-detail'

describe('localizeStatusDetail', () => {
  afterEach(async () => { await i18n.changeLanguage('en') })

  it('shows the server text in English and keeps nothing hidden', () => {
    expect(localizeStatusDetail('fatal: unable to push', 'Generic')).toEqual({ text: 'fatal: unable to push', raw: null })
  })

  it('swaps English server text for the localized line in another language, keeping the original', async () => {
    await i18n.changeLanguage('es')
    expect(localizeStatusDetail('remote: the push was rejected because it is not a fast-forward', 'La entrega se detuvo.'))
      .toEqual({ text: 'La entrega se detuvo.', raw: 'remote: the push was rejected because it is not a fast-forward' })
  })

  it('treats a machine code as unreadable and an empty detail as nothing', () => {
    expect(localizeStatusDetail('delivery_failed', 'Generic')).toEqual({ text: 'Generic', raw: 'delivery_failed' })
    expect(localizeStatusDetail('  ', 'Generic')).toBeNull()
    expect(localizeStatusDetail(null, 'Generic')).toBeNull()
  })
})
