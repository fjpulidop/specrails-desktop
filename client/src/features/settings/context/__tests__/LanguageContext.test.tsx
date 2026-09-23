import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LanguageProvider, useLanguage, useLanguageOptional } from '../LanguageContext'
import i18n, { DEFAULT_LANGUAGE, LANGUAGE_LOCAL_STORAGE_KEY } from '../../../../lib/i18n'

afterEach(async () => {
  await i18n.changeLanguage(DEFAULT_LANGUAGE)
  localStorage.clear()
})

function Probe() {
  const { languageId, language, setLanguage, isUpdating } = useLanguage()
  return (
    <div>
      <span data-testid="lang">{languageId}</span>
      <span data-testid="native">{language.nativeName}</span>
      <span data-testid="updating">{String(isUpdating)}</span>
      <button onClick={() => void setLanguage('es').catch(() => {})}>switch-es</button>
    </div>
  )
}

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  let call = 0
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const handler = handlers[Math.min(call, handlers.length - 1)]
    call += 1
    return Promise.resolve(handler(url, init))
  }) as unknown as typeof fetch
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

describe('LanguageProvider', () => {
  it('keeps the boot language when the server has no stored choice (language: null)', async () => {
    mockFetchSequence([() => jsonResponse({ language: null })])
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.getByTestId('lang').textContent).toBe('en')
    // OS-following mode: nothing written to localStorage.
    expect(localStorage.getItem(LANGUAGE_LOCAL_STORAGE_KEY)).toBeNull()
  })

  it('adopts the server-stored explicit choice on mount', async () => {
    mockFetchSequence([() => jsonResponse({ language: 'fr' })])
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    )
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('fr'))
    expect(screen.getByTestId('native').textContent).toBe('Français')
    expect(localStorage.getItem(LANGUAGE_LOCAL_STORAGE_KEY)).toBe('fr')
    expect(i18n.language).toBe('fr')
  })

  it('setLanguage hot-switches optimistically and PATCHes the server', async () => {
    const patchCalls: Array<{ url: string; body: unknown }> = []
    mockFetchSequence([
      () => jsonResponse({ language: null }),
      (url, init) => {
        patchCalls.push({ url, body: JSON.parse(String(init?.body)) })
        return jsonResponse({ language: 'es' })
      },
    ])
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await userEvent.click(screen.getByText('switch-es'))
    await waitFor(() => expect(screen.getByTestId('lang').textContent).toBe('es'))
    expect(i18n.language).toBe('es')
    expect(localStorage.getItem(LANGUAGE_LOCAL_STORAGE_KEY)).toBe('es')
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].url).toBe('/api/language')
    expect(patchCalls[0].body).toEqual({ language: 'es' })
  })

  it('reverts everywhere when the server rejects the switch', async () => {
    mockFetchSequence([
      () => jsonResponse({ language: null }),
      () => jsonResponse({ error: 'invalid_language' }, false, 400),
    ])
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await userEvent.click(screen.getByText('switch-es'))
    await waitFor(() => expect(screen.getByTestId('updating').textContent).toBe('false'))
    expect(screen.getByTestId('lang').textContent).toBe('en')
    expect(i18n.language).toBe('en')
    // No stored choice before the failed switch → still following the OS.
    expect(localStorage.getItem(LANGUAGE_LOCAL_STORAGE_KEY)).toBeNull()
  })

  it('survives an unreachable server (keeps boot value)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    )
    await act(async () => {})
    expect(screen.getByTestId('lang').textContent).toBe('en')
  })

  it('setLanguage is a no-op when picking the active language', async () => {
    mockFetchSequence([() => jsonResponse({ language: null })])
    function NoopProbe() {
      const { setLanguage, languageId } = useLanguage()
      return <button onClick={() => void setLanguage('en')}>{languageId}</button>
    }
    render(
      <LanguageProvider>
        <NoopProbe />
      </LanguageProvider>
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('en'))
    // Only the reconcile GET — no PATCH fired.
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('useLanguage / useLanguageOptional', () => {
  it('useLanguage throws outside a provider', () => {
    function Bare() {
      useLanguage()
      return null
    }
    expect(() => render(<Bare />)).toThrow(/within a LanguageProvider/)
  })

  it('useLanguageOptional returns null outside a provider', () => {
    let value: unknown = 'sentinel'
    function Bare() {
      value = useLanguageOptional()
      return null
    }
    render(<Bare />)
    expect(value).toBeNull()
  })
})
