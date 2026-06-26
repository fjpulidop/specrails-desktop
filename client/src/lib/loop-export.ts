/**
 * Pure (de)serialization for the loop import/export feature. DOM concerns
 * (download anchor, file read) stay in the page; this module just shapes and
 * validates the JSON envelope so it's unit-testable.
 *
 * Envelope: { specrailsLoops: 1, loops: [{ name, description?, graph }] }
 * Import is lenient — it also accepts a bare array of loops or a single loop
 * object (a hand-saved one loop), so round-tripping our own export always works.
 */
import type { LoopDefinition, LoopGraph } from './loops-api'

export const EXPORT_VERSION = 1

export interface ExportableLoop {
  name: string
  description?: string | null
  graph: LoopGraph
}
export interface LoopExportEnvelope {
  specrailsLoops: number
  loops: ExportableLoop[]
}

/** Strip id/status/timestamps — only name/description/graph travel. */
export function buildExportEnvelope(loops: LoopDefinition[]): LoopExportEnvelope {
  return {
    specrailsLoops: EXPORT_VERSION,
    loops: loops.map((l) => ({ name: l.name, description: l.description, graph: l.graph })),
  }
}

function looksLikeLoop(v: unknown): v is ExportableLoop {
  const o = v as { name?: unknown; graph?: unknown }
  return !!o && typeof o.name === 'string' && !!o.graph && typeof o.graph === 'object'
}

/**
 * Parse a `.json` export back to a loop list. Accepts the envelope, a bare
 * array, or a single loop object. Throws on anything else so the caller can
 * surface a clear "not a loops file" error.
 */
export function parseImportFile(text: string): ExportableLoop[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('invalid-json')
  }
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { loops?: unknown })?.loops)
      ? (parsed as { loops: unknown[] }).loops
      : looksLikeLoop(parsed)
        ? [parsed]
        : []
  const loops = candidates.filter(looksLikeLoop)
  if (loops.length === 0) throw new Error('no-loops')
  return loops.map((l) => ({ name: l.name, description: l.description ?? null, graph: l.graph }))
}

/** Filename for an export: a single loop uses its (slugified) name. */
export function exportFilename(loops: LoopDefinition[]): string {
  if (loops.length === 1) {
    const slug = loops[0].name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loop'
    return `${slug}.loop.json`
  }
  return `specrails-loops-${loops.length}.json`
}
