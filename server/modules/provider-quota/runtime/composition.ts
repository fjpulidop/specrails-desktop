/**
 * Production wiring of the machine's provider quota: the store persisted in
 * `desktop_settings`, fed by the subscription-usage reader (resolved lazily:
 * it is composed later at startup), announcing changes on the app-level
 * WebSocket, and bound to the reporting door every producer uses.
 */
import type { DbInstance } from '../../../db'
import { getDesktopSetting, setDesktopSetting } from '../../../desktop-db'
import type { ProviderQuotaView } from '../domain'
import type { UsageFeed } from '../ports'
import { bindQuotaStore, bindResumeClock } from './quota-reports'
import { createResumeClock } from './resume-clock'
import { createQuotaStore, realTimers, type QuotaStore } from './quota-store'

export const PROVIDER_QUOTA_SETTING = 'provider_quota_refusals_v1'

export interface ProviderQuotaMessage { type: 'provider_quota.updated'; providers: ProviderQuotaView[]; timestamp: string }

export function createDesktopQuotaStore(options: { desktopDb: DbInstance; usage: () => UsageFeed | null; announce: (message: ProviderQuotaMessage) => void }): QuotaStore {
  const usage: UsageFeed = {
    snapshot: () => options.usage()?.snapshot() ?? { providers: [] },
    observe: (providerId, windows, observedAt) => options.usage()?.observe(providerId, windows, observedAt),
  }
  const store = createQuotaStore({
    timers: realTimers,
    persistence: {
      load: () => getDesktopSetting(options.desktopDb, PROVIDER_QUOTA_SETTING),
      save: (value) => setDesktopSetting(options.desktopDb, PROVIDER_QUOTA_SETTING, value),
    },
    usage,
    onChange: (providers) => options.announce({ type: 'provider_quota.updated', providers, timestamp: new Date().toISOString() }),
  })
  bindQuotaStore(store)
  bindResumeClock(createResumeClock(realTimers))
  return { ...store, dispose: () => { store.dispose(); bindQuotaStore(null); bindResumeClock(null) } }
}
