import fs from 'fs'
import os from 'os'
import path from 'path'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { DbInstance } from './db'
import profileSchema from './schemas/profile.v1.json'
import { getAdapter, hasAdapter, isModelAvailableForAdapter } from './providers'

// ─── Types ───────────────────────────────────────────────────────────────────

/** A model alias accepted by the profile. JSON schema permits any non-empty
 *  string; the structural validator enforces the per-provider catalog. */
export type ProfileModelAlias = string

export interface ProfileAgent {
  id: string
  model?: ProfileModelAlias
  required?: boolean
}

export interface ProfileRoutingTagRule {
  tags: string[]
  agent: string
}

export interface ProfileRoutingDefaultRule {
  default: true
  agent: string
}

export type ProfileRoutingRule = ProfileRoutingTagRule | ProfileRoutingDefaultRule

export interface Profile {
  schemaVersion: 1
  name: string
  description?: string
  /** Optional provider id. When set the profile's models are validated
   *  against `getAdapter(provider).modelCatalog()`. When omitted the caller
   *  passes `expectedProvider` to the validator (typically the project's
   *  resolved provider). */
  provider?: string
  orchestrator: { model: ProfileModelAlias }
  agents: ProfileAgent[]
  routing: ProfileRoutingRule[]
}

export interface ProfileListEntry {
  name: string
  description?: string
  /** Execution provider this profile belongs to. Legacy unscoped files inherit
   * the caller's fallback provider. */
  provider: string
  isDefault: boolean
  updatedAt: number
}

// ─── Schema loading ──────────────────────────────────────────────────────────

let cachedValidator: ValidateFunction<Profile> | null = null

function getValidator(): ValidateFunction<Profile> {
  if (cachedValidator) return cachedValidator
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  cachedValidator = ajv.compile<Profile>(profileSchema)
  return cachedValidator
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ProfileValidationError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`profile validation failed:\n${errors.map((e) => `  ${e}`).join('\n')}`)
    this.name = 'ProfileValidationError'
    this.errors = errors
  }
}

export class ProfileNotFoundError extends Error {
  constructor(name: string) {
    super(`profile not found: ${name}`)
    this.name = 'ProfileNotFoundError'
  }
}

export class ProfileConflictError extends Error {
  constructor(name: string) {
    super(`profile already exists: ${name}`)
    this.name = 'ProfileConflictError'
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function profilesDir(projectPath: string): string {
  return path.join(projectPath, '.specrails', 'profiles')
}

function legacyProfilePath(projectPath: string, name: string): string {
  return path.join(profilesDir(projectPath), `${name}.json`)
}

/** Provider-scoped filenames allow e.g. Claude and Kimi to both own a logical
 * `default` profile. The JSON body keeps the user-facing name unchanged. */
function scopedProfilePath(projectPath: string, name: string, provider: string): string {
  return path.join(profilesDir(projectPath), `${provider}--${name}.json`)
}

function profileCandidates(projectPath: string, name: string, provider: string): string[] {
  return [
    scopedProfilePath(projectPath, name, provider),
    legacyProfilePath(projectPath, name),
  ]
}

function existingProfilePath(projectPath: string, name: string, provider: string): string | null {
  const [scoped, legacy] = profileCandidates(projectPath, name, provider)
  if (fs.existsSync(scoped)) return scoped
  if (!fs.existsSync(legacy)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8')) as { provider?: unknown }
    // Historical unscoped profiles predate multi-provider support and belong
    // to Claude unless they explicitly declare another provider.
    return typeof raw.provider === 'string'
      ? raw.provider === provider ? legacy : null
      : provider === 'claude' || name === `${provider}-default` ? legacy : null
  } catch {
    // Preserve the editor's ability to surface malformed legacy Claude JSON.
    return provider === 'claude' ? legacy : null
  }
}

function jobSnapshotPath(slug: string, jobId: string): string {
  return path.join(os.homedir(), '.specrails', 'projects', slug, 'jobs', jobId, 'profile.json')
}

// ─── Name validation ─────────────────────────────────────────────────────────

const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/

function assertValidName(name: string): void {
  if (!NAME_REGEX.test(name)) {
    throw new ProfileValidationError([`invalid profile name '${name}' (must match ${NAME_REGEX})`])
  }
  if (name === '.user-preferred') {
    throw new ProfileValidationError(["'.user-preferred' is reserved"])
  }
}

// ─── Structural extra checks (beyond JSON schema) ────────────────────────────

/**
 * Provider-aware structural validation.
 *
 * @param profile   the candidate profile (already JSON-schema-clean)
 * @param expectedProvider the project's resolved provider id when the
 *                  profile itself omits the `provider` field. Defaults to
 *                  `'claude'` so legacy callsites stay backwards compatible.
 */
function validateStructural(profile: Profile, expectedProvider?: string): void {
  const providerId = profile.provider ?? expectedProvider ?? 'claude'
  if (profile.provider && expectedProvider && profile.provider !== expectedProvider) {
    throw new ProfileValidationError([
      `profile provider '${profile.provider}' does not match requested provider '${expectedProvider}'`,
    ])
  }
  if (!hasAdapter(providerId)) {
    throw new ProfileValidationError([
      `profile references unknown provider '${providerId}'`,
    ])
  }
  const adapter = getAdapter(providerId)
  const baseline = adapter.baselineAgents()
  const validModels = new Set(adapter.modelCatalog().map((m) => m.value))

  const agentIds = new Set(profile.agents.map((a) => a.id))

  // Baseline is required on every profile — default and custom alike. The
  // pipeline depends on the baseline agents existing in the chain. The set is
  // adapter-driven so future providers can declare their own baseline.
  const missing = baseline.filter((id) => !agentIds.has(id))
  if (missing.length > 0) {
    throw new ProfileValidationError([
      `profile must include baseline agents for provider '${providerId}': missing ${missing.join(', ')}`,
    ])
  }

  // Orchestrator model must be in the adapter catalog, or a safe configured
  // alias when the adapter explicitly supports them.
  if (!isModelAvailableForAdapter(adapter, profile.orchestrator.model)) {
    throw new ProfileValidationError([
      `orchestrator.model '${profile.orchestrator.model}' is not valid for provider '${providerId}'. Valid models: ${[...validModels].join(', ')}`,
    ])
  }

  // Per-agent model (when set) must also be in the catalog.
  for (const agent of profile.agents) {
    if (
      agent.model !== undefined
      && !isModelAvailableForAdapter(adapter, agent.model)
    ) {
      throw new ProfileValidationError([
        `agent '${agent.id}' uses model '${agent.model}' which is not valid for provider '${providerId}'. Valid models: ${[...validModels].join(', ')}`,
      ])
    }
  }

  // Routing: at most one default rule, last if present, targets must exist.
  const defaults = profile.routing.filter((r): r is ProfileRoutingDefaultRule =>
    'default' in r && r.default === true,
  )
  if (defaults.length > 1) {
    throw new ProfileValidationError([
      `routing may contain at most one entry with 'default: true' (found ${defaults.length})`,
    ])
  }
  if (defaults.length === 1 && profile.routing.length > 0) {
    const last = profile.routing[profile.routing.length - 1]
    if (!('default' in last) || last.default !== true) {
      throw new ProfileValidationError([
        "when a 'default: true' routing rule exists it must be the last element of 'routing'",
      ])
    }
  }
  // Pipeline's last-resort fallback is owned by the core developer agent.
  // Retargeting it would let custom agents silently swallow every untagged
  // task; app UI hides the control, server check is the enforcement.
  if (defaults.length === 1 && defaults[0].agent !== 'sr-developer') {
    throw new ProfileValidationError([
      "default routing rule must target 'sr-developer' (got '" + defaults[0].agent + "')",
    ])
  }
  for (const rule of profile.routing) {
    if (!agentIds.has(rule.agent)) {
      throw new ProfileValidationError([
        `routing references agent '${rule.agent}' which is not in this profile's chain`,
      ])
    }
  }
}

export function validateProfile(raw: unknown, expectedProvider?: string): Profile {
  const validate = getValidator()
  if (!validate(raw)) {
    const msgs = (validate.errors || []).map(
      (e) => `${e.instancePath || '/'} ${e.message} (${JSON.stringify(e.params)})`,
    )
    throw new ProfileValidationError(msgs)
  }
  const profile = raw as Profile
  validateStructural(profile, expectedProvider)
  return profile
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function listProfiles(projectPath: string, _fallbackProvider: string = 'claude'): ProfileListEntry[] {
  const dir = profilesDir(projectPath)
  if (!fs.existsSync(dir)) return []
  const entries = new Map<string, ProfileListEntry & { scoped: boolean }>()
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    if (file === '.user-preferred.json') continue
    if (file.startsWith('.')) continue
    const full = path.join(dir, file)
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'))
      const stat = fs.statSync(full)
      const name = typeof raw?.name === 'string'
        ? raw.name
        : file.slice(0, -'.json'.length)
      const inferredDefaultProvider = typeof name === 'string'
        ? name.match(/^([a-z0-9][a-z0-9-]*)-default$/)?.[1]
        : undefined
      const provider = typeof raw?.provider === 'string'
        ? raw.provider
        : inferredDefaultProvider && hasAdapter(inferredDefaultProvider)
          ? inferredDefaultProvider
          // Unscoped/provider-less profiles predate multi-provider storage and
          // are Claude profiles regardless of which provider is primary today.
          // Provider defaults such as `kimi-default.json` are handled by the
          // filename inference above. Keeping this aligned with
          // existingProfilePath prevents a Kimi-primary project from listing a
          // legacy Claude `project-default` as Kimi and then returning 404 when
          // it is opened.
          : 'claude'
      const scoped = file === `${provider}--${name}.json`
      const key = `${provider}\0${name}`
      const candidate = {
        name,
        description: typeof raw?.description === 'string' ? raw.description : undefined,
        provider,
        isDefault:
          name === 'default'
          || name === 'project-default'
          || name === `${provider}-default`,
        updatedAt: Math.floor(stat.mtimeMs),
        scoped,
      }
      // Prefer the provider-scoped file over a stale legacy duplicate.
      if (!entries.has(key) || scoped) entries.set(key, candidate)
    } catch {
      // Skip unparseable files silently; the caller can surface via getProfile.
    }
  }
  return [...entries.values()]
    .map(({ scoped: _scoped, ...entry }) => entry)
    .sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider))
}

export function getProfile(projectPath: string, name: string, expectedProvider: string = 'claude'): Profile {
  assertValidName(name)
  const full = existingProfilePath(projectPath, name, expectedProvider)
  if (!full) throw new ProfileNotFoundError(name)
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'))
  return validateProfile(raw, expectedProvider)
}

/**
 * Non-validating read for the editor: returns the parsed profile body plus any
 * schema/structural validation errors (instead of throwing). A profile that
 * became invalid against the current agent catalog must still be openable so the
 * user can repair it — `getProfile` would throw and lock it out. JSON-parse
 * errors still throw (unrepairable in the editor). `validateProfile` remains the
 * gate on create/update/launch.
 */
export function getProfileRaw(
  projectPath: string,
  name: string,
  expectedProvider: string = 'claude',
): { profile: unknown; valid: boolean; errors: string[] } {
  assertValidName(name)
  const full = existingProfilePath(projectPath, name, expectedProvider)
  if (!full) throw new ProfileNotFoundError(name)
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'))
  try {
    validateProfile(raw, expectedProvider)
    return { profile: raw, valid: true, errors: [] }
  } catch (err) {
    const errors = err instanceof ProfileValidationError ? err.errors : [(err as Error).message]
    return { profile: raw, valid: false, errors }
  }
}

export function createProfile(projectPath: string, profile: Profile, expectedProvider: string = 'claude'): void {
  assertValidName(profile.name)
  validateProfile(profile, expectedProvider)
  const provider = profile.provider ?? expectedProvider
  const full = profile.provider || expectedProvider !== 'claude'
    ? scopedProfilePath(projectPath, profile.name, provider)
    : legacyProfilePath(projectPath, profile.name)
  // Core may already own a provider-specific default in the historical
  // unscoped shape (for example `kimi-default.json`). Treat that as the same
  // logical profile as Desktop's collision-safe `kimi--kimi-default.json`;
  // otherwise POST would silently create two defaults. `updateProfile` remains
  // the explicit migration path from legacy to scoped storage.
  if (existingProfilePath(projectPath, profile.name, provider)) {
    throw new ProfileConflictError(profile.name)
  }
  fs.mkdirSync(profilesDir(projectPath), { recursive: true })
  fs.writeFileSync(full, JSON.stringify(profile, null, 2) + '\n', 'utf8')
}

export function updateProfile(projectPath: string, profile: Profile, expectedProvider: string = 'claude'): void {
  assertValidName(profile.name)
  validateProfile(profile, expectedProvider)
  const provider = profile.provider ?? expectedProvider
  const existing = existingProfilePath(projectPath, profile.name, provider)
  if (!existing) throw new ProfileNotFoundError(profile.name)
  const destination = profile.provider || expectedProvider !== 'claude'
    ? scopedProfilePath(projectPath, profile.name, provider)
    : existing
  fs.writeFileSync(destination, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  // Updating a legacy provider-stamped file migrates it to the collision-safe
  // scoped filename after the replacement is durably visible.
  if (destination !== existing && fs.existsSync(existing)) fs.unlinkSync(existing)
}

export function deleteProfile(projectPath: string, name: string, expectedProvider: string = 'claude'): void {
  assertValidName(name)
  if (
    name === 'default'
    || name === 'project-default'
    || name === `${expectedProvider}-default`
  ) {
    throw new ProfileValidationError(['cannot delete the default profile'])
  }
  const full = existingProfilePath(projectPath, name, expectedProvider)
  if (!full) throw new ProfileNotFoundError(name)
  fs.unlinkSync(full)
}

export function duplicateProfile(
  projectPath: string,
  sourceName: string,
  newName: string,
  expectedProvider: string = 'claude',
): Profile {
  const source = getProfile(projectPath, sourceName, expectedProvider)
  const copy: Profile = { ...source, name: newName }
  createProfile(projectPath, copy, expectedProvider)
  return copy
}

export function renameProfile(
  projectPath: string,
  fromName: string,
  toName: string,
  expectedProvider: string = 'claude',
): Profile {
  // Renaming the default away would leave no default → resolveProfile returns
  // null and rails silently drop to legacy/no-profile mode. Mirror deleteProfile.
  if (
    fromName === 'default'
    || fromName === 'project-default'
    || fromName === `${expectedProvider}-default`
  ) {
    throw new ProfileValidationError(['cannot rename the default profile'])
  }
  const source = getProfile(projectPath, fromName, expectedProvider)
  assertValidName(toName)
  if (
    toName === 'default'
    || toName === 'project-default'
    || toName === `${expectedProvider}-default`
  ) {
    throw new ProfileValidationError(['cannot rename a profile to a reserved default name'])
  }
  const provider = source.provider ?? expectedProvider
  const sourcePath = existingProfilePath(projectPath, fromName, provider)
  if (!sourcePath) throw new ProfileNotFoundError(fromName)
  const dest = source.provider || expectedProvider !== 'claude'
    ? scopedProfilePath(projectPath, toName, provider)
    : legacyProfilePath(projectPath, toName)
  // Collision is logical, not just destination-path based: a Core-authored
  // legacy `<name>.json` may already represent this provider even when Desktop
  // would publish the renamed profile as `<provider>--<name>.json`.
  if (existingProfilePath(projectPath, toName, provider)) {
    throw new ProfileConflictError(toName)
  }
  const renamed: Profile = { ...source, name: toName }
  validateProfile(renamed, expectedProvider)
  // Atomic publish: write to a temp file in the same dir, fsync-rename into
  // place, THEN remove the old file. A crash/unlink failure can no longer
  // leave both files on disk (which listProfiles would surface as duplicates).
  const tmp = `${dest}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(renamed, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, dest)
  try {
    fs.unlinkSync(sourcePath)
  } catch {
    // The new file is fully published; a stale source is at worst a transient
    // duplicate, never data loss.
  }
  return renamed
}

// ─── Resolution (pick which profile applies for an invocation) ───────────────

export interface ResolvedProfile {
  name: string
  profile: Profile
}

/**
 * Resolve the profile to snapshot for a new rail invocation.
 *
 * Precedence:
 *   1. Explicit selection passed by the caller (launch-dialog override).
 *   2. The profile named `default` (or `project-default`).
 *
 * Returns `null` if the project has no profiles and no fallback — the caller
 * should treat this as legacy mode (do not inject `SPECRAILS_PROFILE_PATH`).
 */
export function resolveProfile(
  projectPath: string,
  explicit?: string | null,
  expectedProvider: string = 'claude',
): ResolvedProfile | null {
  const tryName = (n: string): ResolvedProfile | null => {
    try {
      return { name: n, profile: getProfile(projectPath, n, expectedProvider) }
    } catch (e) {
      if (e instanceof ProfileNotFoundError) return null
      throw e
    }
  }

  if (explicit) {
    const resolved = tryName(explicit)
    if (resolved) return resolved
    throw new ProfileNotFoundError(explicit)
  }

  const fallbacks = expectedProvider === 'claude'
    ? ['default', 'project-default']
    : [`${expectedProvider}-default`, 'default', 'project-default']
  for (const fallback of fallbacks) {
    try {
      const resolved = tryName(fallback)
      if (resolved) return resolved
    } catch (error) {
      // A legacy unscoped default may belong to another provider. In a mixed
      // project it must not prevent the selected provider from falling through
      // to its own alternate default (or legacy mode).
      if (!(error instanceof ProfileValidationError)) throw error
    }
  }
  return null
}

// ─── Snapshot-per-job ────────────────────────────────────────────────────────

/**
 * Write the resolved profile's bytes to a job-scoped snapshot. The snapshot
 * is chmod-400 so mid-run edits are impossible. Returns the absolute path;
 * the caller must set `SPECRAILS_PROFILE_PATH` in the spawn env.
 */
export function snapshotForJob(
  slug: string,
  jobId: string,
  resolved: ResolvedProfile,
): string {
  const snapshotPath = jobSnapshotPath(slug, jobId)
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
  const body = JSON.stringify(resolved.profile, null, 2) + '\n'
  fs.writeFileSync(snapshotPath, body, { encoding: 'utf8', mode: 0o400 })
  return snapshotPath
}

/**
 * Persist job → profile in the per-project SQLite so Analytics can report
 * and so the snapshot survives filesystem mishaps.
 */
export function persistJobProfile(
  db: DbInstance,
  jobId: string,
  resolved: ResolvedProfile,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO job_profiles (job_id, profile_name, profile_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(jobId, resolved.name, JSON.stringify(resolved.profile), Date.now())
}
