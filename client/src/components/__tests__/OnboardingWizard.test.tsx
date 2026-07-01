import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { render } from '../../test-utils'
import { OnboardingWizard, hasSeenOnboarding, resetOnboarding } from '../OnboardingWizard'
import { ThemeProvider } from '../../context/ThemeContext'
import { LanguageProvider } from '../../context/LanguageContext'
import i18n, { DEFAULT_LANGUAGE } from '../../lib/i18n'
import { COMPANION_WEB_URL } from '../../lib/companion'

const STEP_TITLES = [
  'Choose your language',
  'Pick your look',
  'Welcome to Specrails',
  'Turn ideas into specs',
  'Run the pipeline on rails',
  'Operate the app by chatting',
  'Bring your own agent',
  'Track every cent',
  'Make it your workspace',
  'Take Specrails with you',
  'Move at the speed of thought',
]

describe('OnboardingWizard', () => {
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    localStorage.clear()
  })

  it('renders the first step when open', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    expect(screen.getByText(STEP_TITLES[0])).toBeTruthy()
    expect(screen.getByTestId('onboarding-wizard')).toBeTruthy()
  })

  it('does not render when closed', () => {
    render(<OnboardingWizard open={false} onClose={onClose} />)
    expect(screen.queryByTestId('onboarding-wizard')).toBeNull()
  })

  it('navigates to the next step on Next click', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.getByText(STEP_TITLES[1])).toBeTruthy()
  })

  it('navigates back on Back click', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.getByText(STEP_TITLES[1])).toBeTruthy()
    fireEvent.click(screen.getByTestId('onboarding-back'))
    expect(screen.getByText(STEP_TITLES[0])).toBeTruthy()
  })

  it('navigates through all steps', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    expect(screen.getByText(STEP_TITLES[0])).toBeTruthy()
    for (let i = 1; i < STEP_TITLES.length; i++) {
      fireEvent.click(screen.getByTestId('onboarding-next'))
      expect(screen.getByText(STEP_TITLES[i])).toBeTruthy()
    }
  })

  it('shows "Get Started" on the last step and dismisses on click', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    for (let i = 0; i < STEP_TITLES.length - 1; i++) {
      fireEvent.click(screen.getByTestId('onboarding-next'))
    }
    expect(screen.getByText('Get Started')).toBeTruthy()
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(onClose).toHaveBeenCalled()
    // Completing the whole tour counts as "seen".
    expect(hasSeenOnboarding()).toBe(true)
  })

  it('dismisses on skip when "Don\'t show again" is checked', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('onboarding-dismiss-checkbox'))
    fireEvent.click(screen.getByTestId('onboarding-skip'))
    expect(onClose).toHaveBeenCalled()
    expect(hasSeenOnboarding()).toBe(true)
  })

  it('does not dismiss on skip when checkbox is unchecked', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('onboarding-skip'))
    expect(onClose).toHaveBeenCalled()
    expect(hasSeenOnboarding()).toBe(false)
  })

  it('shows the "Don\'t show again" checkbox only on the first step', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    expect(screen.getByTestId('onboarding-dismiss-checkbox')).toBeTruthy()
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.queryByTestId('onboarding-dismiss-checkbox')).toBeNull()
  })

  it('shows Back instead of Skip after the first step', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    expect(screen.getByTestId('onboarding-skip')).toBeTruthy()
    expect(screen.queryByTestId('onboarding-back')).toBeNull()
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.queryByTestId('onboarding-skip')).toBeNull()
    expect(screen.getByTestId('onboarding-back')).toBeTruthy()
  })

  it('left-nav step buttons allow jumping to a specific step', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    const navButtons = screen.getAllByRole('button', { name: /^Go to step/ })
    expect(navButtons).toHaveLength(STEP_TITLES.length)
    fireEvent.click(navButtons[STEP_TITLES.length - 1]) // jump to last step
    expect(screen.getByText(STEP_TITLES[STEP_TITLES.length - 1])).toBeTruthy()
  })

  it('degrades gracefully without theme/language providers — copy renders, grids do not', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    expect(screen.getByText(STEP_TITLES[0])).toBeTruthy()
    expect(screen.queryByTestId('language-card-en')).toBeNull()
    fireEvent.click(screen.getByTestId('onboarding-next'))
    expect(screen.getByText(STEP_TITLES[1])).toBeTruthy()
    expect(screen.queryByTestId('theme-card-specrails')).toBeNull()
  })

  it('renders the keyboard keys inside the shortcut chips (regression: empty <Kbd>)', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    const navButtons = screen.getAllByRole('button', { name: /^Go to step/ })
    fireEvent.click(navButtons[STEP_TITLES.length - 1]) // move-fast step (last)
    // jsdom has no Mac platform, so the modifier resolves to Ctrl / Alt.
    expect(screen.getAllByText('Ctrl').length).toBeGreaterThan(0)
    expect(screen.getAllByText('K').length).toBeGreaterThan(0)
    expect(screen.getAllByText('J').length).toBeGreaterThan(0)
    expect(screen.getAllByText('B').length).toBeGreaterThan(0)
    expect(screen.getAllByText('?').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Alt').length).toBeGreaterThan(0)
  })

  it('companion step links to the web companion (specrails.dev/companion-app)', () => {
    render(<OnboardingWizard open={true} onClose={onClose} />)
    const navButtons = screen.getAllByRole('button', { name: /^Go to step/ })
    const companionIdx = STEP_TITLES.indexOf('Take Specrails with you')
    fireEvent.click(navButtons[companionIdx]) // companion step
    expect(screen.getByText(STEP_TITLES[companionIdx])).toBeTruthy()
    const link = screen.getByTestId('companion-web-link')
    expect(link).toHaveAttribute('href', COMPANION_WEB_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('OnboardingWizard interactive steps (with providers)', () => {
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onClose = vi.fn()
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(async () => {
    await i18n.changeLanguage(DEFAULT_LANGUAGE)
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('language step hot-switches the app language from the wizard', async () => {
    render(
      <LanguageProvider>
        <OnboardingWizard open={true} onClose={onClose} />
      </LanguageProvider>
    )
    expect(screen.getByTestId('language-card-en')).toHaveAttribute('data-selected', 'true')
    fireEvent.click(screen.getByTestId('language-card-es'))
    await waitFor(() =>
      expect(screen.getByTestId('language-card-es')).toHaveAttribute('data-selected', 'true')
    )
    expect(i18n.language).toBe('es')
  })

  it('theme step applies the clicked theme to the document', async () => {
    render(
      <ThemeProvider>
        <OnboardingWizard open={true} onClose={onClose} />
      </ThemeProvider>
    )
    fireEvent.click(screen.getByTestId('onboarding-next')) // → theme step
    fireEvent.click(screen.getByTestId('theme-card-matrix'))
    await waitFor(() =>
      expect(screen.getByTestId('theme-card-matrix')).toHaveAttribute('data-selected', 'true')
    )
    expect(document.documentElement.dataset.theme).toBe('matrix')
  })
})

describe('hasSeenOnboarding / resetOnboarding', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns false when not dismissed', () => {
    expect(hasSeenOnboarding()).toBe(false)
  })

  it('returns true after onboarding is dismissed', () => {
    localStorage.setItem('specrails-desktop:onboarding-dismissed', 'true')
    expect(hasSeenOnboarding()).toBe(true)
  })

  it('resets the onboarding state', () => {
    localStorage.setItem('specrails-desktop:onboarding-dismissed', 'true')
    resetOnboarding()
    expect(hasSeenOnboarding()).toBe(false)
  })
})
