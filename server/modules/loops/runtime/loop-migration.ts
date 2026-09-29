import { convertLegacyLoop } from './loop-compat'
import { isDefinitionGraph, type LoopGraph } from './loop-graph'
import type { LoopDefinition } from './loops-store'

/**
 * Read-only D8 migration assessment. It never converts, publishes or unpublishes
 * a loop: a legacy loop becomes a reviewable Core draft only through the explicit
 * per-loop conversion, and an invalid published definition is reported for a
 * person to fix rather than silently withdrawn.
 */
export type LoopMigrationState =
  /** Core definition that validates against the installed Core. */
  | 'current'
  /** Core definition the installed Core no longer accepts. */
  | 'invalid'
  /** Legacy loop that converts and validates; convert it explicitly to review. */
  | 'convertible'
  /** Legacy loop that needs input (for example a repository binding) or cannot be converted. */
  | 'needs_attention'
  /** Loop currently executing; assess again once it settles. */
  | 'running'

export interface LoopMigrationIssue { code: string; message: string; nodeId?: string; path?: string }
export interface LoopMigrationEntry {
  id: string
  name: string
  status: LoopDefinition['status']
  engine: 'legacy' | 'core'
  /** An immutable pre-conversion graph is already preserved. */
  hasLegacyGraph: boolean
  state: LoopMigrationState
  issues: LoopMigrationIssue[]
}
export interface LoopMigrationReport {
  loops: LoopMigrationEntry[]
  summary: Record<LoopMigrationState, number>
}

export interface LoopMigrationPorts {
  isRunning(loopId: string): boolean
  /** Compiles a Core graph into a definition and validates it structurally with
   *  the installed Core. Throws for compile errors. */
  validate(loop: LoopDefinition, graph: LoopGraph): { ok: true } | { ok: false; errors: LoopMigrationIssue[] }
}

export function assessLoopMigration(loops: LoopDefinition[], ports: LoopMigrationPorts): LoopMigrationReport {
  const entries = loops.map((loop): LoopMigrationEntry => {
    const engine = isDefinitionGraph(loop.graph) ? 'core' as const : 'legacy' as const
    const base = { id: loop.id, name: loop.name, status: loop.status, engine, hasLegacyGraph: loop.hasLegacyGraph === true }
    if (ports.isRunning(loop.id)) return { ...base, state: 'running', issues: [] }
    let graph = loop.graph
    if (engine === 'legacy') {
      // No repository binding is guessed: a multi-repository shell without an
      // explicit scope stays an actionable issue, exactly as in conversion.
      const converted = convertLegacyLoop(loop.graph)
      if (!converted.ok) return { ...base, state: 'needs_attention', issues: converted.issues }
      graph = converted.graph
    }
    let result: ReturnType<LoopMigrationPorts['validate']>
    try { result = ports.validate(loop, graph) }
    catch (error) { result = { ok: false, errors: [{ code: 'definition_invalid', message: error instanceof Error ? error.message : 'Invalid workflow' }] } }
    if (result.ok) return { ...base, state: engine === 'core' ? 'current' : 'convertible', issues: [] }
    return { ...base, state: engine === 'core' ? 'invalid' : 'needs_attention', issues: result.errors }
  })
  const summary: Record<LoopMigrationState, number> = { current: 0, invalid: 0, convertible: 0, needs_attention: 0, running: 0 }
  for (const entry of entries) summary[entry.state] += 1
  return { loops: entries, summary }
}
