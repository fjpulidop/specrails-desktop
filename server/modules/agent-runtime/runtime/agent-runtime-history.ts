import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { applyRuntimeSelectionOrigins, readRuntimeEfficiency, readRuntimeEfficiencySummary } from './agent-runtime-metrics'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** A replaceable projection, not an authority to resume, accept or deliver code. */
export function writeRuntimeHistory(contextPath: string, input: Record<string, unknown>): void {
  const contextText = fs.readFileSync(contextPath, 'utf8'), context = JSON.parse(contextText)
  let selection: unknown
  try { selection = JSON.parse(fs.readFileSync(path.join(path.dirname(contextPath), 'desktop-runtime-selection.json'), 'utf8')) } catch { /* Old hosts have no explicit provenance. */ }
  const result = { runId: context.runId, status: typeof input.status === 'string' ? input.status : 'failed', nextStep: typeof input.nextStep === 'string' ? input.nextStep : null,
    updatedAt: new Date().toISOString(), ...(typeof input.error === 'string' ? { error: input.error.slice(0, 4000) } : {}),
    metrics: readRuntimeEfficiency(input.metrics), efficiencySummary: applyRuntimeSelectionOrigins(readRuntimeEfficiencySummary(input.efficiencySummary), selection, context.runId), steps: {} }
  const payload = JSON.stringify({ schemaVersion: 1, contextHash: hash(contextText), result })
  const file = path.join(path.dirname(contextPath), 'desktop-runtime-history.json'), temporary = file + '.' + randomUUID() + '.tmp'
  try { fs.writeFileSync(temporary, JSON.stringify({ payload, integrity: hash(payload) }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}
export function readRuntimeHistory(contextPath: string) {
  const file = path.join(path.dirname(contextPath), 'desktop-runtime-history.json')
  if (!fs.existsSync(file)) return null
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 128 * 1024) throw new Error('Historical runtime projection is invalid')
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof envelope.payload !== 'string' || hash(envelope.payload) !== envelope.integrity) throw new Error('Historical runtime projection integrity failed')
  const value = JSON.parse(envelope.payload), contextText = fs.readFileSync(contextPath, 'utf8')
  if (value.schemaVersion !== 1 || value.contextHash !== hash(contextText) || value.result?.runId !== JSON.parse(contextText).runId || !['running', 'succeeded', 'paused', 'failed', 'blocked', 'cancelled'].includes(value.result.status)) throw new Error('Historical runtime projection scope changed')
  return { ...value.result, metrics: readRuntimeEfficiency(value.result.metrics), efficiencySummary: readRuntimeEfficiencySummary(value.result.efficiencySummary), steps: {} }
}
