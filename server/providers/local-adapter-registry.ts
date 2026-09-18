// Dynamic registration of local (OpenAI-compatible) adapters — one per
// connection in `~/.specrails/runtime-providers.json`. Called at boot (after
// the connections load) and after every successful `PUT /api/runtime-providers`.
//
// Kill switch: SPECRAILS_LOCAL_ENGINES=0|false|off ⇒ no registration, and any
// previously registered local adapter is removed (byte-identical legacy).
//
// Spec: openspec/changes/local-ai-engines/specs/local-ai-engines/spec.md

import { register, unregisterAdapter, listAdapters, hasAdapter, adapterKind } from './registry'
import { createLocalAdapter, isLocalAdapter, type LocalConnection, type LocalProviderAdapter } from './local-adapter'

export function isLocalEnginesEnabled(): boolean {
  const raw = (process.env.SPECRAILS_LOCAL_ENGINES ?? '').trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off')
}

export interface SyncResult {
  registered: string[]
  unregistered: string[]
  /** Ids skipped because they collide with a CLI adapter. */
  skipped: string[]
}

/** Every currently registered local adapter, in registry order. */
export function listLocalAdapters(): LocalProviderAdapter[] {
  return listAdapters().filter(isLocalAdapter)
}

/** The connections behind the registered local adapters. */
export function listLocalConnections(): LocalConnection[] {
  return listLocalAdapters().map((a) => a.localConnection)
}

/**
 * Reconcile the registry with the given connections: register new/changed
 * openai-compatible ids, unregister ids no longer present. CLI ids are never
 * touched. Under the kill switch every local adapter is unregistered.
 */
export type SyncableConnection = { id: string; kind: 'cli' } | ({ id: string; kind: 'openai-compatible'; baseUrl: string } & Partial<Omit<LocalConnection, 'id' | 'kind' | 'baseUrl'>>)

export function syncLocalAdapters(connections: readonly SyncableConnection[]): SyncResult {
  const result: SyncResult = { registered: [], unregistered: [], skipped: [] }
  const wanted = new Map<string, LocalConnection>()
  if (isLocalEnginesEnabled()) {
    for (const conn of connections) {
      if (conn.kind !== 'openai-compatible' || typeof conn.baseUrl !== 'string') continue
      if (hasAdapter(conn.id) && adapterKind(conn.id) !== 'local') { result.skipped.push(conn.id); continue }
      wanted.set(conn.id, conn as LocalConnection)
    }
  }
  for (const existing of listLocalAdapters()) {
    if (!wanted.has(existing.id)) {
      if (unregisterAdapter(existing.id)) result.unregistered.push(existing.id)
    }
  }
  for (const [id, conn] of wanted) {
    // Re-register on every sync so a changed baseUrl/rates/label takes effect;
    // in-flight jobs keep the adapter instance they resolved earlier.
    register(createLocalAdapter({ ...conn }), 'local')
    result.registered.push(id)
  }
  return result
}
