/**
 * Narrated-progress model (nontech-review-experience Wave 3b).
 *
 * Turns a run's persisted event stream into plain-language MILESTONES for a
 * reader who cannot read logs. Deliberately deterministic — no model calls, no
 * paraphrase:
 *
 *  · Every milestone is a stable i18n key plus factual values. The renderer
 *    interpolates; nothing here writes prose, so nothing here can invent.
 *  · The only outcomes stated are STRUCTURAL ones (a step's ok/failed status,
 *    the decider's routed verdict, a shell exit code). Agent prose is never
 *    promoted to an outcome — "tests passed" is a claim, not an event.
 *  · Silence is honest: a step with no recognisable activity produces no
 *    activity milestone rather than a reassuring filler line.
 *
 * Reuses `deriveFrameActivity` (the same provider-agnostic derivation the job
 * status panel and rail metrics use), so degradation across providers is
 * predictable: claude yields tool-level detail, codex/gemini/kimi yield fewer
 * activity milestones and the structural ones stay identical.
 */
import type { EventRow } from '../../types'
import { deriveFrameActivity } from '../../lib/frame-activity'

export type MilestoneKind =
  /** A loop step started. */
  | 'step-start'
  /** A loop step finished (carries duration + structural status). */
  | 'step-end'
  /** A step was torn down mid-flight (no end event on a settled run). */
  | 'step-interrupted'
  /** The Loop Decider routed the run (continue = another attempt). */
  | 'decision'
  /** Observed tool activity, aggregated. */
  | 'activity'

export interface NarrationMilestone {
  /** Stable ordering key (the source event's seq). */
  seq: number
  kind: MilestoneKind
  /** i18n key under the `narration` namespace. */
  code: string
  /** Interpolation values — all factual, all derived from the stream. */
  values: Record<string, string | number>
  /** Which loop step this belongs to (null for plain jobs / setup lines). */
  stepIndex: number | null
  /** Structural tone; never inferred from prose. */
  tone: 'neutral' | 'good' | 'bad'
}

export interface NarrationModel {
  milestones: NarrationMilestone[]
  /** Total loop steps observed (0 for a plain job). */
  stepCount: number
  /** True when the stream carried no loop structure at all. */
  plainJob: boolean
}

interface StepInfo {
  index: number
  title: string
  kind: string
  iteration: number | null
  ended: boolean
}

function parsePayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Engine step titles carry decorative emoji ("🤖 AI Step"). Harmless in a log,
 *  noise in a plain-language timeline — the words carry the meaning. */
function cleanTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}(]+/u, '').trim()
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

/**
 * Action keys that are activity for the metrics counter but NOT narratable
 * milestones. "Thinking" is the absence of an observable action: nine
 * consecutive thinking frames tell the reader nothing, and rendering them
 * violates the silence-over-filler rule this model is built on.
 */
const NON_NARRATABLE_ACTIONS = new Set(['thinking', 'reasoning'])

/**
 * Every action key `deriveFrameActivity` can emit must either be narratable
 * (with i18n copy under `activity.*`) or listed above. The parity test in
 * narration-model.test.ts pins this, so a new action key in the shared
 * derivation can never again leak a raw i18n key into the UI.
 */
export const NARRATABLE_ACTIONS = ['reading', 'editing', 'writing', 'searching', 'running', 'working'] as const

/** Consecutive identical activity is one milestone with a count, so a loop that
 *  reads the same file nine times reads as nine attempts — not nine lines. */
function pushActivity(
  out: NarrationMilestone[],
  seq: number,
  stepIndex: number | null,
  actionKey: string,
  actionArg: string,
): void {
  const last = out[out.length - 1]
  if (
    last && last.kind === 'activity' && last.stepIndex === stepIndex
    && last.values.action === actionKey && last.values.target === actionArg
  ) {
    last.values.repeats = Number(last.values.repeats ?? 1) + 1
    return
  }
  out.push({
    seq,
    kind: 'activity',
    code: actionArg ? `activity.${actionKey}` : `activity.${actionKey}Bare`,
    values: { action: actionKey, target: actionArg, repeats: 1 },
    stepIndex,
    tone: 'neutral',
  })
}

export interface NarrationInput {
  events: EventRow[]
  /** True once the job reached a terminal status — required before calling a
   *  step with no end event "interrupted" (a live step is simply still going). */
  settled: boolean
}

export function buildNarration({ events, settled }: NarrationInput): NarrationModel {
  const milestones: NarrationMilestone[] = []
  const steps = new Map<number, StepInfo>()
  let currentStep: number | null = null
  let sawLoopStructure = false

  for (const event of events) {
    if (event.event_type === 'loop_graph') {
      sawLoopStructure = true
      continue
    }

    if (event.event_type === 'loop_step') {
      const payload = parsePayload(event.payload)
      const index = asNumber(payload.index)
      if (index === null) continue
      sawLoopStructure = true
      const info: StepInfo = {
        index,
        title: cleanTitle(asString(payload.title) ?? ''),
        kind: asString(payload.kind) ?? 'ai-step',
        iteration: asNumber(payload.iteration),
        ended: false,
      }
      steps.set(index, info)
      currentStep = index
      milestones.push({
        seq: event.seq,
        kind: 'step-start',
        code: info.iteration && info.iteration > 1 ? 'step.startRetry' : 'step.start',
        values: {
          step: index,
          title: info.title,
          iteration: info.iteration ?? 1,
        },
        stepIndex: index,
        tone: 'neutral',
      })
      continue
    }

    if (event.event_type === 'loop_step_end') {
      const payload = parsePayload(event.payload)
      const index = asNumber(payload.index)
      if (index === null) continue
      const info = index !== null ? steps.get(index) : undefined
      if (info) info.ended = true
      const status = asString(payload.status)
      const durationMs = asNumber(payload.durationMs)
      const exitCode = asNumber(payload.exitCode)
      const failed = status === 'failed'
      milestones.push({
        seq: event.seq,
        kind: 'step-end',
        code: failed
          ? 'step.failed'
          : durationMs !== null ? 'step.doneTimed' : 'step.done',
        values: {
          step: index,
          title: info?.title ?? '',
          seconds: durationMs === null ? 0 : Math.max(1, Math.round(durationMs / 1000)),
          ...(exitCode !== null ? { exitCode } : {}),
        },
        stepIndex: index,
        tone: failed ? 'bad' : 'good',
      })
      const decision = asString(payload.decision)
      if (decision === 'continue' || decision === 'stop') {
        milestones.push({
          seq: event.seq,
          kind: 'decision',
          // The decider's routed verdict is structural truth: `continue` means
          // it judged the goal NOT met, whatever any prose claimed.
          code: decision === 'continue' ? 'decision.another' : 'decision.satisfied',
          values: { step: index },
          stepIndex: index,
          tone: decision === 'continue' ? 'neutral' : 'good',
        })
      }
      continue
    }

    const activity = deriveFrameActivity(event)
    if (activity.step && activity.actionKey && !NON_NARRATABLE_ACTIONS.has(activity.actionKey)) {
      pushActivity(milestones, event.seq, currentStep, activity.actionKey, activity.actionArg ?? '')
    }
  }

  // A step with no end event is only "interrupted" once the run has settled;
  // while it is live, it is simply still working.
  if (settled) {
    for (const info of steps.values()) {
      if (info.ended) continue
      milestones.push({
        seq: Number.MAX_SAFE_INTEGER - (1000 - info.index),
        kind: 'step-interrupted',
        code: 'step.interrupted',
        values: { step: info.index, title: info.title },
        stepIndex: info.index,
        tone: 'bad',
      })
    }
  }

  return {
    milestones,
    stepCount: steps.size,
    plainJob: !sawLoopStructure,
  }
}
