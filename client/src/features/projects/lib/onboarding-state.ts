/**
 * Whether the platform tour (OnboardingWizard) was dismissed on this machine.
 * Kept apart from the wizard so the shell can decide to show it without
 * loading the wizard's chunk.
 */
const ONBOARDING_KEY = 'specrails-desktop:onboarding-dismissed'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'true'
  } catch {
    return false
  }
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_KEY)
  } catch {
    // ignore
  }
}

export function dismissOnboarding(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, 'true')
  } catch {
    // ignore
  }
}
