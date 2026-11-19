/**
 * App-level project catalog routes: list/register/unregister projects, clone a
 * GitHub repository, edit a project's repository membership, retry the silent
 * workspace assembly, resolve a project from a path, and the bundled sample
 * project (modules/onboarding), which shares the registration side effects.
 *
 * Owns registration-time path safety (system-directory deny-lists, canonical
 * paths) and deterministic slug allocation.
 */
import type { Router } from 'express'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import { cloneGithubRepository } from './github-clone'
import { registerOnboardingRoutes } from './modules/onboarding/adapters/http'
import { loadPresetCandidates } from './modules/onboarding/adapters/providers'
import { createSampleFiles, createSampleGit, createSampleSpecs, createSampleState } from './modules/onboarding/adapters/runtime'
import { SAMPLE_CATALOG } from './modules/onboarding/catalog'
import type { WsMessage } from './types'
import type { ProjectRegistry } from './project-registry'
import { RepositoryValidationError, inspectRepositoryPath, assertDistinctRepositories, getProjectRepositories, resolveRepositoryProject, type ProjectRepositoryInput } from './project-repositories'
import { getDesktopSetting, setDesktopSetting, listProjects } from './desktop-db'
import { checkCoreCompat, coreCompatSupportsProvider } from './core-compat'
import { getAdapter, hasAdapter, listAdapters } from './providers'
import { getDetectionSnapshot, getDetectedIdsSync, refreshDetection, isCodexBetaDisabled, isGeminiBetaDisabled } from './provider-detection'
import { workspacePathFor } from './workspace-manager'
import { isWorkspacePopulated } from './workspace-resolution'
import { detectProviderReadiness } from './desktop-router-providers'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Deterministic slug allocation with a `-N` dedup suffix — byte-parity with
 * specrails-core's `allocateSlug` (and artifact-registry). Without this, two
 * repos that share a basename (e.g. `frontend` in two parent dirs) both slugify
 * to `frontend`, and the second `addProject` dies on the `projects.slug UNIQUE`
 * constraint with a misleading 409 ("already registered") even though the PATH
 * is new. The `-2`, `-3`… suffix gives the second repo a distinct slug.
 */
function allocateSlug(name: string, existing: ReadonlySet<string>): string {
  let base = slugify(name)
  if (base === '') base = 'project'
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

// LOW-04: Deny registration of system-critical directory paths. The POSIX list
// is matched against forward-slash-normalized, lowercased paths; on Windows it
// was a complete no-op (no path matches `/etc`), so add a Windows deny-list and
// fold case (Windows FS is case-insensitive).
const DENIED_PATH_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/sys', '/proc', '/dev', '/boot', '/run',
]
// Windows: deny the Windows dir, Program Files variants, and any bare drive root.
const DENIED_WINDOWS_PREFIXES = [
  'c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata',
]

function isPathSafe(resolvedPath: string): boolean {
  const slashed = resolvedPath.replace(/\\/g, '/')
  const normalized = slashed.endsWith('/') ? slashed : slashed + '/'
  if (process.platform === 'win32') {
    const lower = normalized.toLowerCase()
    // Bare drive root (C:/) is never a valid project location.
    if (/^[a-z]:\/$/.test(lower)) return false
    return !DENIED_WINDOWS_PREFIXES.some(
      (prefix) => lower.startsWith(prefix + '/') || lower === prefix + '/'
    )
  }
  return !DENIED_PATH_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix + '/') || normalized === prefix + '/'
  )
}

function deriveProjectName(projectPath: string): string {
  return path.basename(projectPath)
}

function hasCommandFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.md'))
  } catch {
    return false
  }
}

function hasProviderSkillFiles(dir: string): boolean {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, entry, 'SKILL.md'))) return true
      if (entry === 'rails') {
        for (const role of fs.readdirSync(path.join(dir, entry))) {
          if (fs.existsSync(path.join(dir, entry, role, 'SKILL.md'))) return true
        }
      }
    }
  } catch {
    return false
  }
  return false
}

function hasSpecrails(projectPath: string): boolean {
  return hasCommandFiles(path.join(projectPath, '.claude', 'commands', 'sr'))
    || hasCommandFiles(path.join(projectPath, '.claude', 'commands', 'specrails'))
    || hasProviderSkillFiles(path.join(projectPath, '.kimi-code', 'skills'))
}

function canonicalizePath(resolvedPath: string): string {
  try {
    return fs.realpathSync(resolvedPath)
  } catch {
    return resolvedPath
  }
}

/** Sample-project first run (modules/onboarding): create/remove the bundled
 *  sample project and report launch readiness. */
export function registerSampleProjectRoutes(router: Router, deps: { registry: ProjectRegistry; broadcast: (msg: WsMessage) => void }): void {
  const { registry, broadcast } = deps
  // Sample-project first run (modules/onboarding): create/remove the bundled
  // sample project and report launch readiness. Registered before the
  // `/projects` routes below; it shares their registration side effects.
  registerOnboardingRoutes(router, {
    samples: SAMPLE_CATALOG,
    files: createSampleFiles(),
    git: createSampleGit(),
    specs: createSampleSpecs(),
    state: createSampleState({
      get: (key) => getDesktopSetting(registry.desktopDb, key),
      set: (key, value) => setDesktopSetting(registry.desktopDb, key, value),
    }),
    providers: ({ refresh }) => loadPresetCandidates(refresh),
    projects: {
      register: ({ path: projectPath, name }) => {
        const canonicalPath = canonicalizePath(path.resolve(projectPath))
        const detectedNow: string[] = getDetectedIdsSync() ?? []
        const providers = detectedNow.length > 0 ? [...detectedNow] : ['claude']
        const slug = allocateSlug(name, new Set(listProjects(registry.desktopDb).map((p) => p.slug)))
        const id = randomUUID()
        const ctx = registry.addProject({ id, slug, name, path: canonicalPath, provider: providers[0], providers, repositories: [], workspacePaths: undefined })
        broadcast({ type: 'desktop.project_added', project: ctx.project, timestamp: new Date().toISOString() })
        // Same silent, non-blocking workspace assembly as POST /projects.
        try {
          if (!isWorkspacePopulated(workspacePathFor(slug))) ctx.setupManager.startSilentAssemble(id, canonicalPath, slug, providers)
        } catch (err) {
          console.warn('[desktop] sample silent assemble launch failed (non-fatal):', err)
        }
        return { id, name: ctx.project.name, path: canonicalPath }
      },
      unregister: (projectId) => {
        registry.removeProject(projectId)
        broadcast({ type: 'desktop.project_removed', projectId, timestamp: new Date().toISOString() })
      },
      isRegistered: (projectId) => registry.getProjectRow(projectId) !== undefined,
      get: (projectId) => {
        const row = registry.getProjectRow(projectId)
        return row ? { id: row.id, name: row.name, path: row.path } : null
      },
    },
  })
}

export function registerProjectRoutes(router: Router, deps: {
  registry: ProjectRegistry
  broadcast: (msg: WsMessage) => void
  assembleNewlyDetected: (detected: string[]) => void
}): void {
  const { registry, broadcast, assembleNewlyDetected } = deps
  // GET /api/projects — list all registered projects. The old wizard-restore
  // `setupProjectIds` field is retired (silent-project-add): kept as an empty
  // array for wire compat with clients that still destructure it.
  router.get('/projects', (_req, res) => {
    res.json({ projects: listProjects(registry.desktopDb), setupProjectIds: [] })
  })

  // POST /api/projects — register a new project by path
  router.post('/repositories/clone', async (req, res) => {
    const controller = new AbortController()
    const abort = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', abort)
    try {
      const clonedPath = await cloneGithubRepository(req.body ?? {}, isPathSafe, controller.signal)
      res.status(201).json({ path: clonedPath })
    } catch (err) {
      if (err instanceof RepositoryValidationError) res.status(err.status).json({ error: err.message, code: err.code })
      else res.status(500).json({ error: 'Could not clone repository' })
    } finally { res.off('close', abort) }
  })

  router.post('/projects', async (req, res) => {
    const { path: projectPath, name, provider, providers: providersRaw, repositories: repositoriesRaw, workspacePaths } = req.body ?? {}
    if (!projectPath || typeof projectPath !== 'string') {
      res.status(400).json({ error: 'path is required' })
      return
    }
    // Project registration is a detection refresh trigger (spec:
    // provider-auto-detection). The refresh runs in the BACKGROUND so
    // registration latency never pays for CLI probes; the defaulting below uses
    // the last cached snapshot (null before the first startup detection).
    refreshDetection()
      .then(({ snapshot, changed }) => {
        if (!changed) return
        broadcast({
          type: 'providers.detected_changed',
          detected: snapshot.detected,
          providers: snapshot.providers,
          timestamp: new Date().toISOString(),
        } as unknown as WsMessage)
        assembleNewlyDetected(snapshot.detected)
      })
      .catch(() => { /* detection failure never blocks registration */ })
    const detectedNow: string[] = getDetectedIdsSync() ?? []
    // Normalise to a providers list. Wire compat: `providers`/`provider` are
    // still accepted and recorded, but the DETECTED set is authoritative for
    // what the project offers (delta spec: multi-provider-architecture).
    // Omitting both registers with the detected set.
    let providers: string[]
    if (Array.isArray(providersRaw) && providersRaw.length > 0) {
      providers = providersRaw
    } else if (typeof provider === 'string') {
      providers = [provider]
    } else {
      providers = detectedNow.length > 0 ? [...detectedNow] : ['claude']
    }
    // De-duplicate while preserving order (primary stays first).
    providers = providers.filter((p, i) => providers.indexOf(p) === i)
    // Provider validation walks the registry — `claude` and `codex` are
    // both accepted as of Stage C; future providers register one adapter
    // file and become acceptable here without further changes.
    for (const p of providers) {
      if (!hasAdapter(p)) {
        res.status(400).json({
          error: `provider must be one of: ${[...listAdapters().map((a) => a.id)].join(', ')}`,
        })
        return
      }
    }
    // Beta-gate parity: if codex beta is forced off via env, refuse codex
    // selections too (consistency with /available-providers).
    if (providers.includes('codex') && isCodexBetaDisabled()) {
      res.status(400).json({
        error: 'Codex provider is currently disabled (SPECRAILS_CODEX_BETA=0). Unset or set to 1 to enable.',
      })
      return
    }
    if (providers.includes('gemini') && isGeminiBetaDisabled()) {
      res.status(400).json({
        error: 'Gemini provider is currently disabled (SPECRAILS_GEMINI_BETA=0). Unset or set to 1 to enable.',
      })
      return
    }
    // Only an EXPLICIT provider selection is a contract the caller asked for.
    // When the set was defaulted from the detection snapshot, an auto-detected
    // provider that fails its readiness probe right now (a slow `--version`
    // under load, a broken shim) is left out instead of rejecting the whole
    // registration for a provider nobody requested.
    const providersExplicit = (Array.isArray(providersRaw) && providersRaw.length > 0) || typeof provider === 'string'
    if (providers.includes('kimi')) {
      const readiness = await detectProviderReadiness(getAdapter('kimi'))
      if (readiness.issue && !providersExplicit) {
        providers = providers.filter((p) => p !== 'kimi')
        if (providers.length === 0) providers = ['claude']
      } else if (readiness.issue) {
        res.status(409).json({
          code: readiness.issue.code,
          provider: 'kimi',
          error: readiness.issue.message,
          detection: readiness.detection,
        })
        return
      }
    }
    if (providers.includes('kimi')) {
      const core = await checkCoreCompat()
      if (!coreCompatSupportsProvider(core, 'kimi') && !providersExplicit) {
        providers = providers.filter((p) => p !== 'kimi')
        if (providers.length === 0) providers = ['claude']
      } else if (!coreCompatSupportsProvider(core, 'kimi')) {
        res.status(409).json({
          code: 'core_provider_unsupported',
          provider: 'kimi',
          error:
            'This Specrails Core build cannot render Kimi skills. Update or reinstall Specrails, then retry.',
        })
        return
      }
    }

    const resolvedPath = path.resolve(projectPath)

    // Validate path exists
    if (!fs.existsSync(resolvedPath)) {
      res.status(400).json({ error: `Path does not exist: ${resolvedPath}` })
      return
    }

    const canonicalPath = canonicalizePath(resolvedPath)
    let repositories: ProjectRepositoryInput[] = []
    try {
      if (repositoriesRaw !== undefined && !Array.isArray(repositoriesRaw)) throw new RepositoryValidationError('repositories must be an array')
      repositories = (repositoriesRaw ?? []).map((input: ProjectRepositoryInput) => inspectRepositoryPath(input))
      const primary = inspectRepositoryPath({ path: canonicalPath, workspacePaths })
      assertDistinctRepositories([primary, ...repositories.map((input) => inspectRepositoryPath(input))])
      if (repositories.some((repository) => !isPathSafe(repository.path))) throw new RepositoryValidationError('Registering system directories is not allowed')
    } catch (err) {
      if (err instanceof RepositoryValidationError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
      throw err
    }

    // LOW-04: Reject registration of system-critical directories
    if (!isPathSafe(canonicalPath)) {
      res.status(400).json({ error: 'Registering system directories is not allowed' })
      return
    }

    const derivedName = (name && typeof name === 'string' && name.trim())
      ? name.trim()
      : deriveProjectName(canonicalPath)
    // Dedup the slug against already-registered projects so two same-basename
    // repos don't collide on the projects.slug UNIQUE constraint (which would
    // surface as a misleading 409 for a brand-new PATH).
    const existingSlugs = new Set(listProjects(registry.desktopDb).map((p) => p.slug))
    const slug = allocateSlug(derivedName, existingSlugs)
    const id = randomUUID()
    const specrailsInstalled = hasSpecrails(canonicalPath)

    try {
      const ctx = registry.addProject({
        id,
        slug,
        name: derivedName,
        path: canonicalPath,
        provider: providers[0],
        providers,
        repositories,
        workspacePaths,
      })
      broadcast({
        type: 'desktop.project_added',
        project: ctx.project,
        timestamp: new Date().toISOString(),
      })
      // Silent add (global-core-zero-friction): registration is already done —
      // assemble the relocated workspace in the BACKGROUND for every detected
      // provider. Never blocks or rolls back registration. Skipped when the
      // workspace is already populated (re-register of a relocated repo).
      try {
        const workspace = workspacePathFor(slug)
        const effectiveProviders = detectedNow.length > 0 ? detectedNow : providers
        if (!isWorkspacePopulated(workspace)) {
          ctx.setupManager.startSilentAssemble(id, canonicalPath, slug, effectiveProviders)
        }
      } catch (err) {
        console.warn('[desktop] silent assemble launch failed (non-fatal):', err)
      }
      res.status(201).json({ project: ctx.project, has_specrails: specrailsInstalled })
    } catch (err) {
      const message = (err as Error).message ?? ''
      // SQLite UNIQUE constraint violation means path or slug already registered
      if (err instanceof RepositoryValidationError) {
        res.status(err.status).json({ error: err.message, code: err.code, details: err.details })
      } else if (message.includes('UNIQUE')) {
        res.status(409).json({ error: 'A project with this path is already registered' })
      } else {
        console.error('[desktop] add project error:', err)
        res.status(500).json({ error: 'Failed to register project' })
      }
    }
  })

  // POST /api/projects/:id/assemble-retry — re-run the silent workspace
  // assemble for the providers that failed (or every detected provider when
  // nothing is recorded as failed). 202; progress rides project.assemble_progress.
  router.post('/projects/:id/assemble-retry', async (req, res) => {
    const ctx = registry.getContext(req.params.id)
    if (!ctx) {
      res.status(404).json({ error: 'unknown project' })
      return
    }
    const state = ctx.setupManager.silentAssembleState(ctx.project.id)
    if (state.running) {
      res.status(202).json({ alreadyRunning: true })
      return
    }
    let providers = state.failed
    if (providers.length === 0) {
      try {
        providers = (await getDetectionSnapshot()).detected
      } catch {
        providers = []
      }
    }
    if (providers.length === 0) {
      res.status(409).json({ error: 'no providers detected to assemble' })
      return
    }
    ctx.setupManager.startSilentAssemble(ctx.project.id, ctx.project.path, ctx.project.slug, providers)
    res.status(202).json({ retrying: providers })
  })

  // DELETE /api/projects/:id — unregister a project
  router.delete('/projects/:id', (req, res) => {
    const { id } = req.params
    if (!registry.getProjectRow(id)) {
      res.status(404).json({ error: 'Project not found' })
      return
    }

    registry.removeProject(id)
    broadcast({
      type: 'desktop.project_removed',
      projectId: id,
      timestamp: new Date().toISOString(),
    })
    res.json({ ok: true })
  })
}

/** Repository membership of a logical project, and `/resolve` (path → project). */
export function registerProjectRepositoryRoutes(router: Router, deps: {
  registry: ProjectRegistry
  broadcast: (msg: WsMessage) => void
}): void {
  const { registry, broadcast } = deps
  // The logical project keeps one backlog; these routes only edit membership.
  const broadcastRepositories = (): void => broadcast({ type: 'desktop.projects', projects: listProjects(registry.desktopDb), timestamp: new Date().toISOString() })
  router.get('/projects/:projectId/repositories', (req, res) => {
    const project = listProjects(registry.desktopDb).find((item) => item.id === req.params.projectId)
    if (!project) { res.status(404).json({ error: 'Project not found' }); return }
    res.json({ repositories: getProjectRepositories(project), primaryRepositoryId: project.primaryRepositoryId })
  })
  router.post('/projects/:projectId/repositories', (req, res) => {
    try {
      const input = inspectRepositoryPath(req.body)
      if (!isPathSafe(input.path)) throw new RepositoryValidationError('Registering system directories is not allowed')
      const repository = registry.addRepository(req.params.projectId as string, input)
      broadcastRepositories()
      res.status(201).json({ repository, project: registry.getProjectRow(req.params.projectId as string) })
    } catch (err) { sendRepositoryError(err, res) }
  })
  router.patch('/projects/:projectId/repositories/:repositoryId', (req, res) => {
    try {
      const body = req.body ?? {}
      const input: Partial<ProjectRepositoryInput> = {}
      for (const key of ['path', 'name', 'integrationBranch', 'workspacePath', 'workspacePaths'] as const) if (Object.prototype.hasOwnProperty.call(body, key)) Object.assign(input, { [key]: body[key] })
      if (input.path !== undefined) {
        const inspected = inspectRepositoryPath(input as ProjectRepositoryInput)
        if (!isPathSafe(inspected.path)) throw new RepositoryValidationError('Registering system directories is not allowed')
        input.path = inspected.path
      }
      const repository = registry.updateRepository(req.params.projectId as string, req.params.repositoryId as string, input)
      broadcastRepositories()
      res.json({ repository, project: registry.getProjectRow(req.params.projectId as string) })
    } catch (err) { sendRepositoryError(err, res) }
  })
  router.delete('/projects/:projectId/repositories/:repositoryId', (req, res) => {
    try {
      registry.removeRepository(req.params.projectId as string, req.params.repositoryId as string)
      broadcastRepositories()
      res.json({ ok: true, project: registry.getProjectRow(req.params.projectId as string) })
    } catch (err) { sendRepositoryError(err, res) }
  })

  // GET /api/resolve?path=<cwd> — resolve a project from a filesystem path
  router.get('/resolve', (req, res) => {
    const queryPath = req.query.path as string | undefined
    if (!queryPath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
      const project = resolveRepositoryProject(listProjects(registry.desktopDb), queryPath, projectId)
      if (!project) { res.status(404).json({ error: 'No project registered for this path' }); return }
      const context = registry.getContext(project.id)
      if (!context) { res.status(503).json({ error: 'Project is registered but unavailable', code: 'project_unavailable', project }); return }
      registry.touchProject(project.id)
      res.json({ project: context.project })
    } catch (err) { sendRepositoryError(err, res) }
  })
}

function sendRepositoryError(err: unknown, res: import('express').Response): void {
  if (err instanceof RepositoryValidationError) res.status(err.status).json({ error: err.message, code: err.code, details: err.details })
  else { console.error('[desktop] repository operation failed:', err); res.status(500).json({ error: 'Could not update project repositories' }) }
}

