/**
 * Loop-step log model — pure grouping/derivation logic for the premium
 * loop-step explorer. Segments the SAME parsed line model LogViewer produces
 * (parseEvent → mergeAssistantLines → applyDiffDetection) by the structured
 * `loop_step` / `loop_step_end` / `loop_graph` events the loop engine persists.
 *
 * Contract (server/loop-run-manager.ts):
 *  - `loop_step`     payload `{ index, kind, title, nodeId, iteration, template?, command? }`
 *                    (LEGACY runs may lack nodeId/iteration — tolerated as null;
 *                    template/command are ai-step-only, server-capped, and
 *                    absent on legacy runs — tolerated as undefined)
 *  - `loop_step_end` payload `{ index, nodeId, status, exitCode, durationMs, decision? }`
 *                    (may be MISSING for interrupted steps)
 *  - `loop_graph`    payload `{ graph, loopId, loopName, provider, model, iterationLimit }`
 *                    (once at run start; LEGACY runs lack it → linear fallback)
 */

import type { EventRow } from '../../types'
import type { LoopGraph, LoopNode } from '../../lib/loops-api'
import {
  parseEvent,
  mergeAssistantLines,
  applyDiffDetection,
  type FormattedLine,
} from '../LogViewer'
import { deriveFrameActivity } from '../../lib/frame-activity'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoopStepMeta {
  index: number
  kind: string // 'ai-step' | 'shell' | 'decider' (open for forward compat)
  title: string
  nodeId: string | null
  iteration: number | null
  /** ai-step only — the authored `{{cmd:X}}` template (server-capped). Absent
   *  when rendering changed nothing, and on legacy/non-ai steps. */
  template?: string
  /** ai-step only — the rendered prompt actually sent (server-capped ~2000). */
  command?: string
}

export interface LoopStepEndMeta {
  index: number
  nodeId: string | null
  /** `stalled`: the server's idle watchdog tore the step down (no provider
   *  output for `idleMs`); the engine retries such a step once by resume. */
  status: 'ok' | 'failed' | 'stalled'
  exitCode: number | null
  durationMs: number | null
  decision?: 'continue' | 'stop'
  /** `idle_timeout` (stalled) or `provider_limit` (failed: the provider
   *  answered with a usage/rate-limit notice and the run stopped at once). */
  reason?: 'idle_timeout' | 'provider_limit'
  idleMs?: number | null
}

export interface LoopGraphMeta {
  graph: LoopGraph
  loopId?: string
  loopName?: string
  provider?: string
  model?: string
  iterationLimit?: number
}

export interface LoopStepActivity {
  actionKey: string
  actionArg?: string
}

export interface LoopStepSegment {
  key: string
  meta: LoopStepMeta
  lines: FormattedLine[]
  end: LoopStepEndMeta | null
  /** Last live activity derived from streamed frames (running-step label). */
  lastActivity: LoopStepActivity | null
}

export interface LoopLogModel {
  graphMeta: LoopGraphMeta | null
  /** Lines seen before the first loop_step (run banner, worktree notice…). */
  setup: FormattedLine[]
  segments: LoopStepSegment[]
  /** Highest `iteration` seen on any loop_step (0 when unknown/legacy). */
  maxIteration: number
  totalLines: number
}

export type SegmentStatus = 'ok' | 'failed' | 'stalled' | 'running' | 'interrupted' | 'unknown'

export type NodeChipState = 'pending' | 'running' | 'ok' | 'failed' | 'interrupted'

export interface NodeChip {
  key: string
  kind: string
  /** Node/step label; null → caller falls back to the localized kind name. */
  label: string | null
  state: NodeChipState
  /** Latest decided verdict — decider chips only. */
  decision?: 'continue' | 'stop'
  /** Segment key of this node's LATEST step box (for focus navigation). */
  latestSegmentKey: string | null
}

// ─── Payload parsing helpers ──────────────────────────────────────────────────

function parsePayload(payload: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(payload)
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>
  } catch {
    // malformed payload — tolerated
  }
  return null
}

/** The flat-log divider the engine also emits per step ("━━━ Step N · … ━━━").
 *  Inside the explorer it duplicates the step-box header, so it is dropped. */
const STEP_DIVIDER_RE = /^\s*━+\s*Step\s+\d+\s*·/

/** Legacy decider titles carry "(iteration N)" — stripped when the iteration is
 *  surfaced as a badge, and always for node identity across iterations. */
const ITERATION_SUFFIX_RE = /\s*\(iteration\s+\d+\)\s*$/i

/** Strip the engine's emoji prefix (🤖/⚡/🔍) — the explorer renders its own icon. */
export function cleanStepTitle(title: string): string {
  const stripped = title.replace(/^[\s\uFE0F\p{Extended_Pictographic}]+/u, '').trim()
  return stripped || title.trim()
}

/** Header display title: cleaned, minus the "(iteration N)" suffix when the
 *  iteration is already shown as a badge (meta.iteration present). */
export function stepDisplayTitle(meta: LoopStepMeta): string {
  const cleaned = cleanStepTitle(meta.title)
  return meta.iteration != null ? cleaned.replace(ITERATION_SUFFIX_RE, '') : cleaned
}

/** Stable node identity for a segment: nodeId when present (new runs), else a
 *  kind+title derivation tolerant of the legacy iteration suffix. */
export function nodeKeyForSegment(seg: LoopStepSegment): string {
  return (
    seg.meta.nodeId ??
    `${seg.meta.kind}::${cleanStepTitle(seg.meta.title).replace(ITERATION_SUFFIX_RE, '')}`
  )
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

export function groupByLoopStep(events: EventRow[]): LoopLogModel {
  let graphMeta: LoopGraphMeta | null = null
  let maxIteration = 0

  // buckets[0] = setup; buckets[i+1] pairs segMetas[i]
  const buckets: FormattedLine[][] = [[]]
  const segMetas: Array<{
    meta: LoopStepMeta
    end: LoopStepEndMeta | null
    lastActivity: LoopStepActivity | null
  }> = []

  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx]

    if (ev.event_type === 'loop_graph') {
      const p = parsePayload(ev.payload)
      if (p && p.graph && typeof p.graph === 'object' && !Array.isArray(p.graph)) {
        graphMeta = {
          graph: p.graph as LoopGraph,
          loopId: typeof p.loopId === 'string' ? p.loopId : undefined,
          loopName: typeof p.loopName === 'string' ? p.loopName : undefined,
          provider: typeof p.provider === 'string' ? p.provider : undefined,
          model: typeof p.model === 'string' ? p.model : undefined,
          iterationLimit: typeof p.iterationLimit === 'number' ? p.iterationLimit : undefined,
        }
      }
      continue
    }

    if (ev.event_type === 'loop_step') {
      const p = parsePayload(ev.payload)
      if (!p || typeof p.index !== 'number') continue // malformed boundary — skip
      const iteration = typeof p.iteration === 'number' ? p.iteration : null
      if (iteration != null && iteration > maxIteration) maxIteration = iteration
      segMetas.push({
        meta: {
          index: p.index,
          kind: typeof p.kind === 'string' ? p.kind : 'ai-step',
          title: typeof p.title === 'string' ? p.title : '',
          nodeId: typeof p.nodeId === 'string' ? p.nodeId : null,
          iteration,
          // Legacy events carry neither field → undefined (no detail disclosure).
          template: typeof p.template === 'string' && p.template ? p.template : undefined,
          command: typeof p.command === 'string' && p.command ? p.command : undefined,
        },
        end: null,
        lastActivity: null,
      })
      buckets.push([])
      continue
    }

    if (ev.event_type === 'loop_step_end') {
      const p = parsePayload(ev.payload)
      if (!p || typeof p.index !== 'number') continue
      // Attach to the LAST segment with this index (arrival-ordered).
      for (let s = segMetas.length - 1; s >= 0; s--) {
        if (segMetas[s].meta.index === p.index) {
          segMetas[s].end = {
            index: p.index,
            nodeId: typeof p.nodeId === 'string' ? p.nodeId : null,
            status: p.status === 'stalled' ? 'stalled' : p.status === 'failed' ? 'failed' : 'ok',
            exitCode: typeof p.exitCode === 'number' ? p.exitCode : null,
            durationMs: typeof p.durationMs === 'number' ? p.durationMs : null,
            decision:
              p.decision === 'continue' || p.decision === 'stop' ? p.decision : undefined,
            ...(p.reason === 'idle_timeout' || p.reason === 'provider_limit' ? { reason: p.reason } : {}),
            ...(typeof p.idleMs === 'number' ? { idleMs: p.idleMs } : {}),
          }
          break
        }
      }
      continue
    }

    // Ordinary event → line, bucketed to the LAST-SEEN step (arrival order —
    // live WS frames carry no reliable seq; refetch reconciles naturally since
    // the model is derived from whatever `events` currently holds).
    const inStep = segMetas.length > 0
    const line = parseEvent(ev, idx)
    if (line && !(inStep && STEP_DIVIDER_RE.test(line.content))) {
      buckets[buckets.length - 1].push(line)
    }
    if (inStep) {
      const act = deriveFrameActivity(ev)
      if (act.step && act.actionKey) {
        segMetas[segMetas.length - 1].lastActivity = {
          actionKey: act.actionKey,
          actionArg: act.actionArg,
        }
      }
    }
  }

  const finalize = (raw: FormattedLine[]): FormattedLine[] =>
    applyDiffDetection(mergeAssistantLines(raw))

  const setup = finalize(buckets[0])
  const segments: LoopStepSegment[] = segMetas.map((s, i) => ({
    key: `step-${i}-${s.meta.index}`,
    meta: s.meta,
    lines: finalize(buckets[i + 1]),
    end: s.end,
    lastActivity: s.lastActivity,
  }))
  const totalLines = setup.length + segments.reduce((n, s) => n + s.lines.length, 0)

  return { graphMeta, setup, segments, maxIteration, totalLines }
}

// ─── Status derivation ────────────────────────────────────────────────────────

export function segmentStatus(
  seg: LoopStepSegment,
  opts: { isLast: boolean; jobSettled: boolean },
): SegmentStatus {
  if (seg.end) return seg.end.status
  // Contract: end may be MISSING for interrupted steps — a running step w/o end
  // on a settled run ⇒ interrupted. Earlier no-end steps (legacy runs) are
  // 'unknown' (the loop advanced past them; no status glyph is shown).
  if (opts.isLast) return opts.jobSettled ? 'interrupted' : 'running'
  return 'unknown'
}

// ─── Overview strip chips ─────────────────────────────────────────────────────

function branchRank(branch?: string): number {
  return branch === 'continue' ? 0 : branch === 'stop' ? 2 : 1
}

/** Natural body order of the graph: DFS from Start, continue-branch first, so
 *  the strip reads start → body… → decider → end (the loop-back is implied). */
export function traversalOrder(graph: LoopGraph): LoopNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const visited = new Set<string>()
  const order: LoopNode[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    const node = byId.get(id)
    if (!node) return
    visited.add(id)
    order.push(node)
    const out = graph.edges
      .filter((e) => e.source === id)
      .slice()
      .sort((a, b) => branchRank(a.branch) - branchRank(b.branch))
    for (const e of out) visit(e.target)
  }
  const start = graph.nodes.find((n) => n.type === 'start')
  if (start) visit(start.id)
  for (const n of graph.nodes) visit(n.id)
  return order
}

function nodeLabel(node: LoopNode): string | null {
  const label = node.data?.label
  return typeof label === 'string' && label.trim() ? label.trim() : null
}

export function buildChips(
  model: LoopLogModel,
  opts: { jobSettled: boolean; jobFailed: boolean },
): NodeChip[] {
  const lastIdx = model.segments.length - 1
  const latestByNode = new Map<string, { seg: LoopStepSegment; idx: number }>()
  const latestDecisionByNode = new Map<string, 'continue' | 'stop'>()
  model.segments.forEach((seg, idx) => {
    const key = nodeKeyForSegment(seg)
    latestByNode.set(key, { seg, idx })
    if (seg.meta.kind === 'decider' && seg.end?.decision) {
      latestDecisionByNode.set(key, seg.end.decision)
    }
  })

  const stateFor = (entry: { seg: LoopStepSegment; idx: number }): NodeChipState => {
    const st = segmentStatus(entry.seg, {
      isLast: entry.idx === lastIdx,
      jobSettled: opts.jobSettled,
    })
    // Legacy mid-run steps without an end: the loop advanced past them — render
    // as done rather than falsely pending/interrupted. A stalled attempt reads
    // as failed on the node chip (the section carries the stall detail).
    return st === 'unknown' ? 'ok' : st === 'stalled' ? 'failed' : st
  }

  if (model.graphMeta) {
    return traversalOrder(model.graphMeta.graph).map((node): NodeChip => {
      if (node.type === 'start') {
        return { key: node.id, kind: 'start', label: nodeLabel(node), state: 'ok', latestSegmentKey: null }
      }
      if (node.type === 'end') {
        return {
          key: node.id,
          kind: 'end',
          label: nodeLabel(node),
          state: opts.jobSettled ? (opts.jobFailed ? 'failed' : 'ok') : 'pending',
          latestSegmentKey: null,
        }
      }
      const entry = latestByNode.get(node.id)
      if (!entry) {
        return { key: node.id, kind: node.type, label: nodeLabel(node), state: 'pending', latestSegmentKey: null }
      }
      return {
        key: node.id,
        kind: node.type,
        label: nodeLabel(node) ?? stepDisplayTitle(entry.seg.meta),
        state: stateFor(entry),
        decision: node.type === 'decider' ? latestDecisionByNode.get(node.id) : undefined,
        latestSegmentKey: entry.seg.key,
      }
    })
  }

  // Legacy fallback: linear strip derived from the loop_steps actually seen,
  // one chip per distinct node identity in first-seen order.
  const chips: NodeChip[] = []
  const seen = new Map<string, number>()
  model.segments.forEach((seg, idx) => {
    const key = nodeKeyForSegment(seg)
    const entry = { seg, idx }
    const chipIdx = seen.get(key)
    const decision = seg.meta.kind === 'decider' ? latestDecisionByNode.get(key) : undefined
    if (chipIdx != null) {
      const chip = chips[chipIdx]
      chip.state = stateFor(entry)
      chip.decision = decision
      chip.latestSegmentKey = seg.key
    } else {
      seen.set(key, chips.length)
      chips.push({
        key,
        kind: seg.meta.kind,
        label: stepDisplayTitle(seg.meta) || null,
        state: stateFor(entry),
        decision,
        latestSegmentKey: seg.key,
      })
    }
  })
  return chips
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  if (mins < 60) return `${mins}m ${s}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}
