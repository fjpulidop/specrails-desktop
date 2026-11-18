/**
 * Live stream lines → quota reports. Called from the line handlers of turns
 * that are running NOW (never from replays of stored logs, whose reports are
 * stale). Recognises two shapes:
 * - a Claude `stream-json` `rate_limit_event` (turns Desktop spawns itself);
 * - a Core runtime `agent-event` of kind `rate-limit` (jobs, rails and loops
 *   run through Core, contract 5.14), which names its provider.
 * A substring pre-check keeps the cost of every other line at one scan.
 */
import { claudeFrameRateLimit } from '../adapters/claude-stream'
import { reportRateLimit } from './quota-reports'

export function observeQuotaLine(providerId: string, line: string): void {
  if (!line.includes('rate_limit_event') && !line.includes('"rate-limit"')) return
  let frame: Record<string, unknown>
  try { frame = JSON.parse(line) as Record<string, unknown> } catch { return }
  try { observeQuotaFrame(providerId, frame) } catch { /* quota is advisory: a stream never fails on it */ }
}

/** Same, for a line its caller already parsed. */
export function observeQuotaFrame(providerId: string, frame: Record<string, unknown> | null | undefined): void {
  if (!frame || typeof frame !== 'object') return
  if (frame.type === 'rate_limit_event') {
    const report = claudeFrameRateLimit(frame)
    if (report) reportRateLimit(providerId, report, 'stream')
    return
  }
  if (frame.type === 'agent-event') {
    const event = frame.event as { kind?: unknown; provider?: unknown; rateLimit?: unknown } | undefined
    if (event?.kind !== 'rate-limit') return
    reportRateLimit(typeof event.provider === 'string' ? event.provider : providerId, event.rateLimit, 'runtime')
  }
}
