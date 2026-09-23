import type { DbInstance } from '../../../db'

/** Efficiency events are advisory measurements, never workflow or delivery authority. */
export function runtimeEfficiencyEventLine(line: string, runId: string): string | null {
  if (line.length > 16384) return null
  let event: Record<string, unknown>
  try { event = JSON.parse(line) } catch { return null }
  if (event?.type !== 'runtime-efficiency-event' || event.schemaVersion !== 1 || event.runId !== runId || typeof event.eventId !== 'string' || !event.eventId.startsWith(runId + ':') || event.eventId.length > 256 || typeof event.attemptId !== 'string' || event.attemptId.length > 256 || !['role-context', 'role-route', 'check-started', 'check-finished', 'check-reused', 'check-invalidated'].includes(String(event.kind))) return null
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null
  const raw = event.payload as Record<string, unknown>, payload: Record<string, unknown> = {}
  for (const key of ['invocationId', 'provider', 'model', 'requestedEffort', 'kind', 'tier', 'routeReason', 'contextMode', 'status', 'executionId', 'repositoryId', 'checkId', 'label', 'reason']) {
    const value = raw[key]
    if (value === undefined) continue
    if (value !== null && (typeof value !== 'string' || value.length > 256)) return null
    payload[key] = value
  }
  for (const key of ['ordinal', 'promptBytes', 'contextBytes', 'handoffBytes', 'durationMs', 'toolCalls']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) return null
    payload[key] = raw[key]
  }
  if (raw.exitCode !== undefined) { if (typeof raw.exitCode !== 'number' || !Number.isSafeInteger(raw.exitCode)) return null; payload.exitCode = raw.exitCode }
  return JSON.stringify({ type: event.type, schemaVersion: 1, eventId: event.eventId, runId, attemptId: event.attemptId, kind: event.kind, payload })
}
export function isRecordedRuntimeEfficiencyEvent(db: DbInstance, runId: string, line: string): boolean {
  const event = JSON.parse(line) as { eventId: string }
  return Boolean(db.prepare("SELECT 1 FROM events WHERE job_id = ? AND event_type = 'runtime-efficiency-event' AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.eventId') END = ? LIMIT 1").get(runId, event.eventId))
}
