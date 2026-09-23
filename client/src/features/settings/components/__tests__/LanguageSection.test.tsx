import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LanguageSection } from '../LanguageSection'
import { LanguageProvider } from '../../context/LanguageContext'
import i18n, { DEFAULT_LANGUAGE, LANGUAGE_IDS } from '../../../../lib/i18n'

afterEach(async () => {
  await i18n.changeLanguage(DEFAULT_LANGUAGE)
  localStorage.clear()
})

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

function renderWithProvider() {
  global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return Promise.resolve(jsonResponse(JSON.parse(String(init.body))))
    }
    return Promise.resolve(jsonResponse({ language: null }))
  }) as unknown as typeof fetch
  return render(
    <LanguageProvider>
      <LanguageSection />
    </LanguageProvider>
  )
}

describe('LanguageSection', () => {
  it('renders one card per supported language with native names', () => {
    renderWithProvider()
    for (const id of LANGUAGE_IDS) {
      expect(screen.getByTestId(`language-card-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByText('Español')).toBeInTheDocument()
    expect(screen.getByText('日本語')).toBeInTheDocument()
    expect(screen.getByText('中文')).toBeInTheDocument()
  })

  it('marks the active language as selected', () => {
    renderWithProvider()
    expect(screen.getByTestId('language-card-en')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('language-card-es')).toHaveAttribute('data-selected', 'false')
  })

  it('clicking a card hot-switches the language and re-renders translated UI', async () => {
    renderWithProvider()
    await userEvent.click(screen.getByTestId('language-card-es'))
    await waitFor(() =>
      expect(screen.getByTestId('language-card-es')).toHaveAttribute('data-selected', 'true')
    )
    expect(i18n.language).toBe('es')
  })

  it('renders nothing without a LanguageProvider (graceful no-op)', () => {
    const { container } = render(<LanguageSection />)
    expect(container.firstChild).toBeNull()
  })
})
