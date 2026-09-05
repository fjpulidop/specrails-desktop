/**
 * Global Specrails Agents defaults — app-level (per-machine) per-provider
 * customization of the specrails-core pipeline agents: the pipeline
 * (orchestrator) model + reasoning effort, and per-agent model overrides for
 * providers whose runtime honours execution profiles (claude, kimi).
 *
 * Storage is one JSON blob under `desktop_settings['specrails_agent_defaults']`
 * (no migration — plain k/v). Every consumer reads AT SPAWN/LAUNCH TIME, so a
 * settings change applies to the next run without restarting the app.
 *
 * Layering contract (least → most specific):
 *   built-in adapter default  <  GLOBAL agent defaults  <  per-project setting
 *   (orchestrator model, resolved model)  <  per-project profile  <  explicit
 *   per-launch selection.
 * The global layer therefore only ever fills gaps — it never overrides an
 * explicit user choice made closer to the run.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import type { DbInstance } from './db'
import { getDesktopSetting, setDesktopSetting } from './desktop-db'
import { getAdapter, listAdapters } from './providers'
import type { ProviderAdapter } from './providers/types'
import {
  isModelAvailableForAdapter,
  isReasoningEffortValidForModel,
  reasoningEffortsForModel,
} from './providers/runtime'
import type { Profile, ResolvedProfile } from './profile-manager'

export const AGENT_DEFAULTS_SETTING_KEY = 'specrails_agent_defaults'

/** Synthetic profile name recorded when a run's profile came purely from the
 *  global defaults layer (no project profile existed). */
export const GLOBAL_DEFAULTS_PROFILE_NAME = 'global-defaults'

/** Agent ids the v1 settings surface may override — the baseline pipeline trio
 *  every adapter guarantees (`adapter.baselineAgents()`). */
const AGENT_ID_PATTERN = /^(sr|custom)-[a-z0-9][a-z0-9-]*$/

export interface ProviderAgentDefaults {
  /** false ⇒ everything default for this provider (remaining fields ignored). */
  custom: boolean
  /** Orchestrator/run model applied when no more-specific choice exists. */
  pipelineModel?: string
  /** Run-level reasoning effort (whole pipeline — sub-agents inherit the
   *  process-level effort on claude/codex; kimi K3 rides its env knob). */
  pipelineEffort?: string
  /** Per-agent model overrides (profile-capable providers only). */
  agentModels?: Record<string, string>
}

export interface AgentDefaultsSettings {
  version: 1
  providers: Record<string, ProviderAgentDefaults>
}

/** Validated, ready-to-apply view for one provider (null = layer inactive). */
export interface ResolvedProviderAgentDefaults {
  pipelineModel: string | null
  /** Raw tier string — callers MUST re-validate against the FINAL model via
   *  `isReasoningEffortValidForModel` (kimi's tiers are model-scoped). */
  pipelineEffort: string | null
  agentModels: Record<string, string>
}

export class AgentDefaultsValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'AgentDefaultsValidationError'
  }
}

const EMPTY_SETTINGS: AgentDefaultsSettings = { version: 1, providers: {} }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural sanitize for values read from disk — never throws, drops junk. */
function sanitizeStored(raw: unknown): AgentDefaultsSettings {
  if (!isRecord(raw) || !isRecord(raw.providers)) return { ...EMPTY_SETTINGS, providers: {} }
  const providers: Record<string, ProviderAgentDefaults> = {}
  for (const [id, value] of Object.entries(raw.providers)) {
    if (!isRecord(value)) continue
    const entry: ProviderAgentDefaults = { custom: value.custom === true }
    if (typeof value.pipelineModel === 'string' && value.pipelineModel) entry.pipelineModel = value.pipelineModel
    if (typeof value.pipelineEffort === 'string' && value.pipelineEffort) entry.pipelineEffort = value.pipelineEffort
    if (isRecord(value.agentModels)) {
      const agents: Record<string, string> = {}
      for (const [agentId, model] of Object.entries(value.agentModels)) {
        if (AGENT_ID_PATTERN.test(agentId) && typeof model === 'string' && model) agents[agentId] = model
      }
      if (Object.keys(agents).length > 0) entry.agentModels = agents
    }
    providers[id] = entry
  }
  return { version: 1, providers }
}

/** Read + sanitize the stored settings. Never throws. */
export function readAgentDefaultsSettings(db: DbInstance): AgentDefaultsSettings {
  try {
    const raw = getDesktopSetting(db, AGENT_DEFAULTS_SETTING_KEY)
    if (!raw) return { ...EMPTY_SETTINGS, providers: {} }
    return sanitizeStored(JSON.parse(raw))
  } catch {
    return { ...EMPTY_SETTINGS, providers: {} }
  }
}

/**
 * Validate ONE provider's config from an untrusted PATCH body.
 * Throws `AgentDefaultsValidationError` with an API-stable `code`.
 */
function validateProviderPatch(providerId: string, value: unknown): ProviderAgentDefaults {
  let adapter: ProviderAdapter
  try {
    adapter = getAdapter(providerId)
  } catch {
    throw new AgentDefaultsValidationError('unknown_provider', `Unknown provider "${providerId}"`)
  }
  if (!isRecord(value)) {
    throw new AgentDefaultsValidationError('invalid_provider_config', `Config for "${providerId}" must be an object`)
  }
  const entry: ProviderAgentDefaults = { custom: value.custom === true }
  if (value.pipelineModel !== undefined && value.pipelineModel !== null && value.pipelineModel !== '') {
    if (!isModelAvailableForAdapter(adapter, value.pipelineModel)) {
      throw new AgentDefaultsValidationError('invalid_model', `Model is not valid for provider "${providerId}"`)
    }
    entry.pipelineModel = value.pipelineModel
  }
  if (value.pipelineEffort !== undefined && value.pipelineEffort !== null && value.pipelineEffort !== '') {
    const effortModel = entry.pipelineModel ?? adapter.defaultModel()
    if (!isReasoningEffortValidForModel(adapter, effortModel, value.pipelineEffort)) {
      throw new AgentDefaultsValidationError(
        'invalid_effort',
        `Effort is not valid for provider "${providerId}" and model "${effortModel}"`,
      )
    }
    entry.pipelineEffort = value.pipelineEffort as string
  }
  if (value.agentModels !== undefined && value.agentModels !== null) {
    if (!isRecord(value.agentModels)) {
      throw new AgentDefaultsValidationError('invalid_agent_models', 'agentModels must be an object')
    }
    const agents: Record<string, string> = {}
    for (const [agentId, model] of Object.entries(value.agentModels)) {
      if (model === undefined || model === null || model === '') continue
      if (adapter.capabilities.profiles !== true) {
        throw new AgentDefaultsValidationError(
          'per_agent_not_supported',
          `Provider "${providerId}" does not support per-agent model overrides`,
        )
      }
      if (!(adapter.baselineAgents() as readonly string[]).includes(agentId)) {
        throw new AgentDefaultsValidationError('unknown_agent', `Unknown agent "${agentId}" for provider "${providerId}"`)
      }
      if (!isModelAvailableForAdapter(adapter, model)) {
        throw new AgentDefaultsValidationError('invalid_agent_model', `Model for "${agentId}" is not valid for provider "${providerId}"`)
      }
      agents[agentId] = model
    }
    if (Object.keys(agents).length > 0) entry.agentModels = agents
  }
  return entry
}

/**
 * Apply a PATCH body: every provider key present REPLACES that provider's
 * stored config wholesale (deterministic; no deep-merge ambiguity). Returns
 * the canonical stored settings. Throws `AgentDefaultsValidationError`.
 */
export function applyAgentDefaultsPatch(db: DbInstance, body: unknown): AgentDefaultsSettings {
  if (!isRecord(body) || !isRecord(body.providers)) {
    throw new AgentDefaultsValidationError('invalid_body', "body must include a 'providers' object")
  }
  const next = readAgentDefaultsSettings(db)
  for (const [providerId, value] of Object.entries(body.providers)) {
    next.providers[providerId] = validateProviderPatch(providerId, value)
  }
  setDesktopSetting(db, AGENT_DEFAULTS_SETTING_KEY, JSON.stringify(next))
  return next
}

/**
 * Resolve the effective global defaults for one provider — validated against
 * the adapter's live catalog so a stale stored model degrades to "no override"
 * (fail-open to built-in defaults) instead of poisoning a spawn.
 * Returns null when the layer is inactive or nothing survives validation.
 */
export function resolveAgentDefaults(db: DbInstance, providerId: string): ResolvedProviderAgentDefaults | null {
  let adapter: ProviderAdapter
  try {
    adapter = getAdapter(providerId)
  } catch {
    return null
  }
  const entry = readAgentDefaultsSettings(db).providers[providerId]
  if (!entry?.custom) return null
  const pipelineModel =
    entry.pipelineModel && isModelAvailableForAdapter(adapter, entry.pipelineModel) ? entry.pipelineModel : null
  const pipelineEffort =
    entry.pipelineEffort && adapter.capabilities.supportsReasoningEffort === true ? entry.pipelineEffort : null
  const agentModels: Record<string, string> = {}
  if (adapter.capabilities.profiles === true && entry.agentModels) {
    for (const [agentId, model] of Object.entries(entry.agentModels)) {
      if (
        (adapter.baselineAgents() as readonly string[]).includes(agentId)
        && isModelAvailableForAdapter(adapter, model)
      ) {
        agentModels[agentId] = model
      }
    }
  }
  if (!pipelineModel && !pipelineEffort && Object.keys(agentModels).length === 0) return null
  return { pipelineModel, pipelineEffort, agentModels }
}

/**
 * Fill a resolved profile's gaps from the global layer: only agents WITHOUT an
 * explicit model get one. The profile's own choices (including orchestrator)
 * always win. Returns the original object untouched when nothing changed.
 */
export function mergeProfileWithAgentDefaults(
  profile: Profile,
  defaults: ResolvedProviderAgentDefaults,
): { changed: boolean; profile: Profile } {
  let changed = false
  const agents = profile.agents.map((agent) => {
    if (!agent.model && defaults.agentModels[agent.id]) {
      changed = true
      return { ...agent, model: defaults.agentModels[agent.id] }
    }
    return agent
  })
  if (!changed) return { changed: false, profile }
  return { changed: true, profile: { ...profile, agents } }
}

/** Baseline-trio profile synthesized purely from the global layer (used when
 *  the project has no profile of its own). */
export function synthesizeProfileFromDefaults(
  adapter: ProviderAdapter,
  defaults: ResolvedProviderAgentDefaults,
): Profile {
  return {
    schemaVersion: 1,
    name: GLOBAL_DEFAULTS_PROFILE_NAME,
    description: 'Synthesized from the app-level Specrails Agents defaults',
    provider: adapter.id,
    orchestrator: { model: defaults.pipelineModel ?? adapter.defaultModel() },
    agents: adapter.baselineAgents().map((id) => ({
      id,
      ...(defaults.agentModels[id] ? { model: defaults.agentModels[id] } : {}),
    })),
    routing: [{ default: true, agent: 'sr-developer' }],
  }
}

/**
 * Content-addressed snapshot for the LOOP path (no per-job dir exists when the
 * engine spawns ai-steps). Identical content reuses the same immutable file, so
 * concurrent runs never race and a settings change lands in a NEW file — an
 * in-flight run keeps the profile it resolved. Never throws to the caller.
 */
export function ensureGlobalProfileSnapshot(
  providerId: string,
  profile: Profile,
  baseDir: string = path.join(os.homedir(), '.specrails', 'agent-defaults'),
): string {
  const body = JSON.stringify(profile, null, 2) + '\n'
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)
  const file = path.join(baseDir, `${providerId}-${hash}.json`)
  if (fs.existsSync(file)) return file
  fs.mkdirSync(baseDir, { recursive: true })
  const tmp = path.join(baseDir, `.${providerId}-${hash}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o444 })
  try {
    fs.renameSync(tmp, file)
  } catch {
    // A concurrent writer won the rename — the content is identical by hash.
    try { fs.unlinkSync(tmp) } catch { /* best-effort */ }
  }
  return file
}

/** Catalog payload for the settings UI — every REGISTERED provider (detection
 *  state is a client concern; undetected providers render non-clickable). */
export function buildAgentDefaultsCatalog(): Array<{
  id: string
  displayName: string
  models: { value: string; label: string; default?: boolean }[]
  defaultModel: string
  baselineAgents: string[]
  perAgentModels: boolean
  supportsEffort: boolean
  customModelAliases: boolean
  effortsByModel: Record<string, string[]>
}> {
  return listAdapters().map((adapter) => {
    const models = adapter.modelCatalog().map((m) => ({ ...m }))
    const effortsByModel: Record<string, string[]> = {}
    for (const m of models) {
      effortsByModel[m.value] = [...reasoningEffortsForModel(adapter, m.value)]
    }
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      models,
      defaultModel: adapter.defaultModel(),
      baselineAgents: [...adapter.baselineAgents()],
      perAgentModels: adapter.capabilities.profiles === true,
      supportsEffort: adapter.capabilities.supportsReasoningEffort === true,
      customModelAliases: adapter.capabilities.customModelAliases === true,
      effortsByModel,
    }
  })
}

/**
 * Loop-path profile resolver factory. Returns `(provider) => snapshotPath|null`
 * for injection as `SPECRAILS_PROFILE_PATH` on loop ai-step spawns.
 *
 * A named rail profile always gets its own immutable snapshot. An explicit
 * null opts out. Without a selection, the global layer only fills missing
 * per-agent models; otherwise Core keeps its existing file-based defaults.
 */
export function createLoopProfilePathResolver(io: {
  desktopDb: DbInstance
  /** Profile-resolution root — the workspace for relocated projects. */
  profileRoot: () => string
  /** Core-version gate (queue-manager's `projectSupportsProfiles`). */
  supportsProfiles: (root: string) => boolean
  /** Seam for tests. */
  resolveProfile?: (root: string, explicit: string | undefined, provider: string) => ResolvedProfile | null
  snapshotDir?: string
}): (provider: string, profileName?: string | null) => string | null {
  return (provider: string, profileName?: string | null): string | null => {
    if (profileName === null) return null
    try {
      const defaults = resolveAgentDefaults(io.desktopDb, provider)
      const hasGlobalModels = defaults && Object.keys(defaults.agentModels).length > 0
      if (!profileName && !hasGlobalModels) return null
      const adapter = getAdapter(provider)
      if (adapter.capabilities.profiles !== true || adapter.capabilities.profileEnvSupport !== true) return null
      const root = io.profileRoot()
      if (!io.supportsProfiles(root)) return null
      let base: ResolvedProfile | null = null
      try {
        const resolve = io.resolveProfile
          ?? ((r: string, e: string | undefined, p: string) =>
            (require('./profile-manager') as typeof import('./profile-manager')).resolveProfile(r, e, p))
        base = resolve(root, profileName, provider)
      } catch (error) {
        if (profileName) throw error
        base = null
      }
      if (profileName && !base) throw new Error(`Profile '${profileName}' is unavailable for ${provider}`)
      let effective: Profile | null = null
      if (base) {
        const merged = defaults ? mergeProfileWithAgentDefaults(base.profile, defaults) : { changed: false, profile: base.profile }
        // Nothing to add ⇒ stay out of the way (core's own file fallback rules).
        effective = profileName || merged.changed ? merged.profile : null
      } else if (defaults) {
        effective = synthesizeProfileFromDefaults(adapter, defaults)
      }
      if (!effective) return null
      return ensureGlobalProfileSnapshot(provider, effective, io.snapshotDir)
    } catch (err) {
      if (profileName) throw err
      console.warn(`[agent-defaults] loop profile resolution failed for ${provider}: ${(err as Error).message}`)
      return null
    }
  }
}
