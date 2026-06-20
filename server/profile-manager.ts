import fs from 'fs'
import os from 'os'
import path from 'path'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { DbInstance } from './db'
import profileSchema from './schemas/profile.v1.json'
import { getAdapter, hasAdapter } from './providers'

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

function profilePath(projectPath: string, name: string): string {
  return path.join(profilesDir(projectPath), `${name}.json`)
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
function validateStructural(profile: Profile, expectedProvider: string = 'claude'): void {
  const providerId = profile.provider ?? expectedProvider
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

  // Orchestrator model must be in the adapter's catalog.
  if (!validModels.has(profile.orchestrator.model)) {
    throw new ProfileValidationError([
      `orchestrator.model '${profile.orchestrator.model}' is not valid for provider '${providerId}'. Valid models: ${[...validModels].join(', ')}`,
    ])
  }

  // Per-agent model (when set) must also be in the catalog.
  for (const agent of profile.agents) {
    if (agent.model !== undefined && !validModels.has(agent.model)) {
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

export function validateProfile(raw: unknown, expectedProvider: string = 'claude'): Profile {
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

export function listProfiles(projectPath: string): ProfileListEntry[] {
  const dir = profilesDir(projectPath)
  if (!fs.existsSync(dir)) return []
  const entries: ProfileListEntry[] = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    if (file === '.user-preferred.json') continue
    if (file.startsWith('.')) continue
    const name = file.slice(0, -'.json'.length)
    const full = path.join(dir, file)
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'))
      const stat = fs.statSync(full)
      entries.push({
        name,
        description: typeof raw?.description === 'string' ? raw.description : undefined,
        isDefault: name === 'default' || name === 'project-default',
        updatedAt: Math.floor(stat.mtimeMs),
      })
    } catch {
      // Skip unparseable files silently; the caller can surface via getProfile.
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export function getProfile(projectPath: string, name: string, expectedProvider: string = 'claude'): Profile {
  assertValidName(name)
  const full = profilePath(projectPath, name)
  if (!fs.existsSync(full)) {
    throw new ProfileNotFoundError(name)
  }
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
  const full = profilePath(projectPath, name)
  if (!fs.existsSync(full)) {
    throw new ProfileNotFoundError(name)
  }
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
  const full = profilePath(projectPath, profile.name)
  if (fs.existsSync(full)) {
    throw new ProfileConflictError(profile.name)
  }
  fs.mkdirSync(profilesDir(projectPath), { recursive: true })
  fs.writeFileSync(full, JSON.stringify(profile, null, 2) + '\n', 'utf8')
}

export function updateProfile(projectPath: string, profile: Profile, expectedProvider: string = 'claude'): void {
  assertValidName(profile.name)
  validateProfile(profile, expectedProvider)
  const full = profilePath(projectPath, profile.name)
  if (!fs.existsSync(full)) {
    throw new ProfileNotFoundError(profile.name)
  }
  fs.writeFileSync(full, JSON.stringify(profile, null, 2) + '\n', 'utf8')
}

export function deleteProfile(projectPath: string, name: string): void {
  assertValidName(name)
  if (name === 'default' || name === 'project-default') {
    throw new ProfileValidationError(['cannot delete the default profile'])
  }
  const full = profilePath(projectPath, name)
  if (!fs.existsSync(full)) {
    throw new ProfileNotFoundError(name)
  }
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
  if (fromName === 'default' || fromName === 'project-default') {
    throw new ProfileValidationError(['cannot rename the default profile'])
  }
  const source = getProfile(projectPath, fromName, expectedProvider)
  assertValidName(toName)
  if (fs.existsSync(profilePath(projectPath, toName))) {
    throw new ProfileConflictError(toName)
  }
  const renamed: Profile = { ...source, name: toName }
  validateProfile(renamed, expectedProvider)
  // Atomic publish: write to a temp file in the same dir, fsync-rename into
  // place, THEN remove the old file. A crash/unlink failure can no longer
  // leave both files on disk (which listProfiles would surface as duplicates).
  const dest = profilePath(projectPath, toName)
  const tmp = `${dest}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(renamed, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, dest)
  try {
    fs.unlinkSync(profilePath(projectPath, fromName))
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

  return tryName('default') ?? tryName('project-default')
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
