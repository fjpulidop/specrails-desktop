import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-wp12-translations-test-token' }))
vi.mock('../../../modules/execution/runtime/accept-ladder', () => ({
  resolveAcceptCapability: async () => ({ target: 'merge-local', hasRemote: false, ghAuthenticated: false, irreversible: true, reasonCode: 'no-remote' }),
}))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CATALOGS, I18N_AREAS } from './catalog'
import { SUPPORTED_LANGS } from '../core/lang'
import { createHarness, call } from '../__fixtures__/harness'
import { registerV2Surface } from '../index'
import { buildToolSpecs } from '../../tools/catalog'
import { createLoopRun, finishLoopRun, pauseLoopRun } from '../../../modules/loops/runtime/loop-runs-store'
import { createPrDelivery, transitionDecision } from '../../../modules/delivery/runtime/rail-pr-store'
import { startDesktop, type FakeDesktop } from '../tools/__fixtures__/wp2-desktop'

// WP12: every area catalog is translated into all eight languages (core.json is
// generated from the client locales by i18n.test.ts), and a call with `lang`
// answers in that language end to end.

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]).sort()
/** Tool calls and names quoted in a message stay verbatim in every language. */
const toolCalls = (text: string) => [...text.matchAll(/specrails_\w+(?:\([^)]*\))?/g)].map((match) => match[0]).sort()
const AREAS = I18N_AREAS.filter((area) => area !== 'core')

describe('v2 translations', () => {
  it('has every English key in all eight languages, with the same placeholders and tool calls', () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const area of AREAS) {
        const english = CATALOGS.en[area] ?? {}
        const messages = CATALOGS[lang]?.[area]
        expect(messages, `${lang}/${area}.json`).toBeDefined()
        expect(Object.keys(messages ?? {}).sort(), `${lang}/${area}.json keys`).toEqual(Object.keys(english).sort())
        for (const [key, text] of Object.entries(english)) {
          const translated = messages?.[key] ?? ''
          expect(translated.trim(), `${lang}/${area}.${key} is empty`).not.toBe('')
          expect(placeholders(translated), `${lang}/${area}.${key} placeholders`).toEqual(placeholders(text))
          expect(toolCalls(translated), `${lang}/${area}.${key} tool calls`).toEqual(toolCalls(text))
        }
      }
    }
  })

  it('Spanish follows the app glossary: ejecución, spec, límite (never run, ticket, especificación, presupuesto)', () => {
    // `error.limits` lists the options.limits keys (day, week, month, run, alert): `run` there is a field name.
    const FIELD_NAMES = new Set(['insights.error.limits'])
    const bad: string[] = []
    for (const area of AREAS) {
      for (const [key, raw] of Object.entries(CATALOGS.es[area] ?? {})) {
        if (FIELD_NAMES.has(`${area}.${key}`)) continue
        const text = raw.replace(/\{\{[^}]*\}\}|specrails_\w+(\([^)]*\))?|`[^`]*`/g, '')
        if (/\b(runs?|jobs?|dashboard|presupuestos?)\b|especificaci[oó]n/i.test(text) || (/\btickets?\b/i.test(text) && !/jira/i.test(text))) bad.push(`${area}.${key}: ${raw}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('names the spend ceiling a limit in every language, never a budget word', () => {
    const BUDGET = /\b(presupuesto|budget|orçamento)\b|预算|予算/i
    // settings.summary.index names the `budget` section (an enum value the agent passes as is).
    const SECTION_NAMES = new Set(['settings.summary.index'])
    const bad = SUPPORTED_LANGS.filter((lang) => lang !== 'en').flatMap((lang) => AREAS.flatMap((area) =>
      Object.entries(CATALOGS[lang]?.[area] ?? {}).filter(([key]) => !SECTION_NAMES.has(`${area}.${key}`)).filter(([, text]) => BUDGET.test(text.replace(/\{\{[^}]*\}\}|specrails_\w+(\([^)]*\))?|`[^`]*`/g, ''))).map(([key, text]) => `${lang}/${area}.${key}: ${text}`)))
    expect(bad).toEqual([])
  })
})

describe('lang: es end to end', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const QUESTION = { id: 'q1', nodePath: 'developer', kind: 'question', value: { kind: 'question', prompt: 'Which database?', text: 'Which database?', asker: 'build', options: [{ id: 'pg', label: 'Postgres' }, { id: 'lite', label: 'SQLite' }], recommended: 'pg' } }
  let desktop: FakeDesktop
  let client: Client

  beforeAll(async () => {
    const h = createHarness({ projects: [{ id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-wp12-shop-api' }] })
    desktop = await startDesktop(h)
    const db = desktop.dbs.get('p1')!
    createLoopRun(db, { id: 'r-ask', projectId: 'p1', loopId: 'loop-a', loopName: 'Implement', railIndex: null, ticketIds: [7], iterationLimit: 3, startedAt: ago(3_600_000), provider: 'claude' })
    pauseLoopRun(db, 'r-ask')
    db.prepare('UPDATE loop_runs SET runtime_status_json=? WHERE id=?').run(JSON.stringify({ pendingInterrupts: [QUESTION] }), 'r-ask')
    createLoopRun(db, { id: 'r-fail', projectId: 'p1', loopId: 'loop-a', loopName: 'Implement', railIndex: 1, ticketIds: [8], iterationLimit: 3, startedAt: ago(7_200_000), provider: 'claude' })
    finishLoopRun(db, 'r-fail', { outcome: 'failed', finishedAt: ago(60_000) })
    createPrDelivery(db, { id: 'd-review', railIndex: 0, loopId: 'loop-a', railKey: '0-loop-a', ticketIds: [9], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent', originConversationId: null })
    expect(transitionDecision(db, 'd-review', 'building', 'on_review')).toBe(true)
    desktop.on('GET', '/projects/p1/jobs/r-fail', { job: { id: 'r-fail', command: 'loop: Implement', status: 'failed', provider: 'claude', model: 'sonnet', started_at: ago(7_200_000), finished_at: ago(60_000), tickets: [{ id: 8, title: 'Add login' }] }, events: [] })
    desktop.on('GET', '/projects/p1/loop-runs/r-fail', { loopRun: { id: 'r-fail', loop_id: 'loop-a', loop_name: 'Implement', rail_index: 1, provider: 'claude', status: 'completed', iteration_count: 1 } })
    registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
    client = await h.connect()
  })
  afterAll(async () => { await client.close(); await desktop.close() })

  const es = (tool: string, args: Record<string, unknown>) => call(client, tool, { ...args, lang: 'es' })

  it('overview(app) summarizes in Spanish', async () => {
    const { envelope } = await es('specrails_overview', { action: 'app' })
    expect(envelope.ok).toBe(true)
    expect(envelope.summary).toMatch(/esperándote/)
    expect(envelope.summary).toContain('USD')
    expect(envelope.summary).not.toMatch(/waiting for you|spent today|Most urgent/)
    expect(envelope.data.mood).toBe('needs_you') // machine fields stay English
  })

  it('inbox(list) and its offer labels are Spanish; kinds and refs are not translated', async () => {
    const { envelope } = await es('specrails_inbox', { action: 'list' })
    expect(envelope.ok).toBe(true)
    expect(envelope.summary).not.toMatch(/need the person|Most urgent/)
    expect(envelope.summary).toMatch(/pregunta|persona/i)
    expect(envelope.data.items.map((item: { kind: string }) => item.kind)).toContain('question')
    expect(envelope.data.items.map((item: { ref: string }) => item.ref)).toContain('inbox:p1:question:r-ask')
  })

  it('runs(get) uses the app status word in Spanish', async () => {
    const { envelope } = await es('specrails_runs', { action: 'get', ref: 'run:shop-api/r-fail' })
    expect(envelope.ok).toBe(true)
    expect(envelope.state.status).toBe('failed')
    expect(envelope.summary).toContain(CATALOGS.es.core!['status.failed'])
    expect(envelope.summary).not.toMatch(/\bFailed\b/)
  })

  it('deliveries(get) explains the review in Spanish', async () => {
    const { envelope } = await es('specrails_deliveries', { action: 'get', ref: 'delivery:shop-api/d-review' })
    expect(envelope.ok).toBe(true)
    expect(envelope.state.status).toBe('ready_for_review')
    expect(envelope.summary).toContain(CATALOGS.es.core!['status.ready_for_review'])
    expect(envelope.summary).not.toMatch(/Recommended|Ready for review/)
  })

  it('an error message is Spanish too', async () => {
    const { envelope } = await es('specrails_deliveries', { action: 'get', ref: 'delivery:shop-api/nope' })
    expect(envelope.ok).toBe(false)
    expect(envelope.error.message).not.toMatch(/^No delivery/)
  })
})
