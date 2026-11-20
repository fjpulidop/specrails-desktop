/**
 * Picking how a failed run goes on: client model (pure). The AI analysis offers
 * resolution options (each mapped to a remedy the app already runs); the chain
 * says whether the run keeps stopping the same way. Reading the wire shapes
 * defensively and deciding what the card leads with.
 */

export const RESOLUTION_KINDS = ['continue-with-guidance', 'continue-to-review', 'mark-human-check', 'edit-spec', 'change-model', 'start-over'] as const
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number]
export type ResolutionRisk = 'low' | 'medium' | 'high'

export interface ResolutionOption {
  id: string
  kind: ResolutionKind
  label: string
  does: string
  consequence: string
  risk?: ResolutionRisk
  recommended?: boolean
  guidance: string
}

/** The chain's spend up to this run and whether it keeps stopping for the same cause (`GET /loop-runs/:id/attempts`). */
export interface ChainResolution {
  attempts: number
  costUsd: number | null
  costEstimated: boolean
  repeated: boolean
  times: number
}

export const MAX_OPTIONS = 4
const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** An analysis' options, read defensively: unknown kinds and unreadable options are dropped, at most four, one recommendation. */
export function readResolutionOptions(raw: unknown): ResolutionOption[] {
  if (!Array.isArray(raw)) return []
  const out: ResolutionOption[] = []
  let recommended = false
  for (const item of raw) {
    if (out.length >= MAX_OPTIONS) break
    if (!item || typeof item !== 'object') continue
    const v = item as Record<string, unknown>
    const id = text(v.id, 40), label = text(v.label, 80), does = text(v.does, 280), consequence = text(v.consequence, 280)
    if (!OPTION_ID.test(id) || !label || !does || !consequence || out.some((option) => option.id === id)) continue
    if (!(RESOLUTION_KINDS as readonly unknown[]).includes(v.kind)) continue
    const risk = v.risk === 'low' || v.risk === 'medium' || v.risk === 'high' ? v.risk : undefined
    const isRecommended = v.recommended === true && !recommended
    if (isRecommended) recommended = true
    out.push({ id, kind: v.kind as ResolutionKind, label, does, consequence, ...(risk ? { risk } : {}), ...(isRecommended ? { recommended: true } : {}), guidance: text(v.guidance, 1200) })
  }
  return out
}

export function readChainResolution(raw: unknown): ChainResolution | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.attempts !== 'number' || !Number.isInteger(v.attempts) || v.attempts < 1) return null
  const costUsd = typeof v.costUsd === 'number' && Number.isFinite(v.costUsd) ? v.costUsd : null
  return { attempts: v.attempts, costUsd, costEstimated: costUsd !== null && v.costEstimated === true, repeated: v.repeated === true,
    times: typeof v.times === 'number' && Number.isInteger(v.times) && v.times > 0 ? v.times : 1 }
}

/** An option that only keeps going (Continue with no guidance): the card's own Continue does that. */
export function isPlainContinue(option: Pick<ResolutionOption, 'kind' | 'guidance'>): boolean {
  return option.kind === 'continue-with-guidance' && !option.guidance.trim()
}

/** The id of the option the client adds when a repeat leaves no "keep trying" choice. */
export const KEEP_TRYING_ID = 'keep-trying'

/**
 * How the card's Continue shows: `primary` (today), `secondary` (a repeat before the options are
 * ready: still there, never the lead) or `hidden` (a repeat with options: "keep trying" is one of them).
 */
export type ContinueMode = 'primary' | 'secondary' | 'hidden'
export function continueMode(repeated: boolean, optionsReady: boolean): ContinueMode {
  if (!repeated) return 'primary'
  return optionsReady ? 'hidden' : 'secondary'
}

/**
 * The options the card shows. Never two equivalent buttons: without a repeat the card's Continue is
 * "keep going", so a plain-continue option is left out; after a repeat Continue steps aside, the
 * plain option stays (last) and, when the analysis gave none, `keepTrying` stands in for it.
 */
export function visibleOptions(options: readonly ResolutionOption[], repeated: boolean, keepTrying: ResolutionOption | null): ResolutionOption[] {
  if (!repeated) return options.filter((option) => !isPlainContinue(option))
  const plain = options.filter(isPlainContinue)
  const rest = options.filter((option) => !isPlainContinue(option))
  const tail = plain.length ? plain.slice(0, 1) : keepTrying ? [keepTrying] : []
  return [...rest, ...tail].map((option) => (isPlainContinue(option) && option.recommended ? { ...option, recommended: undefined } : option))
}

/** Average spend of one attempt so far, when the chain recorded any. */
export function costPerAttempt(chain: Pick<ChainResolution, 'attempts' | 'costUsd'> | null): number | null {
  return chain && chain.costUsd !== null && chain.costUsd > 0 ? chain.costUsd / chain.attempts : null
}

/** Options whose kind continues the run on the server (the rest open an editor, settings or Start over). */
export function continuesOnServer(kind: ResolutionKind): boolean {
  return kind === 'continue-with-guidance' || kind === 'mark-human-check' || kind === 'continue-to-review'
}
