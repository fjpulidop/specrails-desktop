import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { getDesktopSetting } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { canonicalJson } from './canonical'
import type { ConfirmClass } from './decision-state'
import type { Ref } from './refs'
import { CONTROL_FIELDS, CONTROL_OPTIONS } from './views'
import type { Translate } from './lang'
import type { ToolHandlerExtra } from '../../tools/types'

/**
 * Bound confirmation (design §6). A confirmable call without `confirm` gets
 * `confirmation_required` with a preview and a confirmToken; the agent shows
 * the preview, gets a yes and resends with `confirm: <token>`.
 *
 * The token is `ct1.<exp>.<nonce>.<version>.<mac>`, the MAC an HMAC-SHA256 over
 * (client key — see `confirmationKey` —, tool, canonical arguments without control fields, the entity's
 * state version, expiry) with a per-process secret. It is single use, expires
 * after 10 minutes, and dies with the process. A token whose version no longer
 * matches the entity fails with `stale` and a fresh preview (the generalization
 * of the PR decision's `expectedDecision`).
 */

export const CONFIRM_TTL_MS = 10 * 60 * 1000
/** desktop_settings key of "Ask before spending" (USD). */
export const CONFIRM_ABOVE_USD_KEY = 'mcp_confirm_above_usd'
export const DEFAULT_CONFIRM_ABOVE_USD = 0.5

/** The person's "Ask before spending" threshold; invalid or unset → $0.50. */
export function readConfirmThreshold(db: DbInstance | undefined): number {
  if (!db) return DEFAULT_CONFIRM_ABOVE_USD
  try {
    const raw = getDesktopSetting(db, CONFIRM_ABOVE_USD_KEY)
    const value = raw === undefined || raw === null || raw === '' ? NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CONFIRM_ABOVE_USD
  } catch {
    return DEFAULT_CONFIRM_ABOVE_USD
  }
}

/** desktop_settings key: "off" keeps confirmations in the chat (token flow) even when the client can ask in-call. */
export const CONFIRM_IN_CLIENT_KEY = 'mcp_confirm_in_client'

/** Whether a client that supports MCP elicitation may ask the person inside the call (default on). */
export function readConfirmInClient(db: DbInstance | undefined): boolean {
  if (!db) return true
  try {
    return String(getDesktopSetting(db, CONFIRM_IN_CLIENT_KEY) ?? '').trim().toLowerCase() !== 'off'
  } catch {
    return true
  }
}

const SECRET_KEY = /secret|token|password|passphrase|api_?key|credential|private_?key/i

/** Whether call arguments carry a write-only value (a webhook secret, an API token…) anywhere: such a call is never echoed back. */
export function carriesSecret(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (key !== 'confirm' && SECRET_KEY.test(key) && item !== undefined && item !== null && item !== '') || carriesSecret(item, depth + 1))
}

/** Whether the client declared form elicitation at initialize (`elicitation: {}` means form, per the spec). */
export function elicitsForms(capabilities: { elicitation?: unknown } | undefined | null): boolean {
  const elicitation = capabilities?.elicitation
  if (!elicitation || typeof elicitation !== 'object') return false
  const modes = elicitation as Record<string, unknown>
  return Object.keys(modes).length === 0 || (typeof modes.form === 'object' && modes.form !== null)
}

/** How long the client's confirmation dialog may stay open before the call falls back to the token flow. */
export const ASK_PERSON_TIMEOUT_MS = 5 * 60 * 1000

type AskExtra = Pick<ToolHandlerExtra, 'signal'> & { sendRequest?: (request: { method: 'elicitation/create'; params: Record<string, unknown> }, schema: typeof ElicitResultSchema, options?: { signal?: AbortSignal; timeout?: number }) => Promise<{ action: string; content?: Record<string, unknown> }> }

/**
 * Asks the person through the client's own dialog (MCP `elicitation/create`, form mode) while the call is
 * open, so a confirmation costs no extra model turn. Only an explicit accept with the box ticked is a yes;
 * a decline is the person's no; anything else (no dialog: headless clients cancel, an error, a timeout) is
 * null and the call falls back to the token flow. Never throws.
 */
export async function askPerson(extra: unknown, t: Translate, preview: Pick<Preview, 'effect'>): Promise<'accept' | 'decline' | null> {
  const send = (extra as AskExtra | undefined)?.sendRequest
  if (typeof send !== 'function') return null
  try {
    const answer = await send({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: t('core.confirm.ask', { effect: preview.effect }),
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: t('core.confirm.ask_field') } }, required: ['confirm'] },
      },
    }, ElicitResultSchema, { signal: (extra as AskExtra).signal, timeout: ASK_PERSON_TIMEOUT_MS })
    if (answer.action === 'accept') return answer.content?.confirm === true ? 'accept' : 'decline'
    return answer.action === 'decline' ? 'decline' : null
  } catch {
    return null
  }
}

/** What a confirmable call would do, shown to the person before they agree. */
export interface Preview {
  /** `specrails_deliveries(decide merge_local)`. */
  label: string
  /** Localized: what happens, reversibility and cost in plain words. */
  effect: string
  class: ConfirmClass
  refs: Ref[]
  reversible: boolean
  external: boolean
  /** Cost forecast (`launch-forecast`, `run-duration-range`); `forecastUsd: null` when it cannot be estimated. */
  cost?: { forecastUsd: [number, number] | null; runs: number }
  /** State version the token binds to. */
  version: string
}

export interface Binding {
  session: string
  tool: string
  args: Record<string, unknown>
  version: string
}

export type VerifyFailure = 'malformed' | 'mismatch' | 'expired' | 'replayed' | 'stale'
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure }

/** Arguments a token binds: everything except the framework's control fields and control options (`options.waitMs`). */
export function bindingArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (!(CONTROL_FIELDS as readonly string[]).includes(key)) out[key] = value
  const options = out.options
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const kept = Object.fromEntries(Object.entries(options).filter(([key]) => !(CONTROL_OPTIONS as readonly string[]).includes(key)))
    if (Object.keys(kept).length) out.options = kept
    else delete out.options
  }
  return out
}

/**
 * The key a confirmation binds to. The person's yes usually arrives in the agent's NEXT turn, and headless
 * clients (`claude -p --resume`, `codex exec resume`, a bridge that reconnects) open a new MCP connection per
 * turn, so a per-connection key would reject every legitimate confirmation. An external session therefore binds
 * to the client it announced at initialize (`clientInfo.name`): a token minted for Claude Code still confirms in
 * Claude Code's next connection, never in another client's. Without a name the connection's own key is kept.
 * The token stays bound to the tool, the arguments, the state version, a 10-minute expiry and single use.
 */
export function confirmationKey(client: { name?: unknown } | undefined | null, connectionKey: string): string {
  const name = typeof client?.name === 'string' ? client.name.trim() : ''
  return name ? `client:${name.slice(0, 128)}` : connectionKey
}

const VERSION = /^[A-Za-z0-9_-]{1,64}$/

export class ConfirmationLedger {
  private readonly secret: Buffer
  private readonly used = new Map<string, number>()

  constructor(options: { secret?: Buffer; now?: () => number; ttlMs?: number } = {}) {
    this.secret = options.secret ?? randomBytes(32)
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? CONFIRM_TTL_MS
  }

  private readonly now: () => number
  private readonly ttlMs: number

  private mac(exp: string, nonce: string, version: string, binding: Omit<Binding, 'version'>): string {
    return createHmac('sha256', this.secret)
      .update(['ct1', exp, nonce, version, binding.session, binding.tool, canonicalJson(bindingArgs(binding.args))].join('\n'))
      .digest('base64url').slice(0, 32)
  }

  issue(binding: Binding): string {
    if (!VERSION.test(binding.version)) throw new Error(`Invalid state version "${binding.version}".`)
    const exp = (this.now() + this.ttlMs).toString(36)
    const nonce = randomBytes(9).toString('base64url')
    return `ct1.${exp}.${nonce}.${binding.version}.${this.mac(exp, nonce, binding.version, binding)}`
  }

  /** Checks a token against the current binding; does not consume it (see `consume`). */
  verify(token: unknown, binding: Binding): VerifyResult {
    this.prune()
    if (typeof token !== 'string') return { ok: false, reason: 'malformed' }
    const parts = token.split('.')
    if (parts.length !== 5 || parts[0] !== 'ct1' || !VERSION.test(parts[3])) return { ok: false, reason: 'malformed' }
    const [, exp, nonce, version, mac] = parts
    const expected = Buffer.from(this.mac(exp, nonce, version, binding))
    const given = Buffer.from(mac)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'mismatch' }
    if (parseInt(exp, 36) <= this.now()) return { ok: false, reason: 'expired' }
    if (this.used.has(nonce)) return { ok: false, reason: 'replayed' }
    if (version !== binding.version) return { ok: false, reason: 'stale' }
    return { ok: true }
  }

  /** Marks a verified token used (single use). Call right before executing the confirmed call. */
  consume(token: string): void {
    const parts = token.split('.')
    if (parts.length === 5) this.used.set(parts[2], parseInt(parts[1], 36))
  }

  private prune(): void {
    const now = this.now()
    for (const [nonce, exp] of this.used) if (exp <= now) this.used.delete(nonce)
  }
}

/** Process-wide ledger used by the registry (tests build their own). */
export const confirmationLedger = new ConfirmationLedger()
