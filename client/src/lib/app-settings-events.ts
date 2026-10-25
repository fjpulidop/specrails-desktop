/**
 * Cross-feature request to open the app settings modal on a given section.
 * App settings are a modal owned by the app shell (App.tsx), so a page deep in
 * a feature asks for it through a window event instead of importing the shell.
 */
export const APP_SETTINGS_SECTIONS = [
  'appearance', 'effects', 'code', 'terminal',
  'specrailsAgents', 'subscriptionUsage', 'mcp', 'mobile',
  'projects', 'advanced', 'webhooks', 'updates', 'about',
] as const
export type AppSettingsSection = (typeof APP_SETTINGS_SECTIONS)[number]

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

/**
 * Same idea for the per-project settings modal (Mission mode; Board mode shows
 * the same sections on the `/settings` route). Owned by the sidebar that hosts
 * the modal.
 */
export const OPEN_PROJECT_SETTINGS_EVENT = 'specrails:open-project-settings'

export interface OpenProjectSettingsDetail {
  /** A `PROJECT_SETTINGS_SECTIONS` id. */
  section: string
}

export function openProjectSettings(section: string): void {
  try {
    window.dispatchEvent(new CustomEvent<OpenProjectSettingsDetail>(OPEN_PROJECT_SETTINGS_EVENT, { detail: { section } }))
  } catch {
    // non-DOM environment — nothing to open
  }
}

/**
 * Same idea for the Analytics Budget panel (caps, projection, what-if): the
 * shell navigates to the active project's analytics and scrolls to the panel.
 */
export const OPEN_BUDGET_PANEL_EVENT = 'specrails:open-budget-panel'
/** Query param (`?panel=budget`) the analytics page reads to scroll to the panel. */
export const BUDGET_PANEL_PARAM = 'panel'

export function openBudgetPanel(): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_BUDGET_PANEL_EVENT))
  } catch {
    // non-DOM environment — nothing to open
  }
}
