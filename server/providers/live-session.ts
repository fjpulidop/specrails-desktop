import type { ProviderAdapter } from './types'
import { runClaudeLiveSession } from './claude-live-session'
import { runCodexLiveSession } from './codex-live-session'

/** A capability decision, kept out of conversation management. */
export function nativeLiveSessionRunner(adapter: ProviderAdapter) {
  switch (adapter.capabilities.liveInputTransport) {
    case 'claude-stream-json': return runClaudeLiveSession
    case 'codex-app-server': return runCodexLiveSession
    default: return undefined
  }
}
