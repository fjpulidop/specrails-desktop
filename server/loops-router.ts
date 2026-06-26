/**
 * Loops REST surface — registered onto the GLOBAL desktop router (`/api`), so
 * the routes live at `/api/loops*` (cross-project; loops are a global library).
 * Mirrors the `register<Domain>Routes(router, deps)` pattern used by the
 * project-router domains, keeping desktop-router.ts thin.
 *
 * Gated by `isLoopsEnabled()` — when off, every route 404s (emergency rollback).
 */
import type { Router, Request, Response } from 'express'
import type { DbInstance } from './db'
import { newId } from './ids'
import { isLoopsEnabled } from './feature-flags'
import {
  listLoops,
  getLoop,
  createLoop,
  updateLoop,
  publishLoop,
  unpublishLoop,
  duplicateLoop,
  deleteLoop,
  importLoops,
  LoopValidationError,
} from './loops-store'
import type { LoopGraph } from './loop-graph'
import { LOOP_TEMPLATES, getLoopTemplate } from './loop-templates'
import { FACTORY_LOOPS, getFactoryLoop } from './loop-factory'
import { LOOP_COMMANDS } from './loop-command-catalog'
import { listConstants, createConstant, updateConstant, deleteConstant, loadConstantMap, LoopConstantError } from './loop-constants'
import { previewLoop } from './loop-preview'

export interface LoopsRoutesDeps {
  db: DbInstance
  /** True iff a loop is currently executing in any project (derived from active
   *  loop_runs). Update/unpublish/delete are rejected (409) while running.
   *  Defaults to "never running" until the run engine is wired (F6/F7). */
  isLoopRunning?: (loopId: string) => boolean
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

export function registerLoopsRoutes(router: Router, deps: LoopsRoutesDeps): void {
  const { db } = deps
  const isRunning = deps.isLoopRunning ?? (() => false)

  // Single gate: every loops route 404s when the feature is disabled.
  function guard(res: Response): boolean {
    if (!isLoopsEnabled()) {
      res.status(404).json({ error: 'Not Found' })
      return false
    }
    return true
  }

  // ── Templates ──────────────────────────────────────────────────────────────
  router.get('/loop-templates', (_req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({
      templates: LOOP_TEMPLATES.map((t) => ({
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
  router.get('/loops', (_req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({ loops: listLoops(db) })
  })

  // Magic-command catalog for the builder palette (drives the AI Step chips).
  // Registered BEFORE `/loops/:id` so "commands" is not captured as an id.
  router.get('/loops/commands', (_req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({ commands: LOOP_COMMANDS.map((c) => ({ name: c.name, label: c.label, description: c.description })) })
  })

  // ── Factory loops (built-in, locked) ─────────────────────────────────────────
  // Registered BEFORE `/loops/:id` so "factory" is not captured as an id.
  router.get('/loops/factory', (_req: Request, res: Response) => {
    if (!guard(res)) return
    res.json({
      factoryLoops: FACTORY_LOOPS.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description,
        mode: f.mode,
        claudeOnly: f.claudeOnly ?? false,
        graph: f.graph,
      })),
    })
  })

  // Fork a factory loop into a new editable user Draft (leaves the factory intact).
  router.post('/loops/factory/:id/fork', (req: Request, res: Response) => {
    if (!guard(res)) return
    const f = getFactoryLoop(req.params.id as string)
    if (!f) {
      res.status(404).json({ error: 'Factory loop not found' })
      return
    }
    const body = req.body ?? {}
    const name = isNonEmptyString(body.name) ? body.name.trim() : `${f.name} (fork)`
    const loop = createLoop(db, { id: newId(), name, description: f.description, graph: f.graph })
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
    res.json(previewLoop(body.graph, { provider, constants: loadConstantMap(db) }))
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
  router.post('/loops/from-template/:templateId', (req: Request, res: Response) => {
    if (!guard(res)) return
    const template = getLoopTemplate(req.params.templateId as string)
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
    if (isRunning(id)) {
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
  router.post('/loops/:id/publish', (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    if (!getLoop(db, id)) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    try {
      const loop = publishLoop(db, id)
      res.json({ loop })
    } catch (err) {
      if (err instanceof LoopValidationError) {
        res.status(422).json({ error: 'Loop graph is invalid', errors: err.errors })
        return
      }
      throw err
    }
  })

  router.post('/loops/:id/unpublish', (req: Request, res: Response) => {
    if (!guard(res)) return
    const id = req.params.id as string
    if (!getLoop(db, id)) {
      res.status(404).json({ error: 'Loop not found' })
      return
    }
    if (isRunning(id)) {
      res.status(409).json({ error: 'Loop is running; stop the run first' })
      return
    }
    res.json({ loop: unpublishLoop(db, id) })
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
