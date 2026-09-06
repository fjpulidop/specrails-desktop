import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { SpawnOptions } from 'child_process'
import { spawnCli, windowsSpawnEnv } from './util/win-spawn'
import type { WsMessage } from './types'
import type { ProjectRegistry } from './project-registry'
import { listProjects } from './desktop-db'
import { getBlueprintConversation, markBlueprintCommitted } from './blueprint-store'
import { hasAdapter } from './providers'
import { coerceBlueprint } from './blueprint-draft-parser'
import { Blueprint, M1_SPECS_MAX, M1_SPECS_MIN } from './blueprint-types'
import { analyzeBuilderSpecBatch, firstBuilderSpecQualityDetail } from './blueprint-spec-quality'
import { writeBlueprintPair } from './blueprint-render'
import { assembleProjectOffline, canAssembleProject } from './offline-assemble'
import { resolveArtifacts } from './artifact-registry'
import { workspacePathFor } from './workspace-manager'
import { mutateStore, type Ticket, type TicketStore } from './ticket-store'
import { formatDescriptionWithCriteria } from './project-router-helpers'

// ─── Orchestrated project-bootstrap commit (add-project-builder D3) ───────────
//
// ONE endpoint turns an approved blueprint into a registered project. Strict
// ordering with register-project-LAST: a crash mid-flight leaves an orphan
// directory (invisible, user-resolvable), never a zombie half-project in the
// sidebar. `gh repo create` is best-effort — a failure surfaces as a warning
// step and never aborts. All IO is injectable (DI bag) so unit tests can fail
// any individual step and assert the crash posture.

export interface BlueprintCommitInput {
  blueprint?: unknown
  name?: unknown
  location?: unknown
  providers?: unknown
  createGithubRepo?: unknown
  /** The Builder conversation the blueprint came from — linked to the new
   *  project on success so the resume list stops offering it. Optional and
   *  ignored when unknown (a stale client can never block a commit). */
  conversationId?: unknown
}

export type BlueprintCommitValidation =
  | {
      ok: true
      blueprint: Blueprint
      name: string
      location: string
      providers: string[]
      createGithubRepo: boolean
      conversationId: string | null
    }
  | { ok: false; error: string; detail?: string }

export interface BlueprintCommitRunner {
  validate(input: BlueprintCommitInput): BlueprintCommitValidation
  /** Kick off the orchestration (validation MUST have passed). Returns commitId. */
  start(input: BlueprintCommitInput): string
}

export interface BlueprintCommitIO {
  hasCore: () => boolean
  mkdir: (dir: string) => void
  /** Run a CLI (git / gh) to completion; resolves exit code + stderr tail. */
  exec: (bin: string, args: string[], cwd: string) => Promise<{ code: number | null; stderr: string }>
  assemble: (opts: { projectPath: string; slug: string; desktopProjectId: string; providers: string[] }) => Promise<void>
  writePair: (workspaceDir: string, blueprint: Blueprint) => void
  mutateTickets: (filePath: string, fn: (store: TicketStore) => void) => void
  registerProject: (opts: { id: string; slug: string; name: string; path: string; providers: string[] }) => void
  /** Link the Builder conversation to the project it created (best-effort). */
  markCommitted: (conversationId: string, projectId: string) => void
}

export interface BlueprintCommitDeps {
  registry: ProjectRegistry
  broadcast: (msg: WsMessage) => void
  io?: Partial<BlueprintCommitIO>
}

function execCli(bin: string, args: string[], cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const opts: SpawnOptions = { cwd, env: windowsSpawnEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    const child = spawnCli(bin, args, opts)
    const stderrChunks: string[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()))
    child.stdout?.resume()
    child.once('error', (err) => resolve({ code: null, stderr: err.message }))
    child.once('close', (code) => {
      resolve({ code, stderr: stderrChunks.join('').split('\n').filter(Boolean).slice(-5).join(' ').slice(0, 500) })
    })
  })
}

/** Machine-readable classification of a failed github step (rides commit_progress.code). */
export type GhStepCode =
  | 'gh_not_installed'
  | 'gh_not_authenticated'
  | 'gh_scope'
  | 'gh_repo_exists'
  | 'gh_network'
  | 'gh_failed'

/** Classify `gh repo create` stderr into a stable code the client can i18n. */
export function classifyGhCreateError(stderr: string): GhStepCode {
  const s = stderr.toLowerCase()
  if (/not logged in|gh auth login|authentication|http 401/.test(s)) return 'gh_not_authenticated'
  if (/http 403|forbidden|scope|permission/.test(s)) return 'gh_scope'
  if (/already exists/.test(s)) return 'gh_repo_exists'
  if (/could not resolve|dial tcp|timeout|connection|network|no such host/.test(s)) return 'gh_network'
  return 'gh_failed'
}

function expandLocation(raw: string): string {
  const home = process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
  const expanded = raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(home, raw.slice(2)) : raw
  return path.resolve(expanded)
}

/** Deterministic README from the blueprint pitch — the commit must stay
 *  offline-capable, so no AI call here (design open question, pinned). */
export function renderReadme(blueprint: Blueprint, name: string): string {
  const lines: string[] = [`# ${name}`, '']
  if (blueprint.product.pitch) lines.push(blueprint.product.pitch, '')
  if (blueprint.coreFlow) lines.push(`**Core flow:** ${blueprint.coreFlow}`, '')
  const stackBits = [blueprint.stack.language, blueprint.stack.framework, blueprint.stack.db].filter(Boolean)
  if (stackBits.length > 0) lines.push(`**Stack:** ${stackBits.join(' · ')}`, '')
  lines.push('---', '', '_Bootstrapped with the Specrails Project Builder._', '')
  return lines.join('\n')
}

/** Mirrors desktop-router's slugify/allocateSlug (kept local — same contract). */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function allocateSlug(name: string, existing: ReadonlySet<string>): string {
  let base = slugifyName(name)
  if (base === '') base = 'project'
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function dirMissingOrEmpty(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir)
    return entries.length === 0
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export function createBlueprintCommitRunner(deps: BlueprintCommitDeps): BlueprintCommitRunner {
  const io: BlueprintCommitIO = {
    hasCore: deps.io?.hasCore ?? canAssembleProject,
    mkdir: deps.io?.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true })),
    exec: deps.io?.exec ?? execCli,
    assemble: deps.io?.assemble ?? (async (opts) => { await assembleProjectOffline(opts) }),
    writePair: deps.io?.writePair ?? writeBlueprintPair,
    mutateTickets: deps.io?.mutateTickets ?? ((filePath, fn) => { mutateStore(filePath, fn) }),
    markCommitted:
      deps.io?.markCommitted ??
      ((conversationId, projectId) => {
        markBlueprintCommitted(deps.registry.desktopDb, conversationId, projectId)
      }),
    registerProject:
      deps.io?.registerProject ??
      ((opts) => {
        const ctx = deps.registry.addProject({
          id: opts.id,
          slug: opts.slug,
          name: opts.name,
          path: opts.path,
          provider: opts.providers[0] as never,
          providers: opts.providers as never,
        })
        deps.broadcast({
          type: 'desktop.project_added',
          project: ctx.project,
          timestamp: new Date().toISOString(),
        } as WsMessage)
      }),
  }

  const validate = (input: BlueprintCommitInput): BlueprintCommitValidation => {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) return { ok: false, error: 'invalid_name' }

    if (typeof input.location !== 'string' || !input.location.trim()) {
      return { ok: false, error: 'invalid_location' }
    }
    const location = expandLocation(input.location.trim())

    const providers = Array.isArray(input.providers)
      ? [...new Set((input.providers as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0))]
      : []
    if (providers.length === 0) return { ok: false, error: 'providers_required' }
    for (const p of providers) {
      if (!hasAdapter(p)) return { ok: false, error: 'unknown_provider', detail: p }
    }

    const blueprint = coerceBlueprint(input.blueprint)
    if (!blueprint) return { ok: false, error: 'invalid_blueprint' }
    if (blueprint.m1Specs.length === 0) {
      return { ok: false, error: 'm1_specs_required' }
    }
    if (blueprint.m1Specs.length > M1_SPECS_MAX) {
      return { ok: false, error: 'm1_specs_over_cap', detail: `max ${M1_SPECS_MAX}` }
    }
    const rawBlueprint = input.blueprint as Record<string, unknown>
    if (Array.isArray(rawBlueprint.m1Specs) && rawBlueprint.m1Specs.some((spec) => spec && typeof spec === 'object' && Object.prototype.hasOwnProperty.call(spec, 'repositoryIds'))) {
      return { ok: false, error: 'invalid_repository_ids', detail: 'A new Builder project uses its primary repository. Add repository scope after the project and its repository IDs exist.' }
    }
    const quality = analyzeBuilderSpecBatch(
      {
        specsComplete: rawBlueprint.specsComplete,
        specs: Array.isArray(rawBlueprint.m1Specs) ? rawBlueprint.m1Specs : [],
      },
      { milestoneLabel: 'M1', minSpecs: M1_SPECS_MIN, maxSpecs: M1_SPECS_MAX, requireScaffold: true },
    )
    if (!quality.valid) {
      return { ok: false, error: 'm1_spec_quality_invalid', detail: firstBuilderSpecQualityDetail(quality) }
    }

    if (!io.hasCore()) {
      // Only a packaged desktop build with a missing/corrupted bundle lands
      // here (dev + runtimes-less servers fall back to npx — see
      // canAssembleProject). Keep the "reinstall" message for that case.
      return { ok: false, error: 'bundled_framework_missing', detail: 'The bundled framework is missing — reinstall the Specrails app.' }
    }

    if (!dirMissingOrEmpty(location)) {
      return { ok: false, error: 'location_not_empty', detail: location }
    }

    // No existing registry entry may map this repo path (an entry means a
    // workspace already belongs to some other project for this realpath).
    try {
      if (fs.existsSync(location) && resolveArtifacts(location).entry) {
        return { ok: false, error: 'location_already_registered', detail: location }
      }
    } catch {
      /* unreadable registry — never block on the projection; addProject re-mirrors */
    }

    const conversationId = typeof input.conversationId === 'string' && input.conversationId
      && getBlueprintConversation(deps.registry.desktopDb, input.conversationId)
      ? input.conversationId
      : null

    return { ok: true, blueprint, name, location, providers, createGithubRepo: input.createGithubRepo === true, conversationId }
  }

  const start = (input: BlueprintCommitInput): string => {
    const validated = validate(input)
    if (!validated.ok) throw new Error(`invalid commit input: ${validated.error}`)
    const commitId = randomUUID()
    void run(commitId, validated)
    return commitId
  }

  const emit = (
    commitId: string,
    step: string,
    status: 'running' | 'done' | 'warning' | 'failed',
    detail?: string,
    code?: GhStepCode,
  ): void => {
    deps.broadcast({
      type: 'blueprint.commit_progress',
      commitId,
      step,
      status,
      ...(detail ? { detail } : {}),
      ...(code ? { code } : {}),
      timestamp: new Date().toISOString(),
    } as WsMessage)
  }

  const run = async (
    commitId: string,
    v: Extract<BlueprintCommitValidation, { ok: true }>,
  ): Promise<void> => {
    const { blueprint, name, location, providers } = v
    const projectId = randomUUID()
    const existingSlugs = new Set(listProjects(deps.registry.desktopDb).map((p) => p.slug))
    const slug = allocateSlug(name, existingSlugs)
    let step = 'create-dir'
    try {
      // 1. create target directory
      emit(commitId, step, 'running')
      io.mkdir(location)
      emit(commitId, step, 'done')

      // 2. git init -b main + deterministic README + initial commit
      step = 'git-init'
      emit(commitId, step, 'running')
      const init = await io.exec('git', ['init', '-b', 'main'], location)
      if (init.code !== 0) throw new Error(`git init failed: ${init.stderr || `exit ${init.code}`}`)
      fs.writeFileSync(path.join(location, 'README.md'), renderReadme(blueprint, name), 'utf-8')
      const add = await io.exec('git', ['add', 'README.md'], location)
      if (add.code !== 0) throw new Error(`git add failed: ${add.stderr || `exit ${add.code}`}`)
      const commit = await io.exec(
        'git',
        ['-c', 'user.name=Specrails', '-c', 'user.email=builder@specrails.dev', 'commit', '-m', 'Initial commit'],
        location,
      )
      if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || `exit ${commit.code}`}`)
      emit(commitId, step, 'done')

      // 3. registry allocation + offline workspace assemble (per provider)
      step = 'assemble'
      emit(commitId, step, 'running')
      await io.assemble({ projectPath: location, slug, desktopProjectId: projectId, providers })
      emit(commitId, step, 'done')

      const workspace = workspacePathFor(slug)

      // 4. blueprint pair into the workspace (repo stays pristine)
      step = 'blueprint'
      emit(commitId, step, 'running')
      io.writePair(workspace, blueprint)
      emit(commitId, step, 'done')

      // 5. insert M1 tickets (todo, label M1, scaffold first, advisory ids back)
      step = 'tickets'
      emit(commitId, step, 'running')
      const insertedIds: number[] = []
      const ticketsPath = path.join(workspace, '.specrails', 'local-tickets.json')
      io.mutateTickets(ticketsPath, (store) => {
        const indexToId = new Map<number, number>()
        blueprint.m1Specs.forEach((spec, index) => {
          const id = store.next_id
          store.next_id += 1
          const now = new Date().toISOString()
          const labels = spec.labels.includes('M1') ? spec.labels.slice() : [...spec.labels, 'M1']
          const prereqIndex = spec.dependsOnIndex
          const prerequisites =
            prereqIndex !== undefined && indexToId.has(prereqIndex) ? [indexToId.get(prereqIndex)!] : []
          const ticket: Ticket = {
            id,
            title: spec.title,
            description: formatDescriptionWithCriteria(spec.description, spec.acceptanceCriteria),
            status: 'todo',
            priority: spec.priority,
            labels,
            assignee: null,
            prerequisites,
            metadata: {},
            origin_conversation_id: null,
            is_epic: false,
            parent_epic_id: null,
            execution_order: index + 1,
            short_summary: spec.shortSummary,
            created_at: now,
            updated_at: now,
            created_by: 'project-builder',
            source: 'project-builder',
          }
          store.tickets[String(id)] = ticket
          indexToId.set(index, id)
          insertedIds.push(id)
        })
      })
      // Record advisory ids + flip M1 → committed, then re-render the pair.
      const m1 = blueprint.milestones.find((m) => m.id === 'm1') ?? blueprint.milestones[0]
      if (m1) {
        m1.status = 'committed'
        m1.ticketIds = insertedIds
      }
      io.writePair(workspace, blueprint)
      emit(commitId, step, 'done')

      // 6. register the project — LAST mutation before the optional remote
      step = 'register'
      emit(commitId, step, 'running')
      io.registerProject({ id: projectId, slug, name, path: location, providers })
      emit(commitId, step, 'done')
      if (v.conversationId) {
        try {
          io.markCommitted(v.conversationId, projectId)
        } catch (err) {
          console.warn(`[blueprint-commit] could not link conversation ${v.conversationId}:`, (err as Error).message)
        }
      }

      // 7. best-effort GitHub remote — never aborts. Pre-flight guards against
      // a stale client cache sending createGithubRepo with gh absent/unauthed.
      if (v.createGithubRepo) {
        step = 'github'
        emit(commitId, step, 'running')
        try {
          const auth = await io.exec('gh', ['auth', 'token'], location)
          if (auth.code === null) {
            emit(commitId, step, 'warning', auth.stderr || 'gh not found', 'gh_not_installed')
          } else if (auth.code !== 0) {
            emit(commitId, step, 'warning', auth.stderr || `gh auth token exited with ${auth.code}`, 'gh_not_authenticated')
          } else {
            const gh = await io.exec('gh', ['repo', 'create', slug, '--private', '--source', '.', '--push'], location)
            if (gh.code === 0) {
              emit(commitId, step, 'done')
            } else {
              const detail = gh.stderr || `gh exited with ${gh.code}`
              emit(commitId, step, 'warning', detail, classifyGhCreateError(detail))
            }
          }
        } catch (err) {
          emit(commitId, step, 'warning', (err as Error).message, 'gh_failed')
        }
      }

      deps.broadcast({
        type: 'blueprint.commit_done',
        commitId,
        projectId,
        timestamp: new Date().toISOString(),
      } as WsMessage)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[blueprint-commit] failed at ${step}:`, message)
      emit(commitId, step, 'failed', message)
      deps.broadcast({
        type: 'blueprint.commit_failed',
        commitId,
        step,
        error: message,
        timestamp: new Date().toISOString(),
      } as WsMessage)
    }
  }

  return { validate, start }
}
