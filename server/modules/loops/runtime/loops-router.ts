import { defaultLoopAgents } from './loop-agents'
import { validateLoopRuntimeSettings, loadRuntimeRolePrompts } from '../../agent-runtime/runtime/agent-runtime-settings'
/**
 * Loops REST surface — registered onto the GLOBAL desktop router (`/api`), so
 * the routes live at `/api/loops*` (cross-project; loops are a global library).
 * Mirrors the `register<Domain>Routes(router, deps)` pattern used by the
 * project-router domains, keeping desktop-router.ts thin.
 *
 * Gated by `isLoopsEnabled()` — when off, every route 404s (emergency rollback).
 */
import type { Router, Request, Response } from 'express'
import type { DbInstance } from '../../../db'
import { newId } from '../../../ids'
import { isLoopsEnabled } from '../../../feature-flags'
import {
  listLoops,
  getLoop,
  readLegacyLoopGraph,
  createLoop,
  updateLoop,
  publishLoop,
  unpublishLoop,
  duplicateLoop,
  deleteLoop,
  importLoops,
  LoopValidationError,
  LoopPublicationConflict,
} from './loops-store'
import { isDefinitionGraph, type LoopGraph } from './loop-graph'
import { compileLoopToDefinition } from './loop-definition'
import { convertLegacyLoop } from './loop-compat'
import { assessLoopMigration } from './loop-migration'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { loopTemplatesForCapabilities, getLoopTemplate } from './loop-templates'
import { factoryLoopsForCapabilities } from './loop-factory'
import { ensureBuiltinLoops, resolveBuiltinLoop, restoreBuiltin, type BuiltinLoopEnvironment } from './builtin-loops'
import { LOOP_COMMANDS } from './loop-command-catalog'
import { listConstants, createConstant, updateConstant, deleteConstant, loadConstantMap, LoopConstantError } from './loop-constants'
import { previewLoop } from './loop-preview'

export interface LoopsRoutesDeps {
  db: DbInstance
  /** True iff a loop is currently executing in any project (derived from active
   *  loop_runs). Update/unpublish/delete are rejected (409) while running.
   *  Defaults to "never running" until the run engine is wired (F6/F7). */
  isLoopRunning?: (loopId: string) => boolean
  /** Seed the editable built-in rows (at registration and on `GET /loops`).
   *  Omitted by focused tests that exercise a plain library. */
  builtinLoops?: BuiltinLoopEnvironment
}

const BUILTIN_DELETE_MESSAGE = 'Built-in loops cannot be deleted. Use Restore original to reset it, or Duplicate it to keep a separate copy.'

async function factoryCapabilities(): Promise<Record<string, number> | undefined> {
  try { return (await loadCoreAgentRuntime()).api?.capabilities } catch { return undefined }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function registerLoopsRoutes(router: Router, deps: LoopsRoutesDeps): void {
  const { db } = deps
  const isRunning = deps.isLoopRunning ?? (() => false)
  const isBuiltin = (id: string): boolean => Boolean(getLoop(db, id)?.builtinId)

  // One seeding pass at a time; later calls re-check (Core may have appeared or
  // changed) and are cheap because the Core API probe is cached by fingerprint.
  let seeding: Promise<unknown> | null = null
  function seedBuiltins(): Promise<unknown> {
    if (!deps.builtinLoops) return Promise.resolve()
    if (!seeding) {
      seeding = ensureBuiltinLoops(db, deps.builtinLoops)
        .catch((error: unknown) => { console.warn('[loops] built-in loop seeding failed:', error instanceof Error ? error.message : error) })
        .finally(() => { seeding = null })
    }
    return seeding
  }
  // Startup: the registry (and its desktop DB) exists when routes are registered.
  // The Core API probe is synchronous on first use, so defer it past startup
  // (and the listen call) instead of delaying the server by the probe timeout.
  if (isLoopsEnabled() && deps.builtinLoops) setImmediate(() => { void seedBuiltins() }).unref?.()

  // Single gate: every loops route 404s when the feature is disabled.
  function guard(res: Response): boolean {
    if (!isLoopsEnabled()) {
      res.status(404).json({ error: 'Not Found' })
      return false
    }
    return true
  }

  router.get('/loop-agent-defaults', async (_req, res) => {
    if (!guard(res)) return
    const runtime = await loadCoreAgentRuntime().catch(() => null)
    // `inherit` definitions resolve at launch; the editor previews what they resolve to today.
    const rolePromptDefaults = runtime ? { ...runtime.rolePromptDefaults(), ...loadRuntimeRolePrompts() } : null
    res.json({ agents: defaultLoopAgents(), rolePromptDefaults, guardrails: { supported: runtime?.api?.capabilities?.configurableGuardrails === 1, catalog: runtime?.api?.guardrails ?? [] } })
  })

  // ── Templates ──────────────────────────────────────────────────────────────
  router.get('/loop-templates', async (_req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({
      templates: loopTemplatesForCapabilities(await factoryCapabilities()).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        tags: t.tags,
        // Include the graph so the gallery can render a read-only preview modal
        // (steps/prompts/decider goal) before the user clones it.
        graph: t.graph,
      })),
    })
  })

  // ── List / get ───────────────────────────────────────────────────────────────
  router.get('/loops', async (_req: Request, res: Response) => {
    if (!guard(res)) return
    await seedBuiltins()
    res.json({ loops: listLoops(db) })
  })

  // Magic-command catalog for the builder palette (drives the AI Step chips).
  // Registered BEFORE `/loops/:id` so "commands" is not captured as an id.
  router.get('/loops/commands', (_req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({ commands: LOOP_COMMANDS.map((c) => ({ name: c.name, label: c.label, description: c.description })) })
  })

  // Catalog belongs to the installed runtime; global authoring has no project state.
  router.get('/loops/catalog', async (_req: Request, res: Response) => {
    if (!guard(res)) return
    try {
      const runtime = await loadCoreAgentRuntime()
      if (runtime.api?.capabilities?.engineV2 !== 1 || !runtime.listWorkflows) {
        res.status(409).json({ error: 'engine_unsupported', message: 'Update Core to author executable workflows.' }); return
      }
      res.json(runtime.listWorkflows())
    } catch (error) { res.status(503).json({ error: 'runtime_catalog_unavailable', message: error instanceof Error ? error.message : 'Core catalog unavailable' }) }
  })

  // ── Factory loops (built-ins) ────────────────────────────────────────────────
  // Registered BEFORE `/loops/:id` so "factory" is not captured as an id. Kept
  // for companion/mobile/MCP back-compat: each entry reflects its editable row
  // when seeded (name, description and the graph a rail launch would run).
  router.get('/loops/factory', async (_req: Request, res: Response) => {
    if (!guard(res)) return
    await seedBuiltins()
    const capabilities = await factoryCapabilities()
    res.json({
      factoryLoops: factoryLoopsForCapabilities(capabilities).map((f) => {
        const resolved = resolveBuiltinLoop(db, f.id, capabilities)
        return {
          id: f.id,
          name: resolved?.name ?? f.name,
          description: resolved?.description ?? f.description,
          mode: f.mode,
          requiredCapability: f.requiredCapability ?? null,
          // Absent means launchable (every pre-existing factory loop is).
          launchable: f.launchable !== false,
          graph: resolved?.graph ?? f.graph,
          // Seeded built-ins are ordinary loops: edit them via PUT /loops/:id.
          editable: Boolean(resolved?.row),
          status: resolved?.row?.status ?? 'published',
          modified: resolved?.row?.builtinModified ?? false,
        }
      }),
    })
  })

  // Back-compat alias of `POST /loops/:id/duplicate` for a built-in: creates a
  // separate Draft from the built-in's current content (the built-in is unchanged).
  router.post('/loops/factory/:id/fork', async (req: Request, res: Response) => {
    if (!guard(res)) return
    const resolved = resolveBuiltinLoop(db, req.params.id as string, await factoryCapabilities())
    if (!resolved) {
      res.status(404).json({ error: 'Factory loop not found' })
      return
    }
    const body = req.body ?? {}
    const name = isNonEmptyString(body.name) ? body.name.trim() : `${resolved.name} (fork)`
    const source = resolved.row ?? { description: resolved.description, graph: resolved.graph }
    const loop = createLoop(db, { id: newId(), name, description: source.description, graph: source.graph })
    res.status(201).json({ loop })
  })

  // ── Constants library (global, cross-loop) ─────────────────────────────────
  // Registered BEFORE `/loops/:id` so "constants" is not captured as a loop id.
  // The 4xx mapping mirrors the LoopConstantError codes.
  const constantErrorStatus: Record<string, number> = {
    invalid_name: 400, reserved_name: 400, missing_value: 400, duplicate: 409, not_found: 404,
  }
  function sendConstantError(res: Response, err: unknown): void {
    if (err instanceof LoopConstantError) {
      res.status(constantErrorStatus[err.code] ?? 400).json({ error: err.message, code: err.code })
    } else {
      res.status(500).json({ error: 'Failed to save constant' })
    }
  }

  router.get('/loops/constants', (_req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({ constants: listConstants(db) })
  })

  router.post('/loops/constants', (req: Request, res: Response) => {
    if (!guard(res)) return
    const body = req.body ?? {}
    try {
      const constant = createConstant(db, { id: newId(), name: String(body.name ?? ''), value: String(body.value ?? '') })
      res.status(201).json({ constant })
    } catch (err) {
      sendConstantError(res, err)
    }
  })

  router.put('/loops/constants/:id', (req: Request, res: Response) => {
    if (!guard(res)) return
    try {
      const constant = updateConstant(db, req.params.id as string, String((req.body ?? {}).value ?? ''))
      res.json({ constant })
    } catch (err) {
      sendConstantError(res, err)
    }
  })

  router.delete('/loops/constants/:id', (req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({ deleted: deleteConstant(db, req.params.id as string) })
  })

  // Dry-run preview: resolve every step's tokens (cmd/spec-sample/const) and
  // return the exact text that would be sent — no spawn. Registered BEFORE
  // `/loops/:id`. Stateless: the (possibly unsaved) graph is in the body.
  router.post('/loops/preview', (req: Request, res: Response) => {
    if (!guard(res)) return
    const body = (req.body ?? {}) as { graph?: LoopGraph; provider?: unknown }
    if (!body.graph || !Array.isArray(body.graph.nodes)) {
      res.status(400).json({ error: "body must include a 'graph'" })
      return
    }
    const provider = typeof body.provider === 'string' ? body.provider : 'claude'
    try { res.json(previewLoop(body.graph, { provider, constants: loadConstantMap(db) })) }
    catch (error) { res.status(400).json({ errors: [{ code: 'definition_invalid', message: error instanceof Error ? error.message : 'Invalid workflow' }] }) }
  })

  // Import loops from an export envelope. Duplicate NAMES are skipped (returned
  // in `skipped`); the rest land as fresh Drafts. Registered BEFORE `/loops/:id`.
  router.post('/loops/import', (req: Request, res: Response) => {
    if (!guard(res)) return
    const body = (req.body ?? {}) as { loops?: unknown }
    if (!Array.isArray(body.loops)) {
      res.status(400).json({ error: "body must include a 'loops' array" })
      return
    }
    res.json(importLoops(db, body.loops, newId))
  })

  // Read-only migration assessment; registered before `/loops/:id`. It never
  // converts or (un)publishes: conversion stays an explicit, reviewable step.
  router.get('/loops/migration', async (_req: Request, res: Response) => {
    if (!guard(res)) return
    try {
      const runtime = await loadCoreAgentRuntime()
      const catalog = runtime.listWorkflows?.()
      if (runtime.api?.capabilities?.engineV2 !== 1 || runtime.api?.capabilities?.workflowDefinitions !== 1 || !catalog || catalog.nodeKindsVersion < 5) {
        res.status(409).json({ error: 'engine_unsupported', message: 'Migration assessment requires Core catalog version 5 or later.' }); return
      }
      const constants = loadConstantMap(db)
      res.json(assessLoopMigration(listLoops(db), {
        isRunning,
        validate: (loop, graph) => {
          const definition = compileLoopToDefinition(graph, { id: loop.id, title: loop.name, constants, provider: 'claude', spec: { id: 1, title: 'Sample spec', description: 'Migration assessment' } })
          const validation = runtime.validateWorkflowDefinition(definition, { structural: true })
          return validation.ok ? { ok: true } : { ok: false, errors: validation.errors.map(error => ({ ...error, nodeId: error.nodeId ?? error.path?.match(/^\/nodes\/([^/]+)/)?.[1] })) }
        },
      }))
    } catch (error) {
      res.status(503).json({ error: 'runtime_validation_unavailable', message: error instanceof Error ? error.message : 'Core validation unavailable' })
    }
  })

  router.get('/loops/:id/legacy-graph', (req: Request, res: Response) => {
    if (!guard(res)) return
    const backup = readLegacyLoopGraph(db, req.params.id as string)
    if (!backup) { res.status(404).json({ error: 'Original legacy graph not found' }); return }
    res.json(backup)
  })

  router.get('/loops/:id', (req: Request, res: Response) => {
    if (!guard(res)) return
    const loop = getLoop(db, req.params.id as string)
    if (!loop) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    res.json({ loop })
  })

  // ── Create ───────────────────────────────────────────────────────────────────
  router.post('/loops', (req: Request, res: Response) => {
    if (!guard(res)) return
    const body = req.body ?? {}
    if (!isNonEmptyString(body.name)) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const loop = createLoop(db, {
      id: newId(),
      name: body.name.trim(),
      description: typeof body.description === 'string' ? body.description : null,
      graph: isPlainObject(body.graph) ? (body.graph as LoopGraph) : undefined,
    })
    res.status(201).json({ loop })
  })

  // ── Instantiate from a template ───────────────────────────────────────────────
  router.post('/loops/from-template/:templateId', async (req: Request, res: Response) => {
    if (!guard(res)) return
    const template = getLoopTemplate(req.params.templateId as string, await factoryCapabilities())
    if (!template) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    const body = req.body ?? {}
    const name = isNonEmptyString(body.name) ? body.name.trim() : template.name
    const loop = createLoop(db, {
      id: newId(),
      name,
      description: template.description,
      graph: template.graph,
    })
    res.status(201).json({ loop })
  })

  // ── Update (reverts to Draft) ─────────────────────────────────────────────────
  router.put('/loops/:id', (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    if (!getLoop(db, id)) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    // Runs freeze a clone of their graph at launch, and built-in launches use
    // the last Published snapshot while an edit is Draft, so a running built-in
    // stays editable. Other loops keep the conservative running guard.
    if (!isBuiltin(id) && isRunning(id)) {
      res.status(409).json({ error: 'Loop is running; stop the run before editing' })
      return
    }
    const body = req.body ?? {}
    if (body.name !== undefined && !isNonEmptyString(body.name)) {
      res.status(400).json({ error: 'name must be a non-empty string' })
      return
    }
    if (body.graph !== undefined && !isPlainObject(body.graph)) {
      res.status(400).json({ error: 'graph must be an object' })
      return
    }
    const loop = updateLoop(db, id, {
      name: isNonEmptyString(body.name) ? body.name.trim() : undefined,
      description: body.description !== undefined ? body.description : undefined,
      graph: isPlainObject(body.graph) ? (body.graph as LoopGraph) : undefined,
    })
    res.json({ loop })
  })

  // ── Publish / unpublish ───────────────────────────────────────────────────────
  router.post('/loops/:id/convert', async (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string, current = getLoop(db, id)
    if (!current) { res.status(404).json({ error: 'Loop not found' }); return }
    if (isRunning(id)) { res.status(409).json({ error: 'loop_running' }); return }
    if (isDefinitionGraph(current.graph) && readLegacyLoopGraph(db, id)) {
      res.json({ loop: current, nodeIds: {}, issues: [], alreadyConverted: true }); return
    }
    try {
      const converted = convertLegacyLoop(current.graph, {
        ...(typeof req.body?.repositoryId === 'string' && req.body.repositoryId.trim() ? { repositoryId: req.body.repositoryId.trim() } : {}),
      })
      if (!converted.ok) { res.status(422).json({ error: 'conversion_invalid', errors: converted.issues }); return }
      const runtime = await loadCoreAgentRuntime()
      const catalog = runtime.listWorkflows?.()
      if (runtime.api?.capabilities?.engineV2 !== 1 || runtime.api?.capabilities?.workflowDefinitions !== 1 ||
        !catalog || catalog.nodeKindsVersion < 5) {
        res.status(409).json({ error: 'engine_unsupported', message: 'Legacy conversion requires Core catalog version 5 or later.' }); return
      }
      const definition = compileLoopToDefinition(converted.graph, { id: current.id, title: current.name, constants: loadConstantMap(db), provider: 'claude', spec: { id: 1, title: 'Sample spec', description: 'Conversion preview' } })
      const validation = runtime.validateWorkflowDefinition(definition, { structural: true })
      if (!validation.ok) { res.status(422).json({ error: 'conversion_invalid', errors: validation.errors }); return }
      if (isRunning(id)) { res.status(409).json({ error: 'loop_running' }); return }
      const loop = updateLoop(db, id, { graph: converted.graph }, current)
      res.json({ loop, nodeIds: converted.nodeIds, issues: converted.issues })
    } catch (error) {
      if (error instanceof LoopPublicationConflict) { res.status(409).json({ error: 'loop_changed' }); return }
      res.status(400).json({ error: 'conversion_invalid', message: error instanceof Error ? error.message : 'Conversion failed' })
    }
  })

  router.post('/loops/:id/publish', async (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    if (!getLoop(db, id)) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    try {
      const current = getLoop(db, id)!
      if (isDefinitionGraph(current.graph)) {
        const runtime = await loadCoreAgentRuntime()
        if (runtime.api?.capabilities?.engineV2 !== 1 || runtime.api?.capabilities?.workflowDefinitions !== 1) {
          res.status(409).json({ error: 'engine_unsupported', message: 'Update Core to publish executable workflows.' }); return
        }
        if (current.graph.config.agents) {
          try { validateLoopRuntimeSettings(current.graph.config.agents) }
          catch (error) { res.status(422).json({ error: 'invalid_loop_agents', message: error instanceof Error ? error.message : 'Invalid loop agent settings' }); return }
        }
        let draft
        try { draft = compileLoopToDefinition(current.graph, { id: current.id, title: current.name, constants: loadConstantMap(db), provider: 'claude', spec: { id: 1, title: 'Sample spec', description: 'Publication preview' } }) }
        catch (error) { res.status(400).json({ errors: [{ code: 'definition_invalid', message: error instanceof Error ? error.message : 'Invalid workflow' }] }); return }
        const validation = runtime.validateWorkflowDefinition(draft, { structural: true })
        if (!validation.ok) {
          res.status(400).json({ errors: validation.errors.map(error => ({ ...error, nodeId: error.nodeId ?? error.path?.match(/^\/nodes\/([^/]+)/)?.[1] })) }); return
        }
      }
      const loop = publishLoop(db, id, current)
      res.json({ loop })
    } catch (err) {
      if (err instanceof LoopPublicationConflict) {
        res.status(409).json({ error: err.message, code: 'loop_changed' }); return
      }
      if (err instanceof LoopValidationError) {
        res.status(422).json({ error: 'Loop graph is invalid', errors: err.errors })
        return
      }
      res.status(503).json({ error: 'runtime_validation_unavailable', message: err instanceof Error ? err.message : 'Core validation unavailable' })
    }
  })

  router.post('/loops/:id/unpublish', (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    if (!getLoop(db, id)) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    if (isBuiltin(id)) {
      res.status(409).json({ error: 'builtin_loop', message: 'Built-in loops stay available on rails. Edit and publish it, or use Restore original.' })
      return
    }
    if (isRunning(id)) {
      res.status(409).json({ error: 'Loop is running; stop the run first' })
      return
    }
    res.json({ loop: unpublishLoop(db, id) })
  })

  // ── Restore a built-in to its current default ─────────────────────────────────
  router.post('/loops/:id/restore-builtin', async (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    if (!getLoop(db, id)) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    if (!isBuiltin(id)) {
      res.status(400).json({ error: 'not_builtin', message: 'Only built-in loops can be restored.' })
      return
    }
    if (isRunning(id)) {
      res.status(409).json({ error: 'loop_running', message: 'Loop is running; stop the run before restoring it' })
      return
    }
    const loop = await restoreBuiltin(db, id, deps.builtinLoops)
    if (!loop) { res.status(404).json({ error: 'Built-in loop default not found' }); return }
    res.json({ loop })
  })

  // ── Duplicate ─────────────────────────────────────────────────────────────────
  router.post('/loops/:id/duplicate', (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    const body = req.body ?? {}
    const src = getLoop(db, id)
    if (!src) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    const name = isNonEmptyString(body.name) ? body.name.trim() : `${src.name} (copy)`
    const loop = duplicateLoop(db, id, newId(), name)
    res.status(201).json({ loop })
  })

  // ── Delete ────────────────────────────────────────────────────────────────────
  router.delete('/loops/:id', (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    if (!getLoop(db, id)) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    if (isBuiltin(id)) {
      res.status(409).json({ error: 'builtin_loop', message: BUILTIN_DELETE_MESSAGE })
      return
    }
    if (isRunning(id)) {
      res.status(409).json({ error: 'Loop is running; stop the run before deleting' })
      return
    }
    deleteLoop(db, id)
    res.status(204).end()
  })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
