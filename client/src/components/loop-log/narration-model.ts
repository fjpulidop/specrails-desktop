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
import { commandFromEvent, deriveFrameActivity } from '../../lib/frame-activity'
import { classifyCommand } from './narration-commands'

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
  /** i18n key for the step's plain-language role, when the engine named it. */
  roleCode: string | null
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

/**
 * Plain-language role for a step, derived from the ENGINE's own node id. Factory
 * loops use a small fixed set (`main-N`, `verify`, `decide`); the title they ship
 * is generic ("AI Step (codex/gpt-5.5)") and names the provider, not the job. An
 * unknown node id falls back to the real title — never to a guess.
 */
function stepRoleCode(nodeId: string | null, kind: string): string | null {
  if (nodeId && /^main-\d+$/.test(nodeId)) return 'step.role.work'
  if (nodeId === 'verify') return 'step.role.verify'
  if (nodeId === 'decide' || kind === 'decider') return 'step.role.decide'
  if (nodeId === 'fix') return 'step.role.fix'
  return null
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
 * Files the PIPELINE keeps for itself: agent memory entries (dated slugs),
 * MEMORY.md, the reviewer's score. Showing "Writing confidence-score.json"
 * beside "Writing game.js" implies both are the user's product, which is
 * misleading — these fold into one bookkeeping line instead.
 */
const BOOKKEEPING_FILE = /^(MEMORY\.md|confidence-score\.json|design-confidence\.json|\d{4}-\d{2}-\d{2}-.+|feedback_.+)$/

/** The spec deliverable itself — writing it IS the work, and it deserves saying. */
const SPEC_FILE = /^(proposal|design|tasks|spec|context-bundle)\.md$/

/** File-touching actions are aggregated by ACTION per step (a count plus a few
 *  example names) rather than one line per file: a greenfield step wrote twenty
 *  files, which rendered as twenty lines a reader had to scroll past. */
const FILE_ACTIONS = new Set(['reading', 'writing', 'editing'])

/**
 * Every action key `deriveFrameActivity` can emit must either be narratable
 * (with i18n copy under `activity.*`) or listed above. The parity test in
 * narration-model.test.ts pins this, so a new action key in the shared
 * derivation can never again leak a raw i18n key into the UI.
 */
export const NARRATABLE_ACTIONS = ['reading', 'editing', 'writing', 'searching', 'running', 'working', 'delegating'] as const

/**
 * Identical activity WITHIN A STEP is one milestone with a count — not only when
 * consecutive. A real run interleaves exploration with commands, so
 * consecutive-only merging still produced "Looking through the code" five times
 * in one step. Merging across the whole step keeps every occurrence counted
 * while the reader sees each KIND of work once, in the order it first appeared.
 */
function pushActivity(
  out: NarrationMilestone[],
  seq: number,
  stepIndex: number | null,
  actionKey: string,
  actionArg: string,
): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const candidate = out[i]
    // Stop at the step boundary: a later step's activity is its own story.
    if (candidate.kind !== 'activity') {
      if (candidate.stepIndex !== stepIndex) break
      continue
    }
    if (candidate.stepIndex !== stepIndex) break
    if (candidate.values.action === actionKey && candidate.values.target === actionArg) {
      candidate.values.repeats = Number(candidate.values.repeats ?? 1) + 1
      return
    }
  }
  out.push({
    seq,
    kind: 'activity',
    // 'intent' carries a resolved i18n key in actionArg; every other action
    // composes its key from the action plus whether it has a target.
    code: actionKey === 'intent'
      ? actionArg
      : actionArg ? `activity.${actionKey}` : `activity.${actionKey}Bare`,
    values: { action: actionKey, target: actionArg, repeats: 1 },
    stepIndex,
    tone: 'neutral',
  })
}

/** How many example file names a folded file-activity line names. */
const FILE_EXAMPLES = 3

/**
 * Merge a file touch into the step's single line for that action, carrying a
 * count and up to three example names. Nothing is hidden: the count is exact and
 * the log mode still lists every file.
 */
function pushFileActivity(
  out: NarrationMilestone[],
  seq: number,
  stepIndex: number | null,
  actionKey: string,
  name: string,
): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const candidate = out[i]
    if (candidate.stepIndex !== stepIndex) break
    if (candidate.kind !== 'activity') continue
    if (candidate.values.action !== actionKey || candidate.values.fileGroup !== 1) continue

    // `files` counts DISTINCT files, never touches: reading one file twice is
    // one file, and saying "2 files" would be a false number.
    const all = String(candidate.values.allNames ?? '').split('\u0000').filter(Boolean)
    const isNew = Boolean(name) && !all.includes(name)
    if (isNew) all.push(name)
    candidate.values.allNames = all.join('\u0000')
    candidate.values.files = all.length

    const shown = String(candidate.values.names ?? '').split(', ').filter(Boolean)
    if (isNew && shown.length < FILE_EXAMPLES) {
      shown.push(name)
      candidate.values.names = shown.join(', ')
    }
    // One file touched repeatedly stays the singular line; several become the
    // folded "N files" line.
    candidate.code = all.length > 1
      ? `activity.${actionKey}Files`
      : name ? `activity.${actionKey}` : `activity.${actionKey}Bare`
    candidate.values.repeats = all.length > 1 ? 1 : Number(candidate.values.repeats ?? 1) + 1
    return
  }
  out.push({
    seq,
    kind: 'activity',
    code: name ? `activity.${actionKey}` : `activity.${actionKey}Bare`,
    values: {
      action: actionKey, target: name, names: name, allNames: name,
      files: name ? 1 : 0, fileGroup: 1, repeats: 1,
    },
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
      const kind = asString(payload.kind) ?? 'ai-step'
      const info: StepInfo = {
        index,
        title: cleanTitle(asString(payload.title) ?? ''),
        roleCode: stepRoleCode(asString(payload.nodeId), kind),
        kind,
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
          ...(info.roleCode ? { roleCode: info.roleCode } : {}),
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
          : durationMs === null
            ? 'step.done'
            // Past a minute and a half, minutes are what a human reads.
            : durationMs >= 90_000 ? 'step.doneTimedMin' : 'step.doneTimed',
        values: {
          step: index,
          title: info?.title ?? '',
          seconds: durationMs === null ? 0 : Math.max(1, Math.round(durationMs / 1000)),
          minutes: durationMs === null ? 0 : Math.max(1, Math.round(durationMs / 60_000)),
          ...(info?.roleCode ? { roleCode: info.roleCode } : {}),
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
    if (!activity.step || !activity.actionKey) continue
    if (NON_NARRATABLE_ACTIONS.has(activity.actionKey)) continue

    // A shell command is classified by what it ACCOMPLISHES. Plumbing (the ~80%
    // of real invocations that are grep/cd/find/sed/ls/jq) collapses into one
    // "looking through the code" line instead of a wall of tool names.
    if (activity.actionKey === 'running') {
      const command = commandFromEvent(event)
      const classified = command ? classifyCommand(command) : { kind: 'named' as const, tool: activity.actionArg ?? '' }
      if (classified.kind === 'plumbing') {
        pushActivity(milestones, event.seq, currentStep, 'exploring', '')
        continue
      }
      if (classified.kind === 'intent') {
        pushActivity(milestones, event.seq, currentStep, 'intent', classified.code)
        continue
      }
      pushActivity(milestones, event.seq, currentStep, 'running', classified.tool)
      continue
    }
    if (FILE_ACTIONS.has(activity.actionKey)) {
      const name = activity.actionArg ?? ''
      if (BOOKKEEPING_FILE.test(name)) {
        pushActivity(milestones, event.seq, currentStep, 'intent', 'activity.bookkeeping')
        continue
      }
      if (SPEC_FILE.test(name)) {
        pushActivity(milestones, event.seq, currentStep, 'intent', 'activity.writingSpec')
        continue
      }
      pushFileActivity(milestones, event.seq, currentStep, activity.actionKey, name)
      continue
    }
    pushActivity(milestones, event.seq, currentStep, activity.actionKey, activity.actionArg ?? '')
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
