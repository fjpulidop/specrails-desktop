import fs from 'fs'
import path from 'path'
import { Router, Request, Response } from 'express'
import type { ProjectContext } from './project-registry'
import { generateCustomAgent, testCustomAgent } from './agent-generator'
import { getRefineSession, listRefineSessionsForAgent } from './agent-refine-db'
import { refineSessionToJson } from './agent-refine-manager'
import { getAdapter, hasAdapter, isModelAvailableForAdapter } from './providers'
import {
  parseKimiSkillDocument,
  validateKimiRoleDocument,
} from './providers/kimi-skill-prompt'
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  getProfile,
  getProfileRaw,
  listProfiles,
  renameProfile,
  resolveProfile,
  updateProfile,
  ProfileConflictError,
  ProfileNotFoundError,
  ProfileValidationError,
  type Profile,
} from './profile-manager'
import { resolveProjectExecution } from './workspace-resolution'
import {
  readAgentModelSelection,
  readAgentModels,
} from './project-router-helpers'

/**
 * Relocate-artifacts gate: the dir whose `.specrails/{profiles,specrails-version}`
 * and provider-native roles catalog the profiles surface reads/writes.
 * Relocated ⇒ the workspace dir (where Core assembled the roles catalog +
 * `.specrails/profiles`); legacy ⇒ project.path (byte-identical to today).
 *
 * The roles catalog MUST follow this same root. Depending on the selected
 * adapter, Core materializes file-based roles such as
 * `<workspace>/.claude/agents/<id>.md`, or skill-based roles such as
 * `<workspace>/.kimi-code/skills/<id>/SKILL.md`. Reading/writing beneath
 * `project.path` would miss the execution catalog and violate repo immutability.
 */
function specRoot(project: { slug: string; path: string }): string {
  const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
  return exec.relocated && exec.workspaceDir ? exec.workspaceDir : project.path
}

type ProviderProject = {
  slug: string
  path: string
  provider?: string | null
  providers?: readonly string[] | null
}

function installedProviders(project: Pick<ProviderProject, 'provider' | 'providers'>): string[] {
  const primary = project.provider ?? 'claude'
  const configured = project.providers?.filter((provider): provider is string => typeof provider === 'string')
  return configured?.length ? [...new Set([primary, ...configured])] : [primary]
}

function requestedProvider(
  req: Request,
  project: Pick<ProviderProject, 'provider' | 'providers'>,
  bodyProvider?: unknown,
): string {
  const queryProvider = typeof req.query.provider === 'string' ? req.query.provider : undefined
  const explicitBodyProvider = typeof bodyProvider === 'string' && bodyProvider.length > 0
    ? bodyProvider
    : undefined
  if (queryProvider && explicitBodyProvider && queryProvider !== explicitBodyProvider) {
    throw new ProfileValidationError([
      `body provider '${explicitBodyProvider}' does not match requested provider '${queryProvider}'`,
    ])
  }
  const provider = queryProvider ?? explicitBodyProvider ?? project.provider ?? 'claude'
  if (!hasAdapter(provider) || !installedProviders(project).includes(provider)) {
    throw new ProfileValidationError([
      `provider '${provider}' is not installed for this project`,
    ])
  }
  return provider
}

function projectAdapter(project: { provider?: string | null }, provider?: string) {
  return getAdapter(provider ?? project.provider ?? 'claude')
}

function agentFile(project: ProviderProject, agentId: string, provider?: string): string {
  const root = specRoot(project)
  const adapter = projectAdapter(project, provider)
  return adapter.customRolePath?.(root, agentId)
    ?? path.join(root, adapter.projectDirName, 'agents', `${agentId}.md`)
}

/** The provider-native roles catalog directory. */
function agentsCatalogDir(project: ProviderProject, provider?: string): string {
  const probe = agentFile(project, '__catalog_probe__', provider)
  // File-based roles use `<catalog>/<id>.md`; skill-based roles (Kimi) use
  // `<catalog>/<id>/SKILL.md`.
  return path.basename(probe) === 'SKILL.md'
    ? path.dirname(path.dirname(probe))
    : path.dirname(probe)
}

function listAgentFiles(
  project: ProviderProject,
  provider?: string,
): Array<{ id: string; file: string }> {
  const dir = agentsCatalogDir(project, provider)
  if (!fs.existsSync(dir)) return []
  const out: Array<{ id: string; file: string }> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const id = entry.isDirectory()
      ? entry.name
      : entry.isFile() && entry.name.endsWith('.md')
        ? entry.name.slice(0, -3)
        : null
    if (!id) continue
    const file = agentFile(project, id, provider)
    if (fs.existsSync(file)) out.push({ id, file })
  }
  return out
}

// Request augmentation declared in project-router.ts
declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: ProjectContext
  }
}

const AGENTS_SECTION_ENABLED = process.env.SPECRAILS_AGENTS_SECTION !== 'false'

function handleError(res: Response, err: unknown): void {
  if (err instanceof ProfileValidationError) {
    res.status(400).json({ error: err.message, details: err.errors })
    return
  }
  if (err instanceof ProfileConflictError) {
    res.status(409).json({ error: err.message })
    return
  }
  if (err instanceof ProfileNotFoundError) {
    res.status(404).json({ error: err.message })
    return
  }
  const message = err instanceof Error ? err.message : 'unknown error'
  res.status(500).json({ error: message })
}

/** Studio automation is safe when the CLI can enforce either a no-tools or a
 * read-only boundary. Codex/Gemini use their verified native read-only modes;
 * Kimi prompt mode exposes neither and therefore fails closed. */
export function providerSupportsAgentStudioAutomation(provider: string): boolean {
  const adapter = getAdapter(provider)
  const policies = adapter.capabilities.toolPolicies ?? []
  return policies.includes('none') || policies.includes('read-only')
}

function requireSafeStudioPolicy(res: Response, provider: string): boolean {
  if (providerSupportsAgentStudioAutomation(provider)) return true
  res.status(409).json({
    error: 'provider_tool_policy_unsupported',
    provider,
    requiredPolicies: ['none', 'read-only'],
  })
  return false
}

/** Kimi custom roles are provider-native Skills, so a non-empty markdown file
 * is not enough: discovery requires valid identifying frontmatter. Reuse the
 * execution parser directly so Profiles can never persist regex-accepted YAML
 * that the Kimi headless path rejects later. The parser module is dependency
 * leaf (fs/path/js-yaml only), so this direct import does not create a router /
 * adapter cycle. */
function validateCustomRoleBody(provider: string, agentId: string, body: string): string[] {
  if (provider !== 'kimi') return []
  return validateKimiRoleDocument(body, agentId, `${agentId}/SKILL.md`)
}

export function createProfilesRouter(): Router {
  const router = Router({ mergeParams: true })

  function ctx(req: Request): ProjectContext {
    return req.projectCtx!
  }

  // Feature-flag gate
  router.use((_req, res, next) => {
    if (!AGENTS_SECTION_ENABLED) {
      res.status(404).json({ error: 'Agents section disabled on this server' })
      return
    }
    next()
  })

  // GET /api/projects/:projectId/profiles/context
  // Provider-aware catalogs drive both Profiles and Agent Studio without
  // hard-coding a Claude fallback into either client.
  router.get('/context', (req, res) => {
    try {
      const { project } = ctx(req)
      const providers = installedProviders(project)
      const catalogs = Object.fromEntries(providers.map((provider) => {
        const adapter = getAdapter(provider)
        return [provider, {
          models: adapter.modelCatalog().map(({ value, label }) => ({ value, label })),
          defaultModel: adapter.defaultModel(),
          baselineAgents: [...adapter.baselineAgents()],
          customModelAliases: adapter.capabilities.customModelAliases === true,
        }]
      }))
      res.json({
        primaryProvider: project.provider ?? providers[0] ?? 'claude',
        providers,
        catalogs,
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/profiles/migrate-from-settings
  // Seed a `default` profile from the agent frontmatter + legacy routing.
  // Intended for first-time onboarding of existing projects.
  router.post('/migrate-from-settings', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const provider = requestedProvider(req, project)
      const adapter = projectAdapter(project, provider)
      const configuredKimiModels = provider === 'kimi'
        ? readAgentModelSelection({ ...project, provider })
        : null
      const projectedKimiModels = configuredKimiModels
        ? new Map(
            readAgentModels({ ...project, provider })
              .map((entry) => [entry.name, entry.model] as const),
          )
        : null
      const agentsDir = agentsCatalogDir(project, provider)
      if (!fs.existsSync(agentsDir)) {
        res.status(400).json({ error: `no ${adapter.projectDirName} roles catalog found` })
        return
      }
      const agents: Array<{ id: string; model: string }> = []
      for (const entry of listAgentFiles(project, provider)) {
        if (!entry.id.startsWith('sr-')) continue
        const id = entry.id
        let model = projectedKimiModels?.get(id) ?? adapter.defaultModel()
        if (!projectedKimiModels) {
          try {
            const content = fs.readFileSync(entry.file, 'utf8')
            const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
            if (fm) {
              const m = fm[1].match(/^model:\s*(\S+)/m)
              if (m && isModelAvailableForAdapter(adapter, m[1])) model = m[1]
            }
          } catch {
            // skip unreadable files
          }
        }
        agents.push({ id, model })
      }
      const baseline = [...adapter.baselineAgents()]
      const missing = baseline.filter((id) => !agents.some((a) => a.id === id))
      if (missing.length > 0) {
        res.status(400).json({
          error: `missing baseline agents in this project: ${missing.join(', ')}. Run 'npx specrails-core@latest update' first.`,
        })
        return
      }
      // Order: baseline trio first (architect, developer, reviewer), optional
      // agents in the middle. sr-merge-resolver is no longer a baseline agent;
      // it sorts among optional agents alphabetically when present.
      const pinnedLast = new Set<string>()
      const baselineFirst = new Set(['sr-architect', 'sr-developer', 'sr-reviewer'])
      const orderedAgents = [
        ...agents.filter((a) => baselineFirst.has(a.id))
          .sort((a, b) => {
            const rank = ['sr-architect', 'sr-developer', 'sr-reviewer']
            return rank.indexOf(a.id) - rank.indexOf(b.id)
          }),
        ...agents.filter((a) => !baselineFirst.has(a.id) && !pinnedLast.has(a.id))
          .sort((a, b) => a.id.localeCompare(b.id)),
        ...agents.filter((a) => pinnedLast.has(a.id)),
      ]
      // Build the default profile mirroring legacy routing. Claude keeps its
      // role-frontmatter projection. Kimi has no compatible `model:` field in
      // SKILL.md, so its exact validated default/overrides come from the
      // provider install config projected above.
      const isClaude = provider === 'claude'
      const fallbackModel = adapter.defaultModel()
      const profile = {
        schemaVersion: 1 as const,
        name: 'default',
        description: 'Baseline profile migrated from your current agent frontmatters.',
        ...(!isClaude || installedProviders(project).length > 1 ? { provider } : {}),
        orchestrator: {
          model: configuredKimiModels?.defaultModel ?? fallbackModel,
        },
        agents: orderedAgents.map((a) => ({
          id: a.id,
          model: a.model,
          required: baseline.includes(a.id),
        })),
        routing: [
          ...(agents.some((a) => a.id === 'sr-frontend-developer')
            ? [{ tags: ['frontend'], agent: 'sr-frontend-developer' }]
            : []),
          ...(agents.some((a) => a.id === 'sr-backend-developer')
            ? [{ tags: ['backend'], agent: 'sr-backend-developer' }]
            : []),
          { default: true, agent: 'sr-developer' },
        ],
      }
      try {
        createProfile(specRoot(project), profile as never, provider)
      } catch (err) {
        if (err instanceof ProfileConflictError) {
          res.status(409).json({ error: "a profile named 'default' already exists; delete it first or edit it manually" })
          return
        }
        throw err
      }
      broadcast({ type: 'profile.changed', projectId: project.id, name: 'default' } as never)
      res.status(201).json({ profile })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/analytics?windowDays=30
  // Per-profile aggregated metrics over the requested time window.
  router.get('/analytics', (req, res) => {
    try {
      const { db, project } = ctx(req)
      const provider = requestedProvider(req, project)
      const windowDays = Math.max(1, Math.min(365, parseInt((req.query.windowDays ?? '30') as string, 10) || 30))
      const since = Date.now() - windowDays * 24 * 60 * 60 * 1000
      const rows = db
        .prepare(
          `SELECT
             jp.profile_name AS profileName,
             COUNT(*) AS jobs,
             SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS succeeded,
             AVG(j.duration_ms) AS avgDurationMs,
             AVG(CASE
                   WHEN j.tokens_in IS NOT NULL OR j.tokens_out IS NOT NULL
                     OR j.tokens_cache_read IS NOT NULL OR j.tokens_cache_create IS NOT NULL
                   THEN COALESCE(j.tokens_in, 0) + COALESCE(j.tokens_out, 0)
                     + COALESCE(j.tokens_cache_read, 0) + COALESCE(j.tokens_cache_create, 0)
                 END) AS avgTokens,
             AVG(j.total_cost_usd) AS avgCostUsd,
             SUM(CASE WHEN j.tokens_in IS NOT NULL OR j.tokens_out IS NOT NULL
                           OR j.tokens_cache_read IS NOT NULL OR j.tokens_cache_create IS NOT NULL
                      THEN 1 ELSE 0 END) AS usageReportedJobs,
             SUM(CASE WHEN j.tokens_in IS NULL AND j.tokens_out IS NULL
                           AND j.tokens_cache_read IS NULL AND j.tokens_cache_create IS NULL
                      THEN 1 ELSE 0 END) AS usageUnavailableJobs,
             COUNT(j.total_cost_usd) AS pricedJobs,
             SUM(CASE WHEN j.total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedJobs
           FROM job_profiles jp
           JOIN jobs j ON j.id = jp.job_id
           WHERE jp.created_at >= ?
             AND COALESCE(j.provider, 'claude') = ?
           GROUP BY jp.profile_name
           ORDER BY jobs DESC`,
        )
        .all(since, provider) as Array<{
          profileName: string
          jobs: number
          succeeded: number
          avgDurationMs: number | null
          avgTokens: number | null
          avgCostUsd: number | null
          usageReportedJobs: number
          usageUnavailableJobs: number
          pricedJobs: number
          unpricedJobs: number
        }>
      res.json({
        provider,
        windowDays,
        rows: rows.map((r) => ({
          profileName: r.profileName,
          jobs: r.jobs,
          succeeded: r.succeeded,
          successRate: r.jobs > 0 ? r.succeeded / r.jobs : 0,
          avgDurationMs: r.avgDurationMs,
          avgTokens: r.avgTokens,
          avgCostUsd: r.avgCostUsd,
          usageReportedJobs: r.usageReportedJobs,
          usageUnavailableJobs: r.usageUnavailableJobs,
          pricedJobs: r.pricedJobs,
          unpricedJobs: r.unpricedJobs,
        })),
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/core-version
  // Report the project's installed specrails-core version for the upgrade banner.
  router.get('/core-version', (req, res) => {
    try {
      const { project } = ctx(req)
      const root = specRoot(project)
      const candidates = [
        path.join(root, '.specrails', 'specrails-version'),
        path.join(project.path, '.specrails-version'),
      ]
      let version: string | null = null
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          try {
            version = fs.readFileSync(p, 'utf8').trim()
          } catch {
            // ignore
          }
          if (version) break
        }
      }
      // Minimum version required for profile-aware implement
      const REQUIRED = '4.1.0'
      let profileAware = false
      if (version) {
        const [ma, mi, pa] = version.split('.').map((n) => parseInt(n, 10))
        const [rma, rmi, rpa] = REQUIRED.split('.').map((n) => parseInt(n, 10))
        if (!isNaN(ma) && !isNaN(mi) && !isNaN(pa)) {
          profileAware =
            ma > rma ||
            (ma === rma && mi > rmi) ||
            (ma === rma && mi === rmi && pa >= rpa)
        }
      }
      res.json({ version, required: REQUIRED, profileAware })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/catalog
  // List all roles in the selected provider-native catalog (sr-* + custom-*).
  router.get('/catalog', (req, res) => {
    try {
      const { project } = ctx(req)
      const provider = requestedProvider(req, project)
      const files = listAgentFiles(project, provider)
      if (files.length === 0) {
        res.json({ agents: [] })
        return
      }
      const agents: Array<{
        id: string
        kind: 'upstream' | 'custom'
        description?: string
        model?: string
      }> = []
      for (const entry of files) {
        const id = entry.id
        const kind: 'upstream' | 'custom' | null = id.startsWith('sr-')
          ? 'upstream'
          : id.startsWith('custom-')
            ? 'custom'
            : null
        if (!kind) continue
        let description: string | undefined
        let model: string | undefined
        try {
          const body = fs.readFileSync(entry.file, 'utf8')
          if (provider === 'kimi') {
            // Use the same js-yaml metadata parser as validation/execution so
            // folded/literal descriptions and quoted scalars render correctly.
            description = parseKimiSkillDocument(body, entry.file).description
          } else {
            const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
            if (!fm) throw new Error(`Missing frontmatter in ${entry.file}`)
            // description can be a long JSON-escaped string spanning multiple lines.
            // Match from `description:` up to the next top-level YAML key or the end
            // of the frontmatter block. Then unescape \n, \t, \" and strip surrounding
            // quotes. Collapse whitespace so it fits the one-line header.
            const descBlock = fm[1].match(
              /^description:\s*([\s\S]*?)(?=^[a-z_]+:\s|^---|\Z)/m,
            )
            if (descBlock) {
              let raw = descBlock[1].trim()
              // Strip surrounding quotes (YAML may use '...' or "...")
              if ((raw.startsWith('"') && raw.endsWith('"')) ||
                  (raw.startsWith("'") && raw.endsWith("'"))) {
                raw = raw.slice(1, -1)
              }
              // Decode common JSON-style escapes
              raw = raw
                .replace(/\\n/g, ' ')
                .replace(/\\t/g, ' ')
                .replace(/\\"/g, '"')
                .replace(/\\'/g, "'")
                .replace(/\\\\/g, '\\')
              // Collapse any whitespace (incl. real newlines) and trim
              description = raw.replace(/\s+/g, ' ').trim()
              // Cap length for the one-line header preview
              if (description.length > 280) description = description.slice(0, 277) + '…'
            }
            const modelMatch = fm[1].match(/^model:\s*(\S+)/m)
            if (modelMatch) model = modelMatch[1]
          }
          if (description && description.length > 280) {
            description = description.slice(0, 277) + '…'
          }
        } catch {
          // ignore unreadable files
        }
        agents.push({ id, kind, description, model })
      }
      agents.sort((a, b) => a.id.localeCompare(b.id))
      res.json({ agents })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/catalog/:agentId
  // Return the full .md body of a single agent file (read-only for sr-*, editable for custom-*)
  router.get('/catalog/:agentId', (req, res) => {
    try {
      const { project } = ctx(req)
      const provider = requestedProvider(req, project)
      const agentId = req.params.agentId
      if (!/^(sr|custom)-[a-z0-9][a-z0-9-]*$/.test(agentId)) {
        res.status(400).json({ error: 'invalid agent id' })
        return
      }
      const file = agentFile(project, agentId, provider)
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'agent not found' })
        return
      }
      const body = fs.readFileSync(file, 'utf8')
      res.json({ id: agentId, body })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/profiles/catalog (create a custom agent)
  // Body: { id: string, body: string }
  // id must start with `custom-` and match ^custom-[a-z0-9][a-z0-9-]*$
  router.post('/catalog', (req, res) => {
    try {
      const { project, db, broadcast } = ctx(req)
      const provider = requestedProvider(req, project, req.body?.provider)
      const id = (req.body?.id ?? '').toString().trim()
      const body = (req.body?.body ?? '').toString()
      if (!/^custom-[a-z0-9][a-z0-9-]*$/.test(id)) {
        res.status(400).json({ error: "id must match ^custom-[a-z0-9][a-z0-9-]*$ (the 'custom-' prefix is reserved for user-authored agents)" })
        return
      }
      if (!body || body.length === 0) {
        res.status(400).json({ error: 'body is required' })
        return
      }
      const roleErrors = validateCustomRoleBody(provider, id, body)
      if (roleErrors.length > 0) {
        res.status(400).json({ error: 'invalid_kimi_skill', details: roleErrors })
        return
      }
      const file = agentFile(project, id, provider)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (fs.existsSync(file)) {
        res.status(409).json({ error: `agent '${id}' already exists` })
        return
      }
      fs.writeFileSync(file, body, 'utf8')
      // Record initial version
      const nextVersion = 1
      db.prepare(
        `INSERT INTO agent_versions (provider, agent_name, version, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(provider, id, nextVersion, body, Date.now())
      broadcast({ type: 'agent.changed', projectId: project.id, id } as never)
      res.status(201).json({ id, body, version: nextVersion })
    } catch (err) {
      handleError(res, err)
    }
  })

  // PATCH /api/projects/:projectId/profiles/catalog/:agentId
  // Update a custom agent's body. sr-* agents are read-only (403).
  router.patch('/catalog/:agentId', (req, res) => {
    try {
      const { project, db, broadcast } = ctx(req)
      const provider = requestedProvider(req, project, req.body?.provider)
      const agentId = req.params.agentId
      if (!/^custom-[a-z0-9][a-z0-9-]*$/.test(agentId)) {
        res.status(403).json({ error: 'only custom-* agents can be edited from the app' })
        return
      }
      const body = (req.body?.body ?? '').toString()
      if (!body || body.length === 0) {
        res.status(400).json({ error: 'body is required' })
        return
      }
      const roleErrors = validateCustomRoleBody(provider, agentId, body)
      if (roleErrors.length > 0) {
        res.status(400).json({ error: 'invalid_kimi_skill', details: roleErrors })
        return
      }
      const file = agentFile(project, agentId, provider)
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'agent not found' })
        return
      }
      fs.writeFileSync(file, body, 'utf8')
      const maxVersion = (db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS v FROM agent_versions
           WHERE provider = ? AND agent_name = ?`,
        )
        .get(provider, agentId) as { v: number }).v
      const nextVersion = maxVersion + 1
      db.prepare(
        `INSERT INTO agent_versions (provider, agent_name, version, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(provider, agentId, nextVersion, body, Date.now())
      broadcast({ type: 'agent.changed', projectId: project.id, id: agentId } as never)
      res.json({ id: agentId, body, version: nextVersion })
    } catch (err) {
      handleError(res, err)
    }
  })

  // DELETE /api/projects/:projectId/profiles/catalog/:agentId
  // Only permitted for custom-* agents.
  router.delete('/catalog/:agentId', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const provider = requestedProvider(req, project)
      const agentId = req.params.agentId
      if (!/^custom-[a-z0-9][a-z0-9-]*$/.test(agentId)) {
        res.status(403).json({ error: 'only custom-* agents can be deleted' })
        return
      }
      const file = agentFile(project, agentId, provider)
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'agent not found' })
        return
      }
      fs.unlinkSync(file)
      try {
        const parent = path.dirname(file)
        if (parent !== agentsCatalogDir(project, provider) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
      } catch { /* best-effort */ }
      broadcast({ type: 'agent.changed', projectId: project.id, id: agentId, deleted: true } as never)
      res.json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/profiles/catalog/test
  // Smoke-test a draft body against a sample task without writing to disk.
  // Body: { agentId?: string, draftBody: string, sampleTask: string }
  // Persists the result to agent_tests; returns { output, tokens, durationMs }.
  router.post('/catalog/test', async (req, res) => {
    try {
      const { project, db, broadcast } = ctx(req)
      const provider = requestedProvider(req, project, req.body?.provider)
      if (!requireSafeStudioPolicy(res, provider)) return
      const agentId = (req.body?.agentId ?? '').toString().trim() || 'draft'
      const draftBody = (req.body?.draftBody ?? '').toString()
      const sampleTask = (req.body?.sampleTask ?? '').toString().trim()
      if (!draftBody) {
        res.status(400).json({ error: 'draftBody is required' })
        return
      }
      if (!sampleTask) {
        res.status(400).json({ error: 'sampleTask is required' })
        return
      }
      const result = await testCustomAgent(project.path, {
        draftBody,
        sampleTask,
        providerId: provider,
        record: { db, projectId: project.id, surfaceRefId: agentId, broadcast },
      })
      db.prepare(
        `INSERT INTO agent_tests
           (provider, agent_name, draft_hash, sample_task_id, tokens, duration_ms, output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(provider, agentId, result.draftHash, null, result.tokens, result.durationMs, result.output, Date.now())
      res.json(result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/profiles/catalog/generate
  // Generate a draft custom agent body via a one-shot claude spawn.
  // Body: { name: string, description: string }
  // Returns { draft: string } — caller (the Studio UI) previews and optionally saves.
  router.post('/catalog/generate', async (req, res) => {
    try {
      const { project, db, broadcast } = ctx(req)
      const provider = requestedProvider(req, project, req.body?.provider)
      if (!requireSafeStudioPolicy(res, provider)) return
      const name = (req.body?.name ?? '').toString().trim()
      const description = (req.body?.description ?? '').toString().trim()
      if (!/^custom-[a-z0-9][a-z0-9-]*$/.test(name)) {
        res.status(400).json({ error: "name must match ^custom-[a-z0-9][a-z0-9-]*$" })
        return
      }
      if (!description) {
        res.status(400).json({ error: 'description is required' })
        return
      }
      const draft = await generateCustomAgent(project.path, {
        name,
        description,
        providerId: provider,
        record: { db, projectId: project.id, surfaceRefId: name, broadcast },
      })
      res.json({ draft })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ── AI Refine: iterative AI editing for custom agents ───────────────────
  // All routes scoped to /catalog/:agentId/refine[/:refineId][/...].

  router.post('/catalog/:agentId/refine', async (req, res) => {
    try {
      const ctxObj = ctx(req)
      const { agentRefineManager, project } = ctxObj
      const provider = requestedProvider(req, project, req.body?.provider)
      if (!requireSafeStudioPolicy(res, provider)) return
      // AgentRefineManager owns the primary provider's native session store.
      // Cross-provider sessions need a provider column/migration before they
      // can be resumed safely; reject instead of silently using the primary.
      if (provider !== (project.provider ?? 'claude')) {
        res.status(409).json({
          error: 'provider_refine_manager_unavailable',
          provider,
        })
        return
      }
      const agentId = req.params.agentId
      if (!/^custom-[a-z0-9][a-z0-9-]*$/.test(agentId)) {
        res.status(400).json({ error: 'not_a_custom_agent' })
        return
      }
      const instruction = (req.body?.instruction ?? '').toString().trim()
      if (!instruction) {
        res.status(400).json({ error: 'instruction is required' })
        return
      }
      const autoTest = req.body?.autoTest !== false
      try {
        const result = await agentRefineManager.startRefine({ agentId, instruction, autoTest })
        res.status(201).json({ refineId: result.refineId })
      } catch (err) {
        const code = (err as Error).message
        if (code === 'not_a_custom_agent') {
          res.status(400).json({ error: 'not_a_custom_agent' })
          return
        }
        if (code === 'agent_not_found') {
          res.status(404).json({ error: 'agent not found' })
          return
        }
        throw err
      }
    } catch (err) {
      handleError(res, err)
    }
  })

  router.post('/catalog/:agentId/refine/:refineId/turn', async (req, res) => {
    try {
      const { agentRefineManager, db, project } = ctx(req)
      const provider = requestedProvider(req, project, req.body?.provider)
      if (!requireSafeStudioPolicy(res, provider)) return
      if (provider !== (project.provider ?? 'claude')) {
        res.status(409).json({
          error: 'provider_refine_manager_unavailable',
          provider,
        })
        return
      }
      const refineId = req.params.refineId
      const instruction = (req.body?.instruction ?? '').toString().trim()
      if (!instruction) {
        res.status(400).json({ error: 'instruction is required' })
        return
      }
      // Verify the session belongs to the :agentId in the path, matching the
      // sibling GET/PATCH/DELETE/apply routes — otherwise the path segment is
      // meaningless and the resource-scoping invariant is broken.
      const session = getRefineSession(db, refineId)
      if (!session || session.agent_id !== req.params.agentId) {
        res.status(404).json({ error: 'refine session not found' })
        return
      }
      try {
        await agentRefineManager.sendTurn({ refineId, instruction })
        res.json({ ok: true })
      } catch (err) {
        const code = (err as Error).message
        if (code === 'session_not_found') {
          res.status(404).json({ error: 'refine session not found' })
          return
        }
        if (code === 'turn_in_progress') {
          res.status(409).json({ error: 'a turn is already in progress for this session' })
          return
        }
        if (code === 'no_session_id') {
          res.status(409).json({ error: 'first turn has not yet completed; cannot resume' })
          return
        }
        throw err
      }
    } catch (err) {
      handleError(res, err)
    }
  })

  router.get('/catalog/:agentId/refine', (req, res) => {
    try {
      const { db } = ctx(req)
      const sessions = listRefineSessionsForAgent(db, req.params.agentId).map(refineSessionToJson)
      res.json({ sessions })
    } catch (err) {
      handleError(res, err)
    }
  })

  router.get('/catalog/:agentId/refine/:refineId', (req, res) => {
    try {
      const { db } = ctx(req)
      const session = getRefineSession(db, req.params.refineId)
      if (!session || session.agent_id !== req.params.agentId) {
        res.status(404).json({ error: 'refine session not found' })
        return
      }
      res.json(refineSessionToJson(session))
    } catch (err) {
      handleError(res, err)
    }
  })

  router.patch('/catalog/:agentId/refine/:refineId', (req, res) => {
    try {
      const { agentRefineManager, db } = ctx(req)
      const session = getRefineSession(db, req.params.refineId)
      if (!session || session.agent_id !== req.params.agentId) {
        res.status(404).json({ error: 'refine session not found' })
        return
      }
      if (typeof req.body?.autoTest === 'boolean') {
        agentRefineManager.toggleAutoTest(req.params.refineId, req.body.autoTest)
      }
      const updated = getRefineSession(db, req.params.refineId)!
      res.json(refineSessionToJson(updated))
    } catch (err) {
      handleError(res, err)
    }
  })

  router.delete('/catalog/:agentId/refine/:refineId', (req, res) => {
    try {
      const { agentRefineManager, db } = ctx(req)
      const session = getRefineSession(db, req.params.refineId)
      if (!session || session.agent_id !== req.params.agentId) {
        res.status(404).json({ error: 'refine session not found' })
        return
      }
      agentRefineManager.cancel(req.params.refineId)
      res.json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  router.post('/catalog/:agentId/refine/:refineId/apply', (req, res) => {
    try {
      const { agentRefineManager, db, project, broadcast } = ctx(req)
      const session = getRefineSession(db, req.params.refineId)
      if (!session || session.agent_id !== req.params.agentId) {
        res.status(404).json({ error: 'refine session not found' })
        return
      }
      const force = !!req.body?.force
      const result = agentRefineManager.apply({ refineId: req.params.refineId, force })
      if (!result.ok) {
        if (result.reason === 'disk_changed' || result.reason === 'name_changed') {
          res.status(409).json({ error: result.reason, reason: result.reason })
          return
        }
        if (result.reason === 'agent_not_found') {
          res.status(404).json({ error: 'agent not found' })
          return
        }
        res.status(400).json({ error: result.reason ?? 'apply_failed' })
        return
      }
      // Re-broadcast standard agent change with the proper projectId so the
      // catalog UI updates (manager broadcasts an empty projectId; ProjectRegistry
      // injects projectId via boundBroadcast, but the explicit emit below is
      // belt-and-braces for any client filtering on `agent.changed`).
      broadcast({ type: 'agent.changed', projectId: project.id, id: req.params.agentId } as never)
      res.json({ ok: true, version: result.version, body: result.body })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/catalog/:agentId/versions
  router.get('/catalog/:agentId/versions', (req, res) => {
    try {
      const { db, project } = ctx(req)
      const provider = requestedProvider(req, project)
      const agentId = req.params.agentId
      const rows = db
        .prepare(
          `SELECT version, body, created_at AS createdAt FROM agent_versions
           WHERE provider = ? AND agent_name = ? ORDER BY version DESC`,
        )
        .all(provider, agentId) as Array<{ version: number; body: string; createdAt: number }>
      res.json({ versions: rows })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles
  router.get('/', (req, res) => {
    try {
      const { project } = ctx(req)
      const provider = requestedProvider(req, project)
      const primary = project.provider ?? 'claude'
      res.json({
        profiles: listProfiles(specRoot(project), primary)
          .filter((profile) => profile.provider === provider),
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/resolve?profile=<name>
  router.get('/resolve', (req, res) => {
    try {
      const { project } = ctx(req)
      const provider = requestedProvider(req, project)
      const explicit = typeof req.query.profile === 'string' ? req.query.profile : undefined
      const resolved = resolveProfile(specRoot(project), explicit, provider)
      if (!resolved) {
        res.json({ resolved: null })
        return
      }
      res.json({ resolved: { name: resolved.name, profile: resolved.profile } })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/profiles
  router.post('/', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const input = req.body as Profile
      const provider = requestedProvider(req, project, input?.provider)
      const body: Profile = {
        ...input,
        ...(input?.provider || provider !== 'claude' || installedProviders(project).length > 1
          ? { provider }
          : {}),
      }
      createProfile(specRoot(project), body, provider)
      broadcast({ type: 'profile.changed', projectId: project.id, name: body.name } as never)
      res.status(201).json({ profile: body })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/profiles/:name/duplicate
  router.post('/:name/duplicate', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const provider = requestedProvider(req, project, req.body?.provider)
      const newName = (req.body?.name ?? '').toString()
      if (!newName) {
        res.status(400).json({ error: "body field 'name' is required" })
        return
      }
      const copy = duplicateProfile(specRoot(project), req.params.name, newName, provider)
      broadcast({ type: 'profile.changed', projectId: project.id, name: newName } as never)
      res.status(201).json({ profile: copy })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/profiles/:name/rename
  router.post('/:name/rename', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const provider = requestedProvider(req, project, req.body?.provider)
      const newName = (req.body?.name ?? '').toString()
      if (!newName) {
        res.status(400).json({ error: "body field 'name' is required" })
        return
      }
      const renamed = renameProfile(specRoot(project), req.params.name, newName, provider)
      broadcast({ type: 'profile.changed', projectId: project.id, name: newName } as never)
      res.json({ profile: renamed })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/:name
  router.get('/:name', (req, res) => {
    try {
      const { project } = ctx(req)
      const provider = requestedProvider(req, project)
      // Non-validating read so a profile that drifted invalid against the current
      // catalog can still be opened + repaired in the editor (getProfile threw and
      // locked it out). The body + validation errors are both returned.
      const { profile, valid, errors } = getProfileRaw(specRoot(project), req.params.name, provider)
      res.json({ profile, valid, validationErrors: errors })
    } catch (err) {
      handleError(res, err)
    }
  })

  // PATCH /api/projects/:projectId/profiles/:name
  router.patch('/:name', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const input = req.body as Profile
      const provider = requestedProvider(req, project, input?.provider)
      const body: Profile = {
        ...input,
        ...(input?.provider || provider !== 'claude' || installedProviders(project).length > 1
          ? { provider }
          : {}),
      }
      if (body.name !== req.params.name) {
        res.status(400).json({ error: "body.name must match path parameter (use /rename to change name)" })
        return
      }
      updateProfile(specRoot(project), body, provider)
      broadcast({ type: 'profile.changed', projectId: project.id, name: body.name } as never)
      res.json({ profile: body })
    } catch (err) {
      handleError(res, err)
    }
  })

  // DELETE /api/projects/:projectId/profiles/:name
  router.delete('/:name', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const provider = requestedProvider(req, project)
      deleteProfile(specRoot(project), req.params.name, provider)
      broadcast({ type: 'profile.changed', projectId: project.id, name: req.params.name, deleted: true } as never)
      res.json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}
