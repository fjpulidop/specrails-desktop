import i18n from '../../../lib/i18n'

/** Display name of a provider CLI id. */
export function providerLabel(providerId: string): string {
  if (providerId === 'claude') return 'Claude'
  if (providerId === 'codex') return 'Codex'
  return providerId ? providerId.charAt(0).toUpperCase() + providerId.slice(1) : 'AI'
}

/** "5-hour", "weekly", … for a provider window id. */
export function windowLabel(windowId: string | null): string {
  if (!windowId) return i18n.t('providerQuota:window.default')
  if (windowId === 'five_hour' || windowId.endsWith(':primary')) return i18n.t('providerQuota:window.fiveHour')
  if (windowId.startsWith('seven_day') || windowId.endsWith(':secondary')) return i18n.t('providerQuota:window.weekly')
  return i18n.t('providerQuota:window.default')
}
