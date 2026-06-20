import fs from 'fs'
import path from 'path'
import { Router, Request, Response } from 'express'
import type { ProjectContext } from './project-registry'
import { generateCustomAgent, testCustomAgent } from './agent-generator'
import { getRefineSession, listRefineSessionsForAgent } from './agent-refine-db'
import { refineSessionToJson } from './agent-refine-manager'
import { getAdapter } from './providers'
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

/**
 * Relocate-artifacts gate: the dir whose `.specrails/{profiles,specrails-version}`
 * AND whose `.claude/agents/**` catalog the profiles surface reads/writes.
 * Relocated ⇒ the workspace dir (where core assembled the agents catalog +
 * `.specrails/profiles`); legacy ⇒ project.path (byte-identical to today).
 *
 * The `.claude/agents/**` catalog MUST follow this same root: when relocated,
 * core materializes the agents into `<workspace>/.claude/agents`, so a profiles
 * catalog read/write rooted at `project.path` would (a) read a stale/absent repo
 * copy and (b) write custom-* agents into the repo — violating repo-immutability
 * and never reaching the workspace the rails actually load from.
 */
function specRoot(project: { slug: string; path: string }): string {
  const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
  return exec.relocated && exec.workspaceDir ? exec.workspaceDir : project.path
}

/** The agents-catalog directory for the relocate-aware root (`<root>/.claude/agents`). */
function agentsCatalogDir(project: { slug: string; path: string }): string {
  return path.join(specRoot(project), '.claude', 'agents')
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

  // POST /api/projects/:projectId/profiles/migrate-from-settings
  // Seed a `default` profile from the agent frontmatter + legacy routing.
  // Intended for first-time onboarding of existing projects.
  router.post('/migrate-from-settings', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const agentsDir = agentsCatalogDir(project)
      if (!fs.existsSync(agentsDir)) {
        res.status(400).json({ error: 'no .claude/agents/ directory found' })
        return
      }
      // Gather installed sr-*.md with their declared models.
      const agents: Array<{ id: string; model: 'sonnet' | 'opus' | 'haiku' }> = []
      for (const entry of fs.readdirSync(agentsDir)) {
        if (!entry.endsWith('.md')) continue
        if (!entry.startsWith('sr-')) continue
        const id = entry.slice(0, -'.md'.length)
        let model: 'sonnet' | 'opus' | 'haiku' = 'sonnet'
        try {
          const content = fs.readFileSync(path.join(agentsDir, entry), 'utf8')
          const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
          if (fm) {
            const m = fm[1].match(/^model:\s*(sonnet|opus|haiku)/m)
            if (m) model = m[1] as 'sonnet' | 'opus' | 'haiku'
          }
        } catch {
          // skip unreadable files
        }
        agents.push({ id, model })
      }
      const baseline = ['sr-architect', 'sr-developer', 'sr-reviewer']
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
      // Build the default profile mirroring legacy routing. The frontmatter
      // model aliases parsed above are claude-specific; for any other provider
      // they are not in the adapter's catalog, so fall back to that provider's
      // default model and stamp the provider so the persisted profile validates
      // against the right catalog on every future read.
      const provider = project.provider ?? 'claude'
      const isClaude = provider === 'claude'
      const fallbackModel = isClaude ? 'sonnet' : getAdapter(provider).defaultModel()
      const profile = {
        schemaVersion: 1 as const,
        name: 'default',
        description: 'Baseline profile migrated from your current agent frontmatters.',
        ...(isClaude ? {} : { provider }),
        orchestrator: { model: isClaude ? 'sonnet' : fallbackModel },
        agents: orderedAgents.map((a) => ({
          id: a.id,
          model: isClaude ? a.model : fallbackModel,
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
      const { db } = ctx(req)
      const windowDays = Math.max(1, Math.min(365, parseInt((req.query.windowDays ?? '30') as string, 10) || 30))
      const since = Date.now() - windowDays * 24 * 60 * 60 * 1000
      const rows = db
        .prepare(
          `SELECT
             jp.profile_name AS profileName,
             COUNT(*) AS jobs,
             SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS succeeded,
             AVG(j.duration_ms) AS avgDurationMs,
             AVG(COALESCE(j.tokens_in, 0) + COALESCE(j.tokens_out, 0)
                 + COALESCE(j.tokens_cache_read, 0) + COALESCE(j.tokens_cache_create, 0)) AS avgTokens,
             AVG(j.total_cost_usd) AS avgCostUsd
           FROM job_profiles jp
           JOIN jobs j ON j.id = jp.job_id
           WHERE jp.created_at >= ?
           GROUP BY jp.profile_name
           ORDER BY jobs DESC`,
        )
        .all(since) as Array<{
          profileName: string
          jobs: number
          succeeded: number
          avgDurationMs: number | null
          avgTokens: number | null
          avgCostUsd: number | null
        }>
      res.json({
        windowDays,
        rows: rows.map((r) => ({
          profileName: r.profileName,
          jobs: r.jobs,
          succeeded: r.succeeded,
          successRate: r.jobs > 0 ? r.succeeded / r.jobs : 0,
          avgDurationMs: r.avgDurationMs,
          avgTokens: r.avgTokens,
          avgCostUsd: r.avgCostUsd,
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
  // List all agents available in .claude/agents/ (upstream sr-* and custom custom-*)
  router.get('/catalog', (req, res) => {
    try {
      const { project } = ctx(req)
      const dir = agentsCatalogDir(project)
      if (!fs.existsSync(dir)) {
        res.json({ agents: [] })
        return
      }
      const agents: Array<{
        id: string
        kind: 'upstream' | 'custom'
        description?: string
        model?: string
      }> = []
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const id = file.slice(0, -'.md'.length)
        const kind: 'upstream' | 'custom' | null = id.startsWith('sr-')
          ? 'upstream'
          : id.startsWith('custom-')
            ? 'custom'
            : null
        if (!kind) continue
        let description: string | undefined
        let model: string | undefined
        try {
          const body = fs.readFileSync(path.join(dir, file), 'utf8')
          const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
          if (fm) {
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
      const agentId = req.params.agentId
      if (!/^(sr|custom)-[a-z0-9][a-z0-9-]*$/.test(agentId)) {
        res.status(400).json({ error: 'invalid agent id' })
        return
      }
      const file = path.join(agentsCatalogDir(project), `${agentId}.md`)
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
      const agentsDir = agentsCatalogDir(project)
      fs.mkdirSync(agentsDir, { recursive: true })
      const file = path.join(agentsDir, `${id}.md`)
      if (fs.existsSync(file)) {
        res.status(409).json({ error: `agent '${id}' already exists` })
        return
      }
      fs.writeFileSync(file, body, 'utf8')
      // Record initial version
      const nextVersion = 1
      db.prepare(
        `INSERT INTO agent_versions (agent_name, version, body, created_at) VALUES (?, ?, ?, ?)`,
      ).run(id, nextVersion, body, Date.now())
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
      const file = path.join(agentsCatalogDir(project), `${agentId}.md`)
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'agent not found' })
        return
      }
      fs.writeFileSync(file, body, 'utf8')
      const maxVersion = (db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM agent_versions WHERE agent_name = ?`)
        .get(agentId) as { v: number }).v
      const nextVersion = maxVersion + 1
      db.prepare(
        `INSERT INTO agent_versions (agent_name, version, body, created_at) VALUES (?, ?, ?, ?)`,
      ).run(agentId, nextVersion, body, Date.now())
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
      const agentId = req.params.agentId
      if (!/^custom-[a-z0-9][a-z0-9-]*$/.test(agentId)) {
        res.status(403).json({ error: 'only custom-* agents can be deleted' })
        return
      }
      const file = path.join(agentsCatalogDir(project), `${agentId}.md`)
      if (!fs.existsSync(file)) {
        res.status(404).json({ error: 'agent not found' })
        return
      }
      fs.unlinkSync(file)
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
      const { project, db } = ctx(req)
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
      const result = await testCustomAgent(project.path, { draftBody, sampleTask })
      db.prepare(
        `INSERT INTO agent_tests (agent_name, draft_hash, sample_task_id, tokens, duration_ms, output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(agentId, result.draftHash, null, result.tokens, result.durationMs, result.output, Date.now())
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
      const { project } = ctx(req)
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
      const draft = await generateCustomAgent(project.path, { name, description })
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
      const { agentRefineManager } = ctxObj
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
      const { agentRefineManager, db } = ctx(req)
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
      const { db } = ctx(req)
      const agentId = req.params.agentId
      const rows = db
        .prepare(
          `SELECT version, body, created_at AS createdAt FROM agent_versions
           WHERE agent_name = ? ORDER BY version DESC`,
        )
        .all(agentId) as Array<{ version: number; body: string; createdAt: number }>
      res.json({ versions: rows })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles
  router.get('/', (req, res) => {
    try {
      const { project } = ctx(req)
      res.json({ profiles: listProfiles(specRoot(project)) })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/profiles/resolve?profile=<name>
  router.get('/resolve', (req, res) => {
    try {
      const { project } = ctx(req)
      const explicit = typeof req.query.profile === 'string' ? req.query.profile : undefined
      const resolved = resolveProfile(specRoot(project), explicit, project.provider ?? 'claude')
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
      const body = req.body as Profile
      createProfile(specRoot(project), body, project.provider ?? 'claude')
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
      const newName = (req.body?.name ?? '').toString()
      if (!newName) {
        res.status(400).json({ error: "body field 'name' is required" })
        return
      }
      const copy = duplicateProfile(specRoot(project), req.params.name, newName, project.provider ?? 'claude')
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
      const newName = (req.body?.name ?? '').toString()
      if (!newName) {
        res.status(400).json({ error: "body field 'name' is required" })
        return
      }
      const renamed = renameProfile(specRoot(project), req.params.name, newName, project.provider ?? 'claude')
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
      // Non-validating read so a profile that drifted invalid against the current
      // catalog can still be opened + repaired in the editor (getProfile threw and
      // locked it out). The body + validation errors are both returned.
      const { profile, valid, errors } = getProfileRaw(specRoot(project), req.params.name, project.provider ?? 'claude')
      res.json({ profile, valid, validationErrors: errors })
    } catch (err) {
      handleError(res, err)
    }
  })

  // PATCH /api/projects/:projectId/profiles/:name
  router.patch('/:name', (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const body = req.body as Profile
      if (body.name !== req.params.name) {
        res.status(400).json({ error: "body.name must match path parameter (use /rename to change name)" })
        return
      }
      updateProfile(specRoot(project), body, project.provider ?? 'claude')
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
      deleteProfile(specRoot(project), req.params.name)
      broadcast({ type: 'profile.changed', projectId: project.id, name: req.params.name, deleted: true } as never)
      res.json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}
