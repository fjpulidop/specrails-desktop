import { describe, expect, it } from 'vitest'
import { initDesktopDb, setDesktopSetting } from '../../../desktop-db'
import { interpolate, normalizeLang, resolveLang, t } from './lang'

describe('language resolution', () => {
  it('normalizes locale tags to the eight app languages', () => {
    expect(normalizeLang('es-ES')).toBe('es')
    expect(normalizeLang('pt_BR')).toBe('pt')
    expect(normalizeLang('zh-Hans')).toBe('zh')
    expect(normalizeLang('JA')).toBe('ja')
    expect(normalizeLang('ko')).toBeNull()
    expect(normalizeLang(3)).toBeNull()
  })

  it('uses the explicit lang, then the session language, then the app UI language, then English', () => {
    const db = initDesktopDb(':memory:')
    expect(resolveLang({ db })).toBe('en')
    setDesktopSetting(db, 'ui_language', 'de')
    expect(resolveLang({ db })).toBe('de')
    const session: { lang?: 'es' | null } = {}
    expect(resolveLang({ explicit: 'es', session, db })).toBe('es')
    expect(session.lang).toBe('es')
    expect(resolveLang({ session, db })).toBe('es')
    expect(resolveLang({ explicit: 'fr', session, db })).toBe('fr')
    expect(session.lang).toBe('es')
    expect(resolveLang({ explicit: 'xx', session, db })).toBe('es')
  })

  it('falls back to English, then to the key, and interpolates {{params}}', () => {
    expect(t('es', 'core.status.running')).toBe('En curso')
    expect(t('es', 'core.hold.budget')).toBe(t('en', 'core.hold.budget'))
    expect(t('en', 'core.nope.missing')).toBe('core.nope.missing')
    expect(t('en', 'core.summary.done', { label: 'specrails_runs(get)' })).toBe('specrails_runs(get) done.')
    expect(interpolate('{{a}} and {{ b }} and {{c}}', { a: 1, b: 'two' })).toBe('1 and two and {{c}}')
  })
})
