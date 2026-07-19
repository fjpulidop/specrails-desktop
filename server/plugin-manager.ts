import fs from 'fs'
import path from 'path'
import type {
  Plugin,
  PluginCatalogEntry,
  PluginInstalledMessage,
  PluginUninstalledMessage,
  PluginHealthChangedMessage,
  PluginInstallProgressMessage,
  PluginPreviewFileEntry,
  PluginPreviewResult,
  PluginRequirement,
  PluginProviderStateEntry,
  PluginState,
  PluginStateEntry,
  PluginVerifyResult,
  WsMessage,
} from './types'
import { buildOwnershipMap, type OwnershipMap } from './plugins/ownership'
import {
  getClaudeApprovalState,
  findEnabledMarketplaceKeys,
  findInstalledButNotEnabledMarketplaceKeys,
} from './plugins/claude-approval'
import { detectMcpDrift } from './plugins/drift'
import { getAdapter, hasAdapter } from './providers'
import {
  mcpJsonPath,
  pluginsDir,
  stateFilePath,
} from './plugins/paths'

function providerMcpJsonPath(projectPath: string, providerId?: string): string {
  if (providerId && hasAdapter(providerId)) {
    return getAdapter(providerId).projectMcpPath?.(projectPath) ?? mcpJsonPath(projectPath)
  }
  return mcpJsonPath(projectPath)
}

function readMcpServersMap(projectPath: string, providerId?: string): Record<string, unknown> {
  try {
    const file = providerMcpJsonPath(projectPath, providerId)
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    return parsed.mcpServers ?? {}
  } catch {
    return {}
  }
}
import {
  atomicWriteFileSync,
  readJsonOr,
  surgicalMergeJson,
  surgicalRemoveKeys,
  withFileLock,
} from './plugins/json-mutation'
import { applyContributors, contributorPaths, revertContributors } from './plugins/contributors'

export type PluginBroadcast = (msg: WsMessage) => void

/**
 * State entry augmented with the plugin's owned `mcpServers` keys, persisted at
 * install time (BUG-PLUGIN-04). Declared here as a local intersection rather
 * than widening the shared `PluginStateEntry` interface — the field is an
 * internal recovery record used only by orphan removal. Older state files
 * (written before this field existed) simply lack it; readers tolerate that.
 */
type PluginStateEntryWithOwned = PluginStateEntry & { ownedMcpServers?: string[] }

const LEGACY_PROVIDER = 'claude'

function targetProvider(providerId?: string): string {
  return providerId?.trim() || LEGACY_PROVIDER
}

function legacyProvider(providerId: string, legacyProviderId?: string): string {
  return legacyProviderId?.trim() || providerId
}

function legacyProviderState(entry: PluginStateEntryWithOwned): PluginProviderStateEntry {
  return {
    installedAt: entry.installedAt,
    installedFiles: [...(entry.installedFiles ?? [])],
    health: entry.health,
    healthReason: entry.healthReason,
    ownedMcpServers: [...(entry.ownedMcpServers ?? [])],
  }
}

/** Resolve one provider without pretending a legacy primary install also
 * belongs to every secondary provider. */
function getProviderState(
  entry: PluginStateEntryWithOwned | undefined,
  providerId: string,
  legacyProviderId: string,
): PluginProviderStateEntry | undefined {
  if (!entry) return undefined
  if (entry.providers) return entry.providers[providerId]
  return providerId === legacyProviderId ? legacyProviderState(entry) : undefined
}

/** Materialize the provider map lazily when the first post-migration mutation
 * occurs. Until then legacy state remains byte-compatible on disk. */
function ensureProviderStates(
  entry: PluginStateEntryWithOwned,
  legacyProviderId: string,
): Record<string, PluginProviderStateEntry> {
  if (!entry.providers) {
    entry.providers = { [legacyProviderId]: legacyProviderState(entry) }
  }
  return entry.providers
}

/** Keep the schema-v1 aggregate fields truthful for older Desktop builds and
 * diagnostics that have not learned the provider map yet. */
function syncAggregateState(entry: PluginStateEntryWithOwned): void {
  const states = Object.values(entry.providers ?? {})
  if (states.length === 0) return
  entry.installedAt = states
    .map((state) => state.installedAt)
    .sort()[0] ?? entry.installedAt
  entry.installedFiles = Array.from(new Set(states.flatMap((state) => state.installedFiles ?? [])))
  const degraded = states.find((state) => state.health === 'degraded')
  if (degraded) {
    entry.health = 'degraded'
    entry.healthReason = degraded.healthReason
  } else if (states.every((state) => state.health === 'ok')) {
    entry.health = 'ok'
    delete entry.healthReason
  } else {
    entry.health = 'unknown'
    delete entry.healthReason
  }
  entry.ownedMcpServers = Array.from(
    new Set(states.flatMap((state) => state.ownedMcpServers ?? [])),
  )
}

function supportsProvider(plugin: Plugin, providerId: string): boolean {
  const declared = plugin.manifest.providerSupport
  return declared === undefined
    ? providerId === LEGACY_PROVIDER
    : Object.prototype.hasOwnProperty.call(declared, providerId)
}

function sameInstructionsFile(leftProviderId: string, rightProviderId: string): boolean {
  if (!hasAdapter(leftProviderId) || !hasAdapter(rightProviderId)) return false
  return getAdapter(leftProviderId).instructionsFilename === getAdapter(rightProviderId).instructionsFilename
}

/** A single managed instructions block may be shared by providers that declare
 * the same project-relative instructions path. Removing or deactivating one
 * provider must not remove that block while another such provider still has
 * the plugin active. Codex (`AGENTS.md`) and Kimi
 * (`.kimi-code/AGENTS.md`) are intentionally independent. */
function hasOtherActiveContributor(
  entry: PluginStateEntryWithOwned,
  providerId: string,
): boolean {
  if (!entry.providers) return false
  return Object.entries(entry.providers).some(([candidate, state]) =>
    candidate !== providerId &&
    state.active !== false &&
    sameInstructionsFile(candidate, providerId),
  )
}

export type PrerequisiteCheck = (req: PluginRequirement) => Promise<{
  installed: boolean
  executable: boolean
  version?: string
  meetsMinimum: boolean
}>

export class PluginNotFoundError extends Error {
  constructor(name: string) {
    super(`plugin not found in registry: ${name}`)
    this.name = 'PluginNotFoundError'
  }
}

export class PluginNotInstalledError extends Error {
  constructor(name: string) {
    super(`plugin is not installed: ${name}`)
    this.name = 'PluginNotInstalledError'
  }
}

export class PluginAlreadyInstalledError extends Error {
  constructor(name: string) {
    super(`plugin is already installed: ${name}`)
    this.name = 'PluginAlreadyInstalledError'
  }
}

export class PluginInstallError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'PluginInstallError'
    this.cause = cause
  }
}

export interface PluginManagerOptions {
  /** Default verify timeout. Per-plugin overrides via manifest.verifyTimeoutMs. */
  defaultVerifyTimeoutMs?: number
  /** Optional prerequisite checker (delegated to setup-prerequisites in production). */
  checkPrerequisite?: PrerequisiteCheck
  /** Optional override for the Claude Code approval check. Tests inject a stub
   *  to avoid depending on `~/.claude.json`. Defaults to the real reader. */
  claudeApprovalChecker?: (projectPath: string, serverName: string) => 'enabled' | 'disabled' | 'pending'
}

const DEFAULT_VERIFY_TIMEOUT_MS = 2000

export class PluginManager {
  readonly registry: OwnershipMap
  private readonly _options: Required<Pick<PluginManagerOptions, 'defaultVerifyTimeoutMs'>> & {
    checkPrerequisite?: PrerequisiteCheck
    claudeApprovalChecker: NonNullable<PluginManagerOptions['claudeApprovalChecker']>
  }

  constructor(plugins: Plugin[], options: PluginManagerOptions = {}) {
    this.registry = buildOwnershipMap(plugins)
    this._options = {
      defaultVerifyTimeoutMs: options.defaultVerifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      checkPrerequisite: options.checkPrerequisite,
      claudeApprovalChecker: options.claudeApprovalChecker ?? getClaudeApprovalState,
    }
  }

  // ─── State helpers ─────────────────────────────────────────────────────────

  getProjectState(projectPath: string): PluginState {
    return readJsonOr<PluginState>(stateFilePath(projectPath), {
      schemaVersion: 1,
      plugins: {},
    })
  }

  private static _readState(projectPath: string): PluginState {
    return readJsonOr<PluginState>(stateFilePath(projectPath), {
      schemaVersion: 1,
      plugins: {},
    })
  }

  /**
   * Atomic read → mutate → write of `state.json` under ONE file lock keyed on
   * the state-file path. The read happens INSIDE the lock so concurrent
   * mutators (router install/uninstall racing a rail-spawn verify→_cacheHealth)
   * never overwrite each other's snapshot (BUG-PLUGIN-02/03). The `mutate`
   * callback receives the freshly-read state and may either mutate it in place
   * or return a replacement; returning `false` aborts the write (no-op commit),
   * which lets callers short-circuit when there's nothing to persist.
   */
  private async lockedUpdateState(
    projectPath: string,
    mutate: (state: PluginState) => PluginState | void | false,
  ): Promise<void> {
    fs.mkdirSync(pluginsDir(projectPath), { recursive: true })
    await withFileLock(stateFilePath(projectPath), async () => {
      const state = PluginManager._readState(projectPath)
      const result = mutate(state)
      if (result === false) return
      const next = result === undefined ? state : result
      atomicWriteFileSync(stateFilePath(projectPath), JSON.stringify(next, null, 2) + '\n')
    })
  }

  // ─── Catalog ───────────────────────────────────────────────────────────────

  async listAvailable(
    projectPath: string,
    providerId?: string,
    legacyProviderId?: string,
  ): Promise<PluginCatalogEntry[]> {
    const provider = targetProvider(providerId)
    const primaryProvider = legacyProvider(provider, legacyProviderId)
    const state = this.getProjectState(projectPath)
    const entries: PluginCatalogEntry[] = []

    // Bundled plugins, regardless of install state.
    for (const plugin of this.registry.byName.values()) {
      const m = plugin.manifest
      const stateEntry = state.plugins[m.name] as PluginStateEntryWithOwned | undefined
      const providerState = getProviderState(stateEntry, provider, primaryProvider)
      let status: PluginCatalogEntry['status']

      // Provider applicability: a plugin is `not-applicable` when the
      // project's provider is registered, providerSupport is declared, and
      // there's no entry for this provider. Plugins that don't declare
      // providerSupport at all default to claude-compatible (preserves
      // pre-§14 behaviour for unchanged manifests).
      const supportsThisProvider = supportsProvider(plugin, provider)

      if (!supportsThisProvider) {
        status = 'not-applicable'
      } else if (!providerState) {
        status = 'not-installed'
      } else if (providerState.health === 'degraded') {
        status = 'degraded'
      } else if (providerState.active === false) {
        status = 'deactivated'
      } else {
        // Plugin install lives in two files:
        //   (a) state.json — the app's record that the plugin is installed
        //   (b) .mcp.json  — the actual contract with Claude (loaded blindly)
        // Active = both present. Deactivated = (a) without the (b) keys
        // (user toggled off; install survives). For codex projects the
        // (b) check is skipped because the registration lives outside the
        // project filesystem (CODEX_HOME).
        let allKeysPresent = true
        if (hasAdapter(provider) && getAdapter(provider).mcpRegistration === 'cli-add') {
          // For codex we trust state.json — `codex mcp list` against the
          // per-project CODEX_HOME is the source of truth, but it requires a
          // subprocess which is too expensive for a catalog listing call.
          allKeysPresent = true
        } else {
          const mcpServers = readMcpServersMap(projectPath, provider)
          for (const server of m.owns.mcpServers ?? []) {
            if (!(server in mcpServers)) { allKeysPresent = false; break }
          }
        }
        status = allKeysPresent ? 'installed' : 'deactivated'
      }
      // Surface marketplace conflicts so UI can offer a "Disable global"
      // affordance when our project-scoped install is being shadowed.
      const conflicts: string[] = []
      const cachedDisabled: string[] = []
      if (provider === 'claude') {
        for (const server of m.owns.mcpServers ?? []) {
          for (const key of findEnabledMarketplaceKeys(server)) {
            if (!conflicts.includes(key)) conflicts.push(key)
          }
          for (const key of findInstalledButNotEnabledMarketplaceKeys(server)) {
            if (!cachedDisabled.includes(key)) cachedDisabled.push(key)
          }
        }
      }
      // Drift detection: only meaningful when actually installed.
      const updateAvailable = providerState
        ? detectMcpDrift(projectPath, plugin, provider)
        : false
      entries.push({
        name: m.name,
        version: m.version,
        description: m.description,
        whatItDoes: m.whatItDoes,
        category: m.category,
        requirements: m.requirements ?? [],
        owns: m.owns,
        status,
        installedAt: providerState?.installedAt,
        health: providerState?.health,
        healthReason: providerState?.healthReason,
        providerId: provider,
        marketplaceConflicts: conflicts.length > 0 ? conflicts : undefined,
        marketplaceCachedButDisabled: cachedDisabled.length > 0 ? cachedDisabled : undefined,
        updateAvailable: updateAvailable || undefined,
      })
    }

    // Orphan plugins: present in state.json but not in the bundled registry.
    for (const [name, entry] of Object.entries(state.plugins)) {
      if (this.registry.byName.has(name)) continue
      const providerState = getProviderState(
        entry as PluginStateEntryWithOwned,
        provider,
        primaryProvider,
      )
      if (!providerState) continue
      entries.push({
        name,
        version: entry.version,
        description: '(plugin no longer bundled)',
        whatItDoes: [],
        requirements: [],
        owns: {},
        status: 'orphan',
        installedAt: providerState.installedAt,
        health: providerState.health,
        healthReason: providerState.healthReason,
        providerId: provider,
      })
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ─── Preview install ───────────────────────────────────────────────────────

  async previewInstall(
    projectPath: string,
    projectId: string,
    name: string,
    providerId?: string,
    slug?: string,
  ): Promise<PluginPreviewResult> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const provider = targetProvider(providerId)
    if (!supportsProvider(plugin, provider)) {
      throw new PluginInstallError(
        `plugin '${name}' is not applicable for provider '${provider}'.`,
      )
    }

    let files: PluginPreviewFileEntry[]
    if (plugin.previewInstall) {
      files = await plugin.previewInstall({
        projectPath,
        projectId,
        providerId: provider,
        slug,
      })
    } else {
      files = this._derivePreviewFiles(projectPath, plugin, provider)
    }

    const requirements = await Promise.all(
      (plugin.manifest.requirements ?? []).map(async (req) => {
        if (this._options.checkPrerequisite) {
          const r = await this._options.checkPrerequisite(req)
          return { name: req.name, ...r }
        }
        return { name: req.name, installed: true, executable: true, meetsMinimum: true }
      }),
    )

    const hostKey = `${process.platform}-${process.arch}`
    const platformNote = plugin.manifest.platformNotes?.[hostKey]

    return {
      pluginName: name,
      files,
      requirements,
      platformNote,
    }
  }

  private _derivePreviewFiles(projectPath: string, plugin: Plugin, providerId?: string): PluginPreviewFileEntry[] {
    const out: PluginPreviewFileEntry[] = []
    const m = plugin.manifest

    // .mcp.json
    if ((m.owns.mcpServers ?? []).length > 0) {
      const mcpFile = providerMcpJsonPath(projectPath, providerId)
      const mcpExists = fs.existsSync(mcpFile)
      out.push({
        path: path.relative(projectPath, mcpFile),
        op: mcpExists ? 'modify' : 'create',
        summary: `+ mcpServers.${(m.owns.mcpServers ?? []).join(', mcpServers.')}`,
      })
    }

    // Agent fragments
    for (const frag of providerId && providerId !== 'claude' ? [] : (m.owns.agentFragments ?? [])) {
      const exists = fs.existsSync(path.join(projectPath, frag))
      out.push({ path: frag, op: exists ? 'modify' : 'create' })
    }

    // Shared-file contributors (CLAUDE.md today, more in the future).
    for (const rel of contributorPaths(plugin, providerId)) {
      const exists = fs.existsSync(path.join(projectPath, rel))
      out.push({
        path: rel,
        op: exists ? 'modify' : 'create',
        summary: `+ <!-- specrails-desktop-managed:${m.name} --> block`,
      })
    }

    // State file
    const stateExists = fs.existsSync(stateFilePath(projectPath))
    out.push({
      path: '.specrails/plugins/state.json',
      op: stateExists ? 'modify' : 'create',
      summary: `+ plugins.${m.name}`,
    })

    return out
  }

  // ─── Install ───────────────────────────────────────────────────────────────

  async install(
    projectPath: string,
    projectId: string,
    name: string,
    broadcast: PluginBroadcast,
    providerId?: string,
    slug?: string,
    legacyProviderId?: string,
  ): Promise<void> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const provider = targetProvider(providerId)
    const primaryProvider = legacyProvider(provider, legacyProviderId)

    // Provider applicability gate: refuse to install a plugin that has no
    // providerSupport entry for this project's provider. Plugins that omit
    // providerSupport altogether default to claude-compatible.
    if (!supportsProvider(plugin, provider)) {
      const declared = plugin.manifest.providerSupport
      throw new PluginInstallError(
        `plugin '${name}' is not applicable for provider '${provider}'. Declared providers: ${
          declared ? Object.keys(declared).join(', ') : LEGACY_PROVIDER
        }.`,
      )
    }

    const state = this.getProjectState(projectPath)
    const existingEntry = state.plugins[name] as PluginStateEntryWithOwned | undefined
    if (getProviderState(existingEntry, provider, primaryProvider)) {
      throw new PluginAlreadyInstalledError(name)
    }

    // Check for ownership conflicts with user-authored `.mcp.json` entries.
    // Only meaningful for `project-json` MCP registration providers (claude
    // today). Codex registers via `codex mcp add` against per-project
    // CODEX_HOME, which the plugin's install path checks via `codex mcp list`.
    const adapter = hasAdapter(provider)
      ? getAdapter(provider)
      : null
    const usesProjectJsonMcp = adapter === null || adapter.mcpRegistration === 'project-json'
    if (usesProjectJsonMcp) {
      const mcpFile = providerMcpJsonPath(projectPath, provider)
      if (fs.existsSync(mcpFile)) {
        const raw = fs.readFileSync(mcpFile, 'utf8')
        let parsed: Record<string, unknown>
        try {
          parsed = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {
          // A hand-edited / broken `.mcp.json` should yield an actionable 409,
          // not an opaque 500 with a raw "Unexpected token" SyntaxError.
          throw new PluginInstallError(
            `cannot install '${name}': '${mcpFile}' is not valid JSON; fix it first.`,
          )
        }
        const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {}
        for (const key of plugin.manifest.owns.mcpServers ?? []) {
          if (key in servers) {
            throw new PluginInstallError(
              `cannot install '${name}': '${mcpFile}' already has a 'mcpServers.${key}' entry. Remove it first.`,
            )
          }
        }
      }
    }

    // Snapshot pre-install state of every file the plugin might touch — we
    // need exact bytes to roll back if install/verify fails.
    const targetPaths = [
      providerMcpJsonPath(projectPath, provider),
      stateFilePath(projectPath),
      ...(provider !== 'claude' ? [] : (plugin.manifest.owns.agentFragments ?? []))
        .map((f) => path.join(projectPath, f)),
      // Include the shared instructions file (CLAUDE.md / AGENTS.md) so a failed
      // install rolls it back too — otherwise an applyContributors write that
      // survives a later failure leaves an orphaned managed block with no state
      // entry, which uninstall can never remove (breaks byte-identical restore).
      ...contributorPaths(plugin, provider).map((rel) => path.join(projectPath, rel)),
    ]
    const preState = new Map<string, Buffer | null>()
    for (const p of targetPaths) {
      preState.set(p, fs.existsSync(p) ? fs.readFileSync(p) : null)
    }

    const installedFiles: string[] = []
    const onLog = (line: string) => {
      const msg: PluginInstallProgressMessage = {
        type: 'plugin.install_progress',
        projectId,
        name,
        providerId: provider,
        line,
        timestamp: new Date().toISOString(),
      }
      broadcast(msg)
    }

    const ctx = {
      projectPath,
      projectId,
      slug,
      providerId: provider,
      recordInstalledFile: (rel: string) => { installedFiles.push(rel) },
      log: onLog,
    }

    try {
      await plugin.install(ctx)

      // Verify immediately. A degraded result also triggers rollback because
      // the spec requires verify-pass before we commit state.
      const verify = await this._runVerify(plugin, projectPath, projectId, provider, slug)
      if (!verify.ok) {
        throw new PluginInstallError(
          `verify failed after install: ${verify.reason ?? 'unknown'}`,
        )
      }

      // Commit: write state.json with the install record. Persist the plugin's
      // owned mcpServers keys (BUG-PLUGIN-04) so a future orphan removal — when
      // the plugin code is gone from the registry — can still surgically strip
      // the merged `.mcp.json` entries instead of leaving them loaded forever.
      const ownedMcpServers = [...(plugin.manifest.owns.mcpServers ?? [])]
      await this.lockedUpdateState(projectPath, (s) => {
        const installedAt = new Date().toISOString()
        const providerEntry: PluginProviderStateEntry = {
          installedAt,
          installedFiles: [...installedFiles],
          active: true,
          health: 'ok',
          ownedMcpServers,
        }
        const current = s.plugins[name] as PluginStateEntryWithOwned | undefined
        if (!current) {
          const entry: PluginStateEntryWithOwned = {
            version: plugin.manifest.version,
            installedAt,
            installedFiles: [...installedFiles],
            health: 'ok',
          }
          if (ownedMcpServers.length > 0) entry.ownedMcpServers = ownedMcpServers
          // A primary-provider-only install stays in the historical shape.
          // The provider map is materialised only when it is required, keeping
          // state byte-compatible for existing single-provider projects.
          if (provider !== primaryProvider) {
            entry.providers = { [provider]: providerEntry }
          }
          s.plugins[name] = entry
          return
        }
        const providerStates = ensureProviderStates(current, primaryProvider)
        if (providerStates[provider]) {
          throw new PluginAlreadyInstalledError(name)
        }
        current.version = plugin.manifest.version
        providerStates[provider] = providerEntry
        syncAggregateState(current)
      })
      // No additional approval write needed: any server in `.mcp.json` loads
      // automatically when Claude opens the project. Install IS active.

      // Apply shared-file contributors (CLAUDE.md block today, more in the
      // future). Each contributor is per-plugin and idempotent.
      const sharedTouched = await applyContributors(plugin, projectPath, provider)
      if (sharedTouched.length > 0) {
        for (const p of sharedTouched) {
          if (!installedFiles.includes(p)) installedFiles.push(p)
        }
        await this.lockedUpdateState(projectPath, (s) => {
          const entry = s.plugins[name] as PluginStateEntryWithOwned | undefined
          if (!entry) return false
          if (!entry.providers && provider === primaryProvider) {
            entry.installedFiles = [...installedFiles]
            return
          }
          const providerState = getProviderState(entry, provider, primaryProvider)
          if (!providerState) return false
          ensureProviderStates(entry, primaryProvider)[provider].installedFiles = [...installedFiles]
          syncAggregateState(entry)
        })
      }
    } catch (err) {
      // Roll back every file we snapshotted. Byte-identical restore.
      for (const [p, bytes] of preState.entries()) {
        try {
          if (bytes === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p)
          } else {
            // Write the raw Buffer (not .toString('utf8')) so a snapshot with
            // non-UTF8 bytes restores byte-for-byte.
            atomicWriteFileSync(p, bytes)
          }
        } catch {
          // Best-effort rollback; any failure here will surface via verify on
          // the next install attempt.
        }
      }
      // For cli-add providers (codex), a successful `codex mcp add` lives in
      // CODEX_HOME, NOT the snapshotted filesystem — the file rollback above
      // can't undo it. Run the plugin's uninstall so a verify-failed codex
      // install leaves no orphaned MCP registration (best-effort).
      if (hasAdapter(provider) && getAdapter(provider).mcpRegistration === 'cli-add') {
        try {
          await plugin.uninstall({
            projectPath, projectId, slug, providerId: provider,
            recordInstalledFile: () => {}, log: onLog,
          })
        } catch { /* best-effort rollback of the codex registration */ }
      }
      throw err instanceof PluginInstallError ? err : new PluginInstallError(
        `install of '${name}' failed: ${(err as Error)?.message ?? String(err)}`,
        err,
      )
    }

    const msg: PluginInstalledMessage = {
      type: 'plugin.installed',
      projectId,
      name,
      version: plugin.manifest.version,
      providerId: provider,
      timestamp: new Date().toISOString(),
    }
    broadcast(msg)
  }

  // ─── Uninstall ─────────────────────────────────────────────────────────────

  async uninstall(
    projectPath: string,
    projectId: string,
    name: string,
    broadcast: PluginBroadcast,
    providerId?: string,
    slug?: string,
    legacyProviderId?: string,
  ): Promise<void> {
    const provider = targetProvider(providerId)
    const primaryProvider = legacyProvider(provider, legacyProviderId)
    const state = this.getProjectState(projectPath)
    const entry = state.plugins[name] as PluginStateEntryWithOwned | undefined
    const providerState = getProviderState(entry, provider, primaryProvider)
    if (!entry || !providerState) throw new PluginNotInstalledError(name)

    const plugin = this.registry.byName.get(name)
    const onLog = (line: string) => {
      broadcast({
        type: 'plugin.install_progress',
        projectId,
        name,
        providerId: provider,
        line,
        timestamp: new Date().toISOString(),
      } as PluginInstallProgressMessage)
    }

    if (plugin) {
      // Revert provider instruction contributors first so a partial uninstall doesn't
      // leave dangling instructions referencing missing tools.
      if (!hasOtherActiveContributor(entry, provider)) {
        await revertContributors(plugin, projectPath, provider)
      }
      await plugin.uninstall({
        projectPath,
        projectId,
        slug,
        providerId: provider,
        recordInstalledFile: () => {},
        log: onLog,
      })
    } else {
      // Orphan removal: no plugin code available. Best-effort cleanup of
      // recorded installedFiles + drop the state entry. The plugin's owned
      // mcpServers keys were persisted in state at install time (BUG-PLUGIN-04),
      // so even with the plugin code gone we can surgically strip the merged
      // `.mcp.json` entries instead of leaving them loaded by Claude forever.
      const ownedMcpServers = providerState.ownedMcpServers ?? []
      if (ownedMcpServers.length > 0) {
        try {
          await PluginManager.removeMcpServers(projectPath, ownedMcpServers, provider)
        } catch { /* best-effort: leave .mcp.json untouched on failure */ }
      }
      const root = path.resolve(projectPath)
      const remainingFiles = new Set(
        Object.entries(entry.providers ?? {})
          .filter(([candidate]) => candidate !== provider)
          .flatMap(([, candidateState]) => candidateState.installedFiles ?? []),
      )
      for (const rel of providerState.installedFiles ?? []) {
        // A managed contributor path may be referenced by more than one
        // provider. Never unlink a file still owned by another provider install.
        if (remainingFiles.has(rel)) continue
        const abs = path.resolve(projectPath, rel)
        // M5: installedFiles comes from state.json, which a hostile repo can
        // ship. Without containment, `rel` of "../../../Users/victim/x" (or an
        // absolute path) turns orphan removal into an arbitrary-file-deletion
        // primitive. Skip anything that resolves outside the project root.
        const within = path.relative(root, abs)
        if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
          console.warn(`[plugin-manager] skipping out-of-project installedFile during orphan removal: ${rel}`)
          continue
        }
        try { if (fs.existsSync(abs)) fs.unlinkSync(abs) } catch { /* ignore */ }
      }
    }

    await this.lockedUpdateState(projectPath, (s) => {
      const current = s.plugins[name] as PluginStateEntryWithOwned | undefined
      if (!current) return false
      if (!current.providers && provider === primaryProvider) {
        delete s.plugins[name]
        return
      }
      const providers = ensureProviderStates(current, primaryProvider)
      if (!providers[provider]) return false
      delete providers[provider]
      if (Object.keys(providers).length === 0) {
        delete s.plugins[name]
      } else {
        syncAggregateState(current)
      }
    })

    broadcast({
      type: 'plugin.uninstalled',
      projectId,
      name,
      providerId: provider,
      timestamp: new Date().toISOString(),
    } as PluginUninstalledMessage)
  }

  /**
   * Re-write the project's `.mcp.json` entries owned by this plugin to match
   * the bundled manifest's canonical shape. Surgical: only the plugin's
   * `owns.mcpServers` keys are touched; user entries are preserved. Used to
   * resolve drift surfaced by `updateAvailable`.
   */
  async updateMcpEntry(
    projectPath: string,
    projectId: string,
    name: string,
    broadcast: PluginBroadcast,
    providerId?: string,
    slug?: string,
    legacyProviderId?: string,
  ): Promise<void> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const provider = targetProvider(providerId)
    const primaryProvider = legacyProvider(provider, legacyProviderId)
    const state = this.getProjectState(projectPath)
    const entry = state.plugins[name] as PluginStateEntryWithOwned | undefined
    if (!getProviderState(entry, provider, primaryProvider)) {
      throw new PluginNotInstalledError(name)
    }
    const expected = plugin.expectedMcpEntry?.()
    if (!expected) {
      throw new PluginInstallError(`'${name}' does not declare expectedMcpEntry; cannot update`)
    }
    const owned = plugin.manifest.owns.mcpServers ?? []
    if (hasAdapter(provider) && getAdapter(provider).mcpRegistration === 'cli-add') {
      const lifecycle = {
        projectPath,
        projectId,
        slug,
        providerId: provider,
        recordInstalledFile: () => {},
        log: () => {},
      }
      await plugin.uninstall(lifecycle)
      await plugin.install(lifecycle)
    } else {
      const entries: Record<string, unknown> = {}
      for (const key of owned) entries[key] = expected
      await PluginManager.mergeMcpServers(projectPath, entries, provider)
    }
    // Refresh shared-file contributions too: a drift may exist in CLAUDE.md
    // even when the .mcp.json entry matches.
    await applyContributors(plugin, projectPath, provider)
    await this.lockedUpdateState(projectPath, (s) => {
      const current = s.plugins[name] as PluginStateEntryWithOwned | undefined
      if (!current) return false
      if (!current.providers && provider === primaryProvider) {
        current.health = 'unknown'
        delete current.healthReason
        return
      }
      const providerState = getProviderState(current, provider, primaryProvider)
      if (!providerState) return false
      const mutable = ensureProviderStates(current, primaryProvider)[provider]
      mutable.health = 'unknown'
      delete mutable.healthReason
      syncAggregateState(current)
    })
    broadcast({
      type: 'plugin.health_changed',
      projectId,
      name,
      providerId: provider,
      status: 'unknown',
      reason: 'updated',
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Toggle a plugin between active and deactivated. Reality of Claude's MCP
   * loading: any server present in `<project>/.mcp.json` is loaded by Claude
   * regardless of `enabledMcpjsonServers` flags. So:
   *
   *   - active=true   → re-write the canonical mcpServers entry (from the
   *                     plugin's `expectedMcpEntry`) into `.mcp.json`
   *   - active=false  → remove only the owned mcpServers keys; preserve
   *                     state.json so `installed` memory survives, and
   *                     preserve any user-authored sibling entries
   *
   * Plugin install state survives across toggles. Uninstall is the only
   * action that clears state.json + custom-*.md fragments.
   */
  async setActive(
    projectPath: string,
    projectId: string,
    name: string,
    active: boolean,
    broadcast: PluginBroadcast,
    providerId?: string,
    slug?: string,
    legacyProviderId?: string,
  ): Promise<void> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const provider = targetProvider(providerId)
    const primaryProvider = legacyProvider(provider, legacyProviderId)
    const state = this.getProjectState(projectPath)
    const entry = state.plugins[name] as PluginStateEntryWithOwned | undefined
    if (!entry || !getProviderState(entry, provider, primaryProvider)) {
      throw new PluginNotInstalledError(name)
    }

    const owned = plugin.manifest.owns.mcpServers ?? []
    if (owned.length === 0) {
      throw new PluginInstallError(`'${name}' owns no mcpServers; cannot toggle activation`)
    }

    if (active) {
      const expected = plugin.expectedMcpEntry?.()
      if (!expected) {
        throw new PluginInstallError(`'${name}' does not declare expectedMcpEntry; cannot activate`)
      }
      if (hasAdapter(provider) && getAdapter(provider).mcpRegistration === 'cli-add') {
        await plugin.install({
          projectPath,
          projectId,
          slug,
          providerId: provider,
          recordInstalledFile: () => {},
          log: () => {},
        })
      } else {
        const entries: Record<string, unknown> = {}
        for (const k of owned) entries[k] = expected
        await PluginManager.mergeMcpServers(projectPath, entries, provider)
      }
      await applyContributors(plugin, projectPath, provider)
    } else {
      if (hasAdapter(provider) && getAdapter(provider).mcpRegistration === 'cli-add') {
        await plugin.uninstall({
          projectPath,
          projectId,
          slug,
          providerId: provider,
          recordInstalledFile: () => {},
          log: () => {},
        })
      } else {
        await PluginManager.removeMcpServers(projectPath, owned, provider)
      }
      if (!hasOtherActiveContributor(entry, provider)) {
        await revertContributors(plugin, projectPath, provider)
      }
    }

    await this.lockedUpdateState(projectPath, (s) => {
      const current = s.plugins[name] as PluginStateEntryWithOwned | undefined
      if (!current) return false
      if (!current.providers && provider === primaryProvider) {
        // Legacy state has no explicit active field. Materialise only when a
        // value is needed, preserving legacy reads while making the toggle
        // durable.
        const providerState = ensureProviderStates(current, primaryProvider)[provider]
        providerState.active = active
        providerState.health = active ? 'ok' : 'unknown'
        delete providerState.healthReason
        syncAggregateState(current)
        return
      }
      const providerState = getProviderState(current, provider, primaryProvider)
      if (!providerState) return false
      const mutable = ensureProviderStates(current, primaryProvider)[provider]
      mutable.active = active
      mutable.health = active ? 'ok' : 'unknown'
      delete mutable.healthReason
      syncAggregateState(current)
    })
    broadcast({
      type: 'plugin.health_changed',
      projectId,
      name,
      providerId: provider,
      status: active ? 'ok' : 'unknown',
      reason: active ? 'activated' : 'deactivated',
      timestamp: new Date().toISOString(),
    })
  }

  /** Drop a state.json entry for a plugin no longer in the registry. */
  async removeOrphan(
    projectPath: string,
    projectId: string,
    name: string,
    broadcast: PluginBroadcast,
    providerId?: string,
    slug?: string,
    legacyProviderId?: string,
  ): Promise<void> {
    if (this.registry.byName.has(name)) {
      throw new PluginInstallError(`'${name}' is not orphan; it is still bundled. Use uninstall instead.`)
    }
    return this.uninstall(
      projectPath,
      projectId,
      name,
      broadcast,
      providerId,
      slug,
      legacyProviderId,
    )
  }

  // ─── Verify ────────────────────────────────────────────────────────────────

  async verify(
    projectPath: string,
    projectId: string,
    name: string,
    broadcast?: PluginBroadcast,
    providerId?: string,
    legacyProviderId?: string,
    slug?: string,
  ): Promise<PluginVerifyResult> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const provider = targetProvider(providerId)
    const primaryProvider = legacyProvider(provider, legacyProviderId)
    const result = await this._runVerify(plugin, projectPath, projectId, provider, slug)
    await this._cacheHealth(
      projectPath,
      projectId,
      name,
      result,
      broadcast,
      provider,
      primaryProvider,
    )
    return result
  }

  private async _runVerify(
    plugin: Plugin,
    projectPath: string,
    projectId: string,
    providerId?: string,
    slug?: string,
  ): Promise<PluginVerifyResult> {
    const timeout = plugin.manifest.verifyTimeoutMs ?? this._options.defaultVerifyTimeoutMs
    const checkedAt = new Date().toISOString()
    try {
      const result = await Promise.race<PluginVerifyResult | { __timeout: true }>([
        plugin.verify({ projectPath, projectId, providerId, slug }),
        new Promise<{ __timeout: true }>((resolve) =>
          setTimeout(() => resolve({ __timeout: true }), timeout).unref?.(),
        ),
      ])
      if ('__timeout' in result) {
        return { ok: false, reason: 'verify-timeout', checkedAt }
      }
      return { ok: result.ok, reason: result.reason, checkedAt: result.checkedAt ?? checkedAt }
    } catch (err) {
      return { ok: false, reason: `verify-exception: ${(err as Error)?.message ?? String(err)}`, checkedAt }
    }
  }

  private async _cacheHealth(
    projectPath: string,
    projectId: string,
    name: string,
    result: PluginVerifyResult,
    broadcast?: PluginBroadcast,
    providerId?: string,
    legacyProviderId?: string,
  ): Promise<void> {
    const provider = targetProvider(providerId)
    const primaryProvider = legacyProvider(provider, legacyProviderId)
    const newHealth: PluginStateEntry['health'] = result.ok ? 'ok' : 'degraded'
    // Read → compare → write under ONE lock so concurrent verifies on the same
    // project (resolvePluginsForSpawn runs every installed plugin's verify in
    // parallel — BUG-PLUGIN-03) never read the same start state and clobber each
    // other's health update (last-writer-wins). lockedUpdateState re-reads the
    // freshest state inside the lock; returning false skips the write entirely.
    let didChange = false
    await this.lockedUpdateState(projectPath, (state) => {
      const entry = state.plugins[name] as PluginStateEntryWithOwned | undefined
      if (!entry) return false
      const providerState = getProviderState(entry, provider, primaryProvider)
      if (!providerState) return false
      const changed = providerState.health !== newHealth || providerState.healthReason !== result.reason
      if (!changed) return false // nothing to persist — avoids per-spawn write churn (verify runs on every rail spawn)
      if (!entry.providers && provider === primaryProvider) {
        entry.health = newHealth
        entry.healthReason = result.reason
      } else {
        const mutable = ensureProviderStates(entry, primaryProvider)[provider]
        mutable.health = newHealth
        mutable.healthReason = result.reason
        syncAggregateState(entry)
      }
      didChange = true
    })
    if (!didChange) return
    if (broadcast) {
      const msg: PluginHealthChangedMessage = {
        type: 'plugin.health_changed',
        projectId,
        name,
        providerId: provider,
        status: newHealth,
        reason: result.reason,
        timestamp: new Date().toISOString(),
      }
      broadcast(msg)
    }
  }

  // ─── Surgical helpers exposed to plugins ───────────────────────────────────

  /** Helper: surgically merge `mcpServers.<key>` entries into .mcp.json. */
  static async mergeMcpServers(
    projectPath: string,
    entries: Record<string, unknown>,
    providerId?: string,
  ): Promise<void> {
    const mcpFile = providerMcpJsonPath(projectPath, providerId)
    await surgicalMergeJson(mcpFile, (current) => {
      const next = (current ?? {}) as Record<string, unknown>
      // BUG-PLUGIN-05: `mcpServers` MUST be a plain object. The old `?? {}`
      // fallback only covered null/undefined — if it was a JSON array (or any
      // non-object), `servers[key] = v` attaches a non-index property that
      // `JSON.stringify` silently drops, so the plugin records as installed but
      // its MCP entry never lands in `.mcp.json`. Reject with an actionable
      // error so the install surfaces a 409 instead of failing silently.
      const raw = next.mcpServers
      const isPlainObject =
        raw === undefined ||
        raw === null ||
        (typeof raw === 'object' && !Array.isArray(raw))
      if (!isPlainObject) {
        throw new PluginInstallError(
          `cannot merge mcpServers into '${mcpFile}': ` +
            `'mcpServers' must be a JSON object but is ${Array.isArray(raw) ? 'an array' : typeof raw}; fix it first.`,
        )
      }
      const servers = ((raw as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
      for (const [k, v] of Object.entries(entries)) servers[k] = v
      next.mcpServers = servers
      return next
    })
  }

  /** Helper: remove specific `mcpServers.<key>` entries from .mcp.json. */
  static async removeMcpServers(
    projectPath: string,
    keys: string[],
    providerId?: string,
  ): Promise<void> {
    if (keys.length === 0) return
    await surgicalRemoveKeys(
      providerMcpJsonPath(projectPath, providerId),
      keys.map((k) => `mcpServers.${k}`),
    )
  }
}
