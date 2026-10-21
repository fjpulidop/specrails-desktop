/**
 * Cross-feature request to open the app settings modal on a given section.
 * App settings are a modal owned by the app shell (App.tsx), so a page deep in
 * a feature asks for it through a window event instead of importing the shell.
 */
export type AppSettingsSection = 'appearance' | 'mobile' | 'subscriptionUsage' | 'specrailsAgents' | 'updates'

export const OPEN_APP_SETTINGS_EVENT = 'specrails:open-app-settings'

export interface OpenAppSettingsDetail {
  section: AppSettingsSection
}

export function openAppSettings(section: AppSettingsSection): void {
  try {
    window.dispatchEvent(new CustomEvent<OpenAppSettingsDetail>(OPEN_APP_SETTINGS_EVENT, { detail: { section } }))
  } catch {
    // non-DOM environment — nothing to open
  }
}
