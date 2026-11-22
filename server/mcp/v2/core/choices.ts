import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { getDesktopSetting } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import type { DecisionState, Offer, OfferCall } from './decision-state'
import type { Translate } from './lang'
import { ASK_PERSON_TIMEOUT_MS } from './confirm'
import type { ToolHandlerExtra } from '../../tools/types'

/**
 * Decision points as human choices (docs/internals/mcp-v2.md §Choices). Every decision the person makes reaches
 * them as a short menu: the legal options (label ≤ 5 words, a one-line effect, the recommended one first) plus
 * an implicit "Something else (write it)". An action that declares `choose` becomes a decision point when it is
 * called without the choice: the server asks the person in the client's own form (MCP elicitation: one select
 * plus an optional free-text field) when the client can show one and `mcp_choices_in_client` is not `off`;
 * otherwise, or on a decline, cancel or timeout, it returns the choices for the agent to present as a menu.
 * The chosen option runs as its own call, so its tier and the confirmation policy still apply.
 */

export interface Choice {
  /** Stable id within the decision point (an offer id, a question option id). */
  id: string
  /** Localized, at most five words. */
  label: string
  /** Localized: what happens if the person picks it. */
  effect?: string
  recommended?: boolean
  /** The exact call that carries the choice out. */
  call: OfferCall
  costHint?: [number, number]
}

export interface ChoicePoint {
  /** Localized: what the person decides (a question's text, a hold reason). */
  question: string
  choices: Choice[]
  /**
   * The free-text answer. With `call` and `field` the text is sent as `call.args[field]` (dots reach into
   * options); without a call it goes back to the agent, which acts on it with the person.
   */
  other?: { call?: OfferCall; field?: string; title?: string }
}

/** What the person picked in the client's form. */
export type Picked = { id: string } | { other: string }

/** desktop_settings key: "off" keeps choices in the chat (the agent's menu) even when the client can show a form. */
export const CHOICES_IN_CLIENT_KEY = 'mcp_choices_in_client'

/** Whether a client that supports MCP elicitation may show the person a choice form (default on). */
export function readChoicesInClient(db: DbInstance | undefined): boolean {
  if (!db) return true
  try {
    return String(getDesktopSetting(db, CHOICES_IN_CLIENT_KEY) ?? '').trim().toLowerCase() !== 'off'
  } catch {
    return true
  }
}

/** Choices from a decision state's offers (already localized, recommended first); `keep` filters them. */
export function choicesFromState(state: Pick<DecisionState, 'offers' | 'recommended'>, keep: (offer: Offer) => boolean = () => true): Choice[] {
  return state.offers.filter(keep).map((offer) => ({
    id: offer.id,
    label: offer.label,
    ...(offer.effect ? { effect: offer.effect } : {}),
    ...(offer.id === state.recommended ? { recommended: true } : {}),
    call: offer.call,
    ...(offer.costHint ? { costHint: offer.costHint } : {}),
  }))
}

/** Recommended first, then the domain order (stable). */
export function orderChoices(choices: readonly Choice[]): Choice[] {
  return [...choices.filter((choice) => choice.recommended), ...choices.filter((choice) => !choice.recommended)]
}

/** The lean menu an agent presents: `[{id, label, effect?, recommended?}]` (the call only when asked). */
export function compactChoices(choices: readonly Choice[], options: { calls?: boolean } = {}): Array<Record<string, unknown>> {
  return orderChoices(choices).map((choice) => ({
    id: choice.id,
    label: choice.label,
    ...(choice.effect ? { effect: choice.effect } : {}),
    ...(choice.recommended ? { recommended: true } : {}),
    ...(options.calls ? { call: choice.call } : {}),
  }))
}

/** `label — effect` for one form entry (cost appended when known). */
export function choiceTitle(choice: Choice, t: Translate): string {
  const parts = [choice.label]
  if (choice.effect) parts.push(choice.effect)
  let title = parts.join(' — ')
  if (choice.costHint) title += ` (${t('core.choose.cost', { low: choice.costHint[0].toFixed(2), high: choice.costHint[1].toFixed(2) })})`
  if (choice.recommended) title += ` · ${t('core.choose.recommended')}`
  return title
}

type AskExtra = Pick<ToolHandlerExtra, 'signal'> & { sendRequest?: (request: { method: 'elicitation/create'; params: Record<string, unknown> }, schema: typeof ElicitResultSchema, options?: { signal?: AbortSignal; timeout?: number }) => Promise<{ action: string; content?: Record<string, unknown> }> }

/** The form schema of a decision point (pure; exported for tests): one select plus the free-text field. */
export function choiceForm(point: ChoicePoint, t: Translate): Record<string, unknown> {
  const choices = orderChoices(point.choices)
  return {
    mode: 'form',
    message: t('core.choose.ask', { question: point.question }),
    requestedSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string', title: t('core.choose.field'),
          enum: choices.map((choice) => choice.id),
          enumNames: choices.map((choice) => choiceTitle(choice, t)),
          ...(choices[0]?.recommended ? { default: choices[0].id } : {}),
        },
        other: { type: 'string', title: point.other?.title ?? t('core.choose.other'), maxLength: 2000 },
      },
    },
  }
}

/**
 * Shows the decision point in the client's own form while the call is open. Free text wins over the select
 * (the person typed it on purpose); an id must be one of the choices. A decline is the person's "not here";
 * anything else (no form: headless clients cancel, an error, a timeout, an empty accept) is null. Both make the
 * call fall back to returning the choices to the agent. Never throws.
 */
export async function askChoice(extra: unknown, t: Translate, point: ChoicePoint): Promise<Picked | 'decline' | null> {
  const send = (extra as AskExtra | undefined)?.sendRequest
  if (typeof send !== 'function' || !point.choices.length) return null
  try {
    const answer = await send({ method: 'elicitation/create', params: choiceForm(point, t) }, ElicitResultSchema, { signal: (extra as AskExtra).signal, timeout: ASK_PERSON_TIMEOUT_MS })
    if (answer.action === 'decline') return 'decline'
    if (answer.action !== 'accept') return null
    const other = typeof answer.content?.other === 'string' ? answer.content.other.trim() : ''
    if (other) return { other: other.slice(0, 2000) }
    const id = typeof answer.content?.choice === 'string' ? answer.content.choice : ''
    return point.choices.some((choice) => choice.id === id) ? { id } : null
  } catch {
    return null
  }
}

/** Sets `value` at a dotted path of a copy of `args` (`options.note`). */
export function withField(args: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = field.split('.')
  if (!rest.length) return { ...args, [head]: value }
  const inner = args[head] && typeof args[head] === 'object' && !Array.isArray(args[head]) ? args[head] as Record<string, unknown> : {}
  return { ...args, [head]: withField(inner, rest.join('.'), value) }
}
