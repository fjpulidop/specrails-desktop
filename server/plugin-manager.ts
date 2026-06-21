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

function readMcpServersMap(projectPath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(mcpJsonPath(projectPath))) return {}
    const raw = fs.readFileSync(mcpJsonPath(projectPath), 'utf8')
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

  async listAvailable(projectPath: string, providerId?: string): Promise<PluginCatalogEntry[]> {
    const state = this.getProjectState(projectPath)
    const entries: PluginCatalogEntry[] = []

    // Bundled plugins, regardless of install state.
    for (const plugin of this.registry.byName.values()) {
      const m = plugin.manifest
      const stateEntry = state.plugins[m.name]
      let status: PluginCatalogEntry['status']

      // Provider applicability: a plugin is `not-applicable` when the
      // project's provider is registered, providerSupport is declared, and
      // there's no entry for this provider. Plugins that don't declare
      // providerSupport at all default to claude-compatible (preserves
      // pre-§14 behaviour for unchanged manifests).
      const supportsThisProvider = providerId === undefined
        ? true
        : m.providerSupport === undefined
          ? providerId === 'claude'
          : providerId in m.providerSupport

      if (!supportsThisProvider) {
        status = 'not-applicable'
      } else if (!stateEntry) {
        status = 'not-installed'
      } else if (stateEntry.health === 'degraded') {
        status = 'degraded'
      } else {
        // Plugin install lives in two files:
        //   (a) state.json — the app's record that the plugin is installed
        //   (b) .mcp.json  — the actual contract with Claude (loaded blindly)
        // Active = both present. Deactivated = (a) without the (b) keys
        // (user toggled off; install survives). For codex projects the
        // (b) check is skipped because the registration lives outside the
        // project filesystem (CODEX_HOME).
        let allKeysPresent = true
        if (providerId === 'codex') {
          // For codex we trust state.json — `codex mcp list` against the
          // per-project CODEX_HOME is the source of truth, but it requires a
          // subprocess which is too expensive for a catalog listing call.
          allKeysPresent = true
        } else {
          const mcpServers = readMcpServersMap(projectPath)
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
      for (const server of m.owns.mcpServers ?? []) {
        for (const key of findEnabledMarketplaceKeys(server)) {
          if (!conflicts.includes(key)) conflicts.push(key)
        }
        for (const key of findInstalledButNotEnabledMarketplaceKeys(server)) {
          if (!cachedDisabled.includes(key)) cachedDisabled.push(key)
        }
      }
      // Drift detection: only meaningful when actually installed.
      const updateAvailable = stateEntry ? detectMcpDrift(projectPath, plugin) : false
      entries.push({
        name: m.name,
        version: m.version,
        description: m.description,
        whatItDoes: m.whatItDoes,
        category: m.category,
        requirements: m.requirements ?? [],
        owns: m.owns,
        status,
        installedAt: stateEntry?.installedAt,
        health: stateEntry?.health,
        healthReason: stateEntry?.healthReason,
        marketplaceConflicts: conflicts.length > 0 ? conflicts : undefined,
        marketplaceCachedButDisabled: cachedDisabled.length > 0 ? cachedDisabled : undefined,
        updateAvailable: updateAvailable || undefined,
      })
    }

    // Orphan plugins: present in state.json but not in the bundled registry.
    for (const [name, entry] of Object.entries(state.plugins)) {
      if (this.registry.byName.has(name)) continue
      entries.push({
        name,
        version: entry.version,
        description: '(plugin no longer bundled)',
        whatItDoes: [],
        requirements: [],
        owns: {},
        status: 'orphan',
        installedAt: entry.installedAt,
        health: entry.health,
        healthReason: entry.healthReason,
      })
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ─── Preview install ───────────────────────────────────────────────────────

  async previewInstall(
    projectPath: string,
    projectId: string,
    name: string,
  ): Promise<PluginPreviewResult> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)

    let files: PluginPreviewFileEntry[]
    if (plugin.previewInstall) {
      files = await plugin.previewInstall({ projectPath, projectId })
    } else {
      files = this._derivePreviewFiles(projectPath, plugin)
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

  private _derivePreviewFiles(projectPath: string, plugin: Plugin): PluginPreviewFileEntry[] {
    const out: PluginPreviewFileEntry[] = []
    const m = plugin.manifest

    // .mcp.json
    if ((m.owns.mcpServers ?? []).length > 0) {
      const mcpExists = fs.existsSync(mcpJsonPath(projectPath))
      out.push({
        path: '.mcp.json',
        op: mcpExists ? 'modify' : 'create',
        summary: `+ mcpServers.${(m.owns.mcpServers ?? []).join(', mcpServers.')}`,
      })
    }

    // Agent fragments
    for (const frag of m.owns.agentFragments ?? []) {
      const exists = fs.existsSync(path.join(projectPath, frag))
      out.push({ path: frag, op: exists ? 'modify' : 'create' })
    }

    // Shared-file contributors (CLAUDE.md today, more in the future).
    for (const rel of contributorPaths(plugin)) {
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
  ): Promise<void> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)

    // Provider applicability gate: refuse to install a plugin that has no
    // providerSupport entry for this project's provider. Plugins that omit
    // providerSupport altogether default to claude-compatible.
    if (providerId !== undefined && providerId !== 'claude') {
      const declared = plugin.manifest.providerSupport
      if (declared !== undefined && !(providerId in declared)) {
        throw new PluginInstallError(
          `plugin '${name}' is not applicable for provider '${providerId}'. Declared providers: ${Object.keys(declared).join(', ')}.`,
        )
      }
    }

    const state = this.getProjectState(projectPath)
    if (state.plugins[name]) throw new PluginAlreadyInstalledError(name)

    // Check for ownership conflicts with user-authored `.mcp.json` entries.
    // Only meaningful for `project-json` MCP registration providers (claude
    // today). Codex registers via `codex mcp add` against per-project
    // CODEX_HOME, which the plugin's install path checks via `codex mcp list`.
    const adapter = providerId !== undefined && hasAdapter(providerId)
      ? getAdapter(providerId)
      : null
    const usesProjectJsonMcp = adapter === null || adapter.mcpRegistration === 'project-json'
    if (usesProjectJsonMcp) {
      const mcpFile = mcpJsonPath(projectPath)
      if (fs.existsSync(mcpFile)) {
        const raw = fs.readFileSync(mcpFile, 'utf8')
        let parsed: Record<string, unknown>
        try {
          parsed = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {
          // A hand-edited / broken `.mcp.json` should yield an actionable 409,
          // not an opaque 500 with a raw "Unexpected token" SyntaxError.
          throw new PluginInstallError(
            `cannot install '${name}': '${mcpJsonPath(projectPath)}' is not valid JSON; fix it first.`,
          )
        }
        const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {}
        for (const key of plugin.manifest.owns.mcpServers ?? []) {
          if (key in servers) {
            throw new PluginInstallError(
              `cannot install '${name}': '${mcpJsonPath(projectPath)}' already has a 'mcpServers.${key}' entry. Remove it first.`,
            )
          }
        }
      }
    }

    // Snapshot pre-install state of every file the plugin might touch — we
    // need exact bytes to roll back if install/verify fails.
    const targetPaths = [
      mcpJsonPath(projectPath),
      stateFilePath(projectPath),
      ...(plugin.manifest.owns.agentFragments ?? []).map((f) => path.join(projectPath, f)),
      // Include the shared instructions file (CLAUDE.md / AGENTS.md) so a failed
      // install rolls it back too — otherwise an applyContributors write that
      // survives a later failure leaves an orphaned managed block with no state
      // entry, which uninstall can never remove (breaks byte-identical restore).
      ...contributorPaths(plugin, providerId).map((rel) => path.join(projectPath, rel)),
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
        line,
        timestamp: new Date().toISOString(),
      }
      broadcast(msg)
    }

    const ctx = {
      projectPath,
      projectId,
      slug,
      providerId,
      recordInstalledFile: (rel: string) => { installedFiles.push(rel) },
      log: onLog,
    }

    try {
      await plugin.install(ctx)

      // Verify immediately. A degraded result also triggers rollback because
      // the spec requires verify-pass before we commit state.
      const verify = await this._runVerify(plugin, projectPath, projectId)
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
        const entry: PluginStateEntryWithOwned = {
          version: plugin.manifest.version,
          installedAt: new Date().toISOString(),
          installedFiles,
          health: 'ok',
        }
        if (ownedMcpServers.length > 0) entry.ownedMcpServers = ownedMcpServers
        s.plugins[name] = entry
      })
      // No additional approval write needed: any server in `.mcp.json` loads
      // automatically when Claude opens the project. Install IS active.

      // Apply shared-file contributors (CLAUDE.md block today, more in the
      // future). Each contributor is per-plugin and idempotent.
      const sharedTouched = await applyContributors(plugin, projectPath, providerId)
      if (sharedTouched.length > 0) {
        for (const p of sharedTouched) {
          if (!installedFiles.includes(p)) installedFiles.push(p)
        }
        await this.lockedUpdateState(projectPath, (s) => {
          if (s.plugins[name]) s.plugins[name].installedFiles = installedFiles
          else return false
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
      if (providerId && hasAdapter(providerId) && getAdapter(providerId).mcpRegistration === 'cli-add') {
        try {
          await plugin.uninstall({
            projectPath, projectId, slug, providerId,
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
  ): Promise<void> {
    const state = this.getProjectState(projectPath)
    const entry = state.plugins[name]
    if (!entry) throw new PluginNotInstalledError(name)

    const plugin = this.registry.byName.get(name)
    const onLog = (line: string) => {
      broadcast({
        type: 'plugin.install_progress',
        projectId,
        name,
        line,
        timestamp: new Date().toISOString(),
      } as PluginInstallProgressMessage)
    }

    if (plugin) {
      // Revert shared-file contributors first so a partial uninstall doesn't
      // leave dangling instructions referencing missing tools.
      await revertContributors(plugin, projectPath, providerId)
      await plugin.uninstall({
        projectPath,
        projectId,
        slug,
        providerId,
        recordInstalledFile: () => {},
        log: onLog,
      })
    } else {
      // Orphan removal: no plugin code available. Best-effort cleanup of
      // recorded installedFiles + drop the state entry. The plugin's owned
      // mcpServers keys were persisted in state at install time (BUG-PLUGIN-04),
      // so even with the plugin code gone we can surgically strip the merged
      // `.mcp.json` entries instead of leaving them loaded by Claude forever.
      const ownedMcpServers = (entry as PluginStateEntryWithOwned).ownedMcpServers ?? []
      if (ownedMcpServers.length > 0) {
        try {
          await PluginManager.removeMcpServers(projectPath, ownedMcpServers)
        } catch { /* best-effort: leave .mcp.json untouched on failure */ }
      }
      const root = path.resolve(projectPath)
      for (const rel of entry.installedFiles ?? []) {
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
      delete s.plugins[name]
    })

    broadcast({
      type: 'plugin.uninstalled',
      projectId,
      name,
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
  ): Promise<void> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const state = this.getProjectState(projectPath)
    if (!state.plugins[name]) throw new PluginNotInstalledError(name)
    const expected = plugin.expectedMcpEntry?.()
    if (!expected) {
      throw new PluginInstallError(`'${name}' does not declare expectedMcpEntry; cannot update`)
    }
    const owned = plugin.manifest.owns.mcpServers ?? []
    const entries: Record<string, unknown> = {}
    for (const key of owned) entries[key] = expected
    await PluginManager.mergeMcpServers(projectPath, entries)
    // Refresh shared-file contributions too: a drift may exist in CLAUDE.md
    // even when the .mcp.json entry matches.
    await applyContributors(plugin, projectPath, providerId)
    broadcast({
      type: 'plugin.health_changed',
      projectId,
      name,
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
  ): Promise<void> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const state = this.getProjectState(projectPath)
    if (!state.plugins[name]) throw new PluginNotInstalledError(name)

    const owned = plugin.manifest.owns.mcpServers ?? []
    if (owned.length === 0) {
      throw new PluginInstallError(`'${name}' owns no mcpServers; cannot toggle activation`)
    }

    if (active) {
      const expected = plugin.expectedMcpEntry?.()
      if (!expected) {
        throw new PluginInstallError(`'${name}' does not declare expectedMcpEntry; cannot activate`)
      }
      const entries: Record<string, unknown> = {}
      for (const k of owned) entries[k] = expected
      await PluginManager.mergeMcpServers(projectPath, entries)
      await applyContributors(plugin, projectPath, providerId)
    } else {
      await PluginManager.removeMcpServers(projectPath, owned)
      await revertContributors(plugin, projectPath, providerId)
    }

    broadcast({
      type: 'plugin.health_changed',
      projectId,
      name,
      status: active ? 'ok' : 'unknown',
      reason: active ? 'activated' : 'deactivated',
      timestamp: new Date().toISOString(),
    })
  }

  /** Drop a state.json entry for a plugin no longer in the registry. */
  async removeOrphan(projectPath: string, projectId: string, name: string, broadcast: PluginBroadcast): Promise<void> {
    if (this.registry.byName.has(name)) {
      throw new PluginInstallError(`'${name}' is not orphan; it is still bundled. Use uninstall instead.`)
    }
    return this.uninstall(projectPath, projectId, name, broadcast)
  }

  // ─── Verify ────────────────────────────────────────────────────────────────

  async verify(
    projectPath: string,
    projectId: string,
    name: string,
    broadcast?: PluginBroadcast,
  ): Promise<PluginVerifyResult> {
    const plugin = this.registry.byName.get(name)
    if (!plugin) throw new PluginNotFoundError(name)
    const result = await this._runVerify(plugin, projectPath, projectId)
    await this._cacheHealth(projectPath, projectId, name, result, broadcast)
    return result
  }

  private async _runVerify(
    plugin: Plugin,
    projectPath: string,
    projectId: string,
  ): Promise<PluginVerifyResult> {
    const timeout = plugin.manifest.verifyTimeoutMs ?? this._options.defaultVerifyTimeoutMs
    const checkedAt = new Date().toISOString()
    try {
      const result = await Promise.race<PluginVerifyResult | { __timeout: true }>([
        plugin.verify({ projectPath, projectId }),
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
  ): Promise<void> {
    const newHealth: PluginStateEntry['health'] = result.ok ? 'ok' : 'degraded'
    // Read → compare → write under ONE lock so concurrent verifies on the same
    // project (resolvePluginsForSpawn runs every installed plugin's verify in
    // parallel — BUG-PLUGIN-03) never read the same start state and clobber each
    // other's health update (last-writer-wins). lockedUpdateState re-reads the
    // freshest state inside the lock; returning false skips the write entirely.
    let didChange = false
    await this.lockedUpdateState(projectPath, (state) => {
      const entry = state.plugins[name]
      if (!entry) return false
      const changed = entry.health !== newHealth || entry.healthReason !== result.reason
      if (!changed) return false // nothing to persist — avoids per-spawn write churn (verify runs on every rail spawn)
      entry.health = newHealth
      entry.healthReason = result.reason
      didChange = true
    })
    if (!didChange) return
    if (broadcast) {
      const msg: PluginHealthChangedMessage = {
        type: 'plugin.health_changed',
        projectId,
        name,
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
  ): Promise<void> {
    await surgicalMergeJson(mcpJsonPath(projectPath), (current) => {
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
          `cannot merge mcpServers into '${mcpJsonPath(projectPath)}': ` +
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
  ): Promise<void> {
    if (keys.length === 0) return
    await surgicalRemoveKeys(
      mcpJsonPath(projectPath),
      keys.map((k) => `mcpServers.${k}`),
    )
  }
}
