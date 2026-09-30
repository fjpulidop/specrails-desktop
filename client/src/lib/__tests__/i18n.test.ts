import { describe, it, expect, afterEach, vi } from 'vitest'
import i18n, {
  LANGUAGE_IDS,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  LANGUAGE_LOCAL_STORAGE_KEY,
  NAMESPACES,
  isLanguageId,
  detectSystemLanguage,
  readBootLanguage,
  getActiveLanguage,
  getDateFnsLocale,
  setLanguage,
  loadLanguage,
  initI18n,
} from '../i18n'

afterEach(async () => {
  // Reset the singleton back to English so test order doesn't matter.
  await i18n.changeLanguage(DEFAULT_LANGUAGE)
  localStorage.clear()
})

function mockNavigatorLanguages(languages: string[]): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    languages,
    language: languages[0] ?? '',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('language registry', () => {
  it('exposes the 8 supported languages', () => {
    expect(LANGUAGE_IDS).toEqual(['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'])
  })

  it('has a descriptor with native + english names for every id', () => {
    for (const id of LANGUAGE_IDS) {
      expect(LANGUAGES[id].id).toBe(id)
      expect(LANGUAGES[id].nativeName.length).toBeGreaterThan(0)
      expect(LANGUAGES[id].englishName.length).toBeGreaterThan(0)
    }
  })

  it('isLanguageId accepts supported ids and rejects everything else', () => {
    expect(isLanguageId('es')).toBe(true)
    expect(isLanguageId('en')).toBe(true)
    expect(isLanguageId('es-ES')).toBe(false)
    expect(isLanguageId('nl')).toBe(false)
    expect(isLanguageId(42)).toBe(false)
    expect(isLanguageId(null)).toBe(false)
  })

  it('derives namespaces from locales/en — common is always present', () => {
    expect(NAMESPACES).toContain('common')
    expect(NAMESPACES).toContain('settings')
  })
})

describe('detectSystemLanguage', () => {
  it('matches the base subtag of the first supported browser language', () => {
    mockNavigatorLanguages(['es-ES', 'en-US'])
    expect(detectSystemLanguage()).toBe('es')
  })

  it('normalizes multi-part tags (zh-Hans-CN → zh)', () => {
    mockNavigatorLanguages(['zh-Hans-CN'])
    expect(detectSystemLanguage()).toBe('zh')
  })

  it('skips unsupported languages and picks the next supported one', () => {
    mockNavigatorLanguages(['nl-NL', 'pt-BR'])
    expect(detectSystemLanguage()).toBe('pt')
  })

  it('falls back to English when nothing matches', () => {
    mockNavigatorLanguages(['nl-NL', 'sv-SE'])
    expect(detectSystemLanguage()).toBe(DEFAULT_LANGUAGE)
  })
})

describe('readBootLanguage', () => {
  it('prefers the explicit stored choice over the OS language', () => {
    mockNavigatorLanguages(['fr-FR'])
    localStorage.setItem(LANGUAGE_LOCAL_STORAGE_KEY, 'ja')
    expect(readBootLanguage()).toBe('ja')
  })

  it('falls back to OS detection when nothing is stored (first run)', () => {
    mockNavigatorLanguages(['de-DE'])
    expect(readBootLanguage()).toBe('de')
  })

  it('ignores a corrupt stored value', () => {
    mockNavigatorLanguages(['it-IT'])
    localStorage.setItem(LANGUAGE_LOCAL_STORAGE_KEY, 'bogus')
    expect(readBootLanguage()).toBe('it')
  })
})

describe('runtime switching', () => {
  it('starts in English and translates from the common namespace', () => {
    expect(getActiveLanguage()).toBe('en')
    expect(i18n.t('common:actions.save')).toBe('Save')
  })

  it('setLanguage hot-switches the active language and <html lang>', async () => {
    await setLanguage('es')
    expect(getActiveLanguage()).toBe('es')
    expect(i18n.language).toBe('es')
    expect(document.documentElement.lang).toBe('es')
  })

  it('loadLanguage is idempotent', async () => {
    await loadLanguage('fr')
    await expect(loadLanguage('fr')).resolves.toBeUndefined()
  })

  it('initI18n applies the persisted language before first render', async () => {
    localStorage.setItem(LANGUAGE_LOCAL_STORAGE_KEY, 'it')
    await initI18n()
    expect(getActiveLanguage()).toBe('it')
  })

  it('initI18n stays in English when nothing is persisted and OS is English', async () => {
    mockNavigatorLanguages(['en-US'])
    await initI18n()
    expect(getActiveLanguage()).toBe('en')
  })
})

describe('getDateFnsLocale', () => {
  it('maps every supported language to a date-fns locale', () => {
    for (const id of LANGUAGE_IDS) {
      expect(getDateFnsLocale(id)).toBeTruthy()
    }
  })

  it('uses the active language when no argument is given', async () => {
    await setLanguage('de')
    expect(getDateFnsLocale().code).toMatch(/^de/)
  })

  it('falls back to English for unknown tags', () => {
    expect(getDateFnsLocale('xx').code).toMatch(/^en/)
  })
})

it('provides twenty distinct, resolved mission welcomes in every language', async () => {
  for (const language of LANGUAGE_IDS) {
    await loadLanguage(language)
    const phrases = Object.values(i18n.getResource(language, 'agent', 'missionPlaceholders') as Record<string, string>)
    expect(phrases).toHaveLength(20)
    expect(new Set(phrases).size).toBe(20)
    phrases.forEach((phrase, index) => {
      expect(i18n.t(`missionPlaceholders.${index}`, { ns: 'agent', lng: language })).toBe(phrase)
    })
  }
})
