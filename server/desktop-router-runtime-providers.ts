/**
 * Runtime provider connection routes (`/runtime-providers*`): local
 * OpenAI-compatible engines and CLI connections, their live status, and
 * probing an unsaved draft.
 */
import type { Router } from 'express'
import { AgentRuntimeConfigError, loadRuntimeProviders, saveRuntimeProviders, validateRuntimeProviders, loadAgentRuntimeConfig, validateAgentRuntimeConfig } from './modules/agent-runtime/runtime/agent-runtime-settings'
import type { ProjectRegistry } from './project-registry'
import type { WsMessage } from './types'
import { listProjects } from './desktop-db'
import { getSnapshotSync, refreshLocalDetection } from './provider-detection'
import { getCachedProbe, probeConnection } from './local-engine-detection'
import { isLocalEnginesEnabled, syncLocalAdapters } from './providers/local-adapter-registry'

/** Per-connection status block on GET/PUT /runtime-providers. */
export type RuntimeProviderStatus =
  | { kind: 'local'; reachable: boolean; authState: 'authenticated' | 'unauthenticated' | 'unknown'; models: string[]; latencyMs?: number; error?: string; apiKeyEnvMissing?: boolean; probing?: boolean }
  | { kind: 'cli'; reachable: boolean; installed: boolean; executable: boolean; authState: 'authenticated' | 'unauthenticated' | 'unknown'; models: string[]; version?: string; error?: string; probing?: boolean }
export type RuntimeProviderStatusMap = Record<string, RuntimeProviderStatus>

export function registerRuntimeProviderRoutes(router: Router, deps: { registry: ProjectRegistry; broadcast: (msg: WsMessage) => void }): void {
  const { registry, broadcast } = deps
  // ─── Runtime provider connections (local AI engines) ──────────────────────
  // GET returns every connection plus a per-id status: local ids read the
  // detection cache (reachable/authState/models), CLI ids the detection
  // snapshot. PUT saves, re-syncs the local adapters, re-probes them (awaited)
  // and broadcasts `providers.detected_changed` when the usable set changed so
  // open engine selectors update live. POST /test probes an UNSAVED draft.
  const runtimeProviderStatus = (providers: ReturnType<typeof loadRuntimeProviders>): RuntimeProviderStatusMap => {
    const snapshot = getSnapshotSync()
    const status: RuntimeProviderStatusMap = {}
    for (const provider of providers) {
      if (provider.kind === 'openai-compatible') {
        const probe = getCachedProbe(provider.id)
        status[provider.id] = probe
          ? {
              kind: 'local', reachable: probe.reachable, authState: probe.authState, models: probe.models,
              latencyMs: probe.latencyMs, ...(probe.error ? { error: probe.error } : {}),
              ...(probe.apiKeyEnvMissing ? { apiKeyEnvMissing: true } : {}),
            }
          : { kind: 'local', reachable: false, authState: 'unknown', models: [], probing: true }
        continue
      }
      const row = snapshot?.providers[provider.cli]
      status[provider.id] = row
        ? { kind: 'cli', reachable: row.usable, installed: row.installed, executable: row.executable, authState: row.authState, models: [], ...(row.version ? { version: row.version } : {}), ...(row.error ? { error: row.error } : {}) }
        : { kind: 'cli', reachable: false, installed: false, executable: false, authState: 'unknown', models: [], probing: true }
    }
    return status
  }
  router.get('/runtime-providers', (_req, res) => {
    try {
      for (const project of listProjects(registry.desktopDb)) loadAgentRuntimeConfig(project)
      const providers = loadRuntimeProviders()
      res.json({ providers, status: runtimeProviderStatus(providers), localEnginesEnabled: isLocalEnginesEnabled() })
    } catch (error) { res.status(422).json({ message: (error as Error).message }) }
  })
  router.put('/runtime-providers', async (req, res) => {
    let saved: ReturnType<typeof saveRuntimeProviders>
    try {
      const projects = listProjects(registry.desktopDb).map(project => loadAgentRuntimeConfig(project))
      const providers = validateRuntimeProviders(req.body.providers)
      for (const config of projects) if (config) validateAgentRuntimeConfig({ ...config, providers })
      saved = saveRuntimeProviders(providers)
    } catch (error) { res.status(error instanceof AgentRuntimeConfigError ? 400 : 500).json({ message: (error as Error).message }); return }
    try {
      syncLocalAdapters(saved)
      const { snapshot, changed } = await refreshLocalDetection()
      if (changed) {
        broadcast({
          type: 'providers.detected_changed',
          detected: snapshot.detected,
          providers: snapshot.providers,
          timestamp: new Date().toISOString(),
        } as unknown as WsMessage)
      }
    } catch (error) {
      console.warn('[runtime-providers] local engine re-sync failed (non-fatal):', (error as Error).message)
    }
    res.json({ providers: saved, status: runtimeProviderStatus(saved), localEnginesEnabled: isLocalEnginesEnabled() })
  })
  router.post('/runtime-providers/test', async (req, res) => {
    const body = (req.body ?? {}) as { baseUrl?: unknown; apiKeyEnv?: unknown }
    // Same shape rules as the connections schema (absolute http(s), no
    // credentials/query/fragment; env NAME only, never a key value).
    if (typeof body.baseUrl !== 'string' || !/^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(body.baseUrl)) {
      res.status(400).json({ error: 'invalid_base_url', message: 'baseUrl must be an absolute HTTP(S) URL without credentials, query or fragment' }); return
    }
    if (body.apiKeyEnv !== undefined && body.apiKeyEnv !== null && body.apiKeyEnv !== '' && (typeof body.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.apiKeyEnv))) {
      res.status(400).json({ error: 'invalid_api_key_env', message: 'apiKeyEnv must be an environment variable name' }); return
    }
    const apiKeyEnv = typeof body.apiKeyEnv === 'string' && body.apiKeyEnv ? body.apiKeyEnv : undefined
    const probe = await probeConnection({ baseUrl: body.baseUrl, apiKeyEnv })
    res.json({
      reachable: probe.reachable, authState: probe.authState, models: probe.models, latencyMs: probe.latencyMs,
      ...(probe.error ? { error: probe.error } : {}), ...(probe.apiKeyEnvMissing ? { apiKeyEnvMissing: true } : {}),
    })
  })
}
