import type { Availability, EnterpriseSpend, ProviderUsage, UsageProvider, UsageWindow } from './domain'
export interface UsageReadResult {
  availability: Availability
  windows: UsageWindow[]
  spend?: EnterpriseSpend | null
  plan: string | null
  source: ProviderUsage['source']
  identity?: string
}
export interface UsageReader {
  context(signal: AbortSignal): Promise<string>
  read(signal: AbortSignal): Promise<UsageReadResult>
}
export interface UsageDependencies {
  installed(provider: UsageProvider): Promise<boolean>
  eligible?(provider: UsageProvider): Promise<boolean>
  readers: Record<UsageProvider, UsageReader>
  now?: () => number
}
