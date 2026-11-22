// Orchestrates one eval run: isolated instance → tool probes → scenarios
// (seed, conversation with the simulated person, HTTP checker, server-side
// metrics) → optional load probe → JSON + Markdown report.
import fs from 'node:fs'
import path from 'node:path'
import { assertEvalTarget } from './isolation.mjs'
import { bootInstance, EVAL_DIR } from './instance.mjs'
import { connectMcp, proxyCommand } from './mcp-client.mjs'
import { prepareClientHome, runTurn, addUsage, authProblem, DEFAULT_MODELS } from './clients.mjs'
import { pairCalls, parseLog, scenarioMetrics } from './metrics.mjs'
import { nextReply } from './person.mjs'
import { selectScenarios, pendingReason, promptOf, TOOL_PROBES } from './scenarios.mjs'
import { passed } from './checks.mjs'
import { tokenCounter } from './tokens.mjs'
import { buildReport, renderMarkdown } from './report.mjs'
import { runProbe } from './probe.mjs'
import { seedManyProjects } from './seed.mjs'
import { quotaWindows } from '../../../scripts/benchmark/lib/quota.mjs'

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19)

/** Which needed v2 tools answer (anything but `not_implemented`) on this instance. */
export async function probeTools(mcp) {
  const available = {}
  for (const [tool, args] of Object.entries(TOOL_PROBES)) {
    if (!mcp.tools.some(t => t.name === tool)) { available[tool] = false; continue }
    const res = await mcp.call(tool, args).catch(() => null)
    // A stub answers not_implemented; a v1 action still served through the legacy bridge carries a deprecation warning.
    available[tool] = Boolean(res) && res.envelope?.error?.code !== 'not_implemented' && !(res.envelope?.warnings ?? []).some(w => /deprecated/i.test(w))
  }
  available['cli:mcp-connect'] = fs.existsSync(path.join(EVAL_DIR, '..', '..', 'cli', 'mcp-connect.ts'))
  return available
}

/** Claude's short (5-hour) window, read through the isolated app's own usage reader. */
export async function claudeWindow(api) {
  await api.post('/subscription-usage/refresh', { providerId: 'claude' }).catch(() => null)
  // The refresh is asynchronous (and slower right after a fresh boot): read until it lands.
  for (let i = 0; i < 12; i++) {
    const usage = (await api.get('/subscription-usage').catch(() => null))?.data
    const short = quotaWindows(usage).filter(w => w.provider === 'claude' && !w.weekly)
    if (short.length) return Math.max(...short.map(w => w.usedPercent))
    await new Promise(r => setTimeout(r, 1500))
  }
  return null
}

export async function runEval(o, { log = console.log } = {}) {
  const target = assertEvalTarget({ home: o.home, port: o.port, clientPort: o.clientPort })
  const startedAt = new Date().toISOString()
  const runDir = path.join(o.workDir, 'runs', `${stamp()}-${o.client}${o.v1 ? '-v1' : ''}`)
  fs.mkdirSync(runDir, { recursive: true })
  const model = o.model ?? DEFAULT_MODELS[o.client] ?? null
  const tokens = await tokenCounter()
  const instance = await bootInstance({ home: target.home, port: target.port, clientPort: target.clientPort, workDir: o.workDir, v2: !o.v1, coreDir: o.coreDir, fresh: o.fresh, log })
  const quota = []
  const rows = []
  let probe = null
  let spent = 0
  try {
    // Tool availability is a v2 property; the v1 baseline runs the scenarios v2 can run.
    const prober = await connectMcp(proxyCommand({ logFile: path.join(runDir, 'probe.mcp.jsonl'), home: target.home, port: target.port, label: 'probe' }))
    const v2Instance = !o.v1
    const available = v2Instance ? await probeTools(prober) : Object.fromEntries(Object.keys(TOOL_PROBES).map(t => [t, !['specrails_blueprint', 'specrails_missions', 'specrails_insights', 'specrails_settings', 'specrails_providers', 'specrails_integrations', 'specrails_system'].includes(t)]))
    log(`tools: ${Object.entries(available).map(([t, ok]) => `${t.replace('specrails_', '')}${ok ? '' : ' (pending)'}`).join(', ')}`)
    // Seeds may drive the app through MCP too (the probe connection: its calls never count as the scenario's).
    const ctxBase = { api: instance.api, workDir: o.workDir, fleetSize: o.fleet, engineLog: instance.engineLog, mcp: prober, evalHome: target.home, coreDir: o.coreDir, log }
    for (const scenario of selectScenarios(o.scenario)) {
      for (let n = 1; n <= o.repeat; n++) {
        const row = { id: scenario.id, title: scenario.title, clientName: o.client, model, mode: o.v1 ? 'v1' : 'v2', lang: scenario.lang ?? 'en', repeatIndex: o.repeat > 1 ? n : 0, referenceCalls: scenario.referenceCalls, status: 'pending', reason: null }
        rows.push(row)
        const pending = pendingReason(scenario, available) ?? (scenario.fleet && !o.fleet ? '100-project seed disabled (--fleet 0)' : null)
        if (pending) { row.reason = pending; log(`${scenario.id}: pending — ${pending}`); continue }
        if (o.client !== 'replay') {
          if (spent >= o.maxCostUsd) { row.status = 'skipped'; row.reason = `client cost cap $${o.maxCostUsd} reached`; continue }
          if (o.client === 'claude' && !o.noQuotaGuard) {
            const used = await claudeWindow(instance.api)
            quota.push({ at: new Date().toISOString(), used, reason: used === null ? 'claude 5-hour window unknown' : `claude 5-hour window ${used}%` })
            if (used === null || used >= o.stopAtWindow) { row.status = 'skipped'; row.reason = used === null ? 'Claude 5-hour window unknown (pass --no-quota-guard to run anyway)' : `Claude 5-hour window at ${used}% (stop at ${o.stopAtWindow}%)`; log(`${scenario.id}: ${row.reason}`); continue }
          }
        }
        const tag = `${Date.now().toString(36).slice(-5)}${n}`
        const t0 = Date.now()
        let facts = null
        try {
          log(`${scenario.id}: seeding`)
          if (scenario.fleet && !ctxBase.fleet) ctxBase.fleet = await seedManyProjects(instance.api, o.workDir, o.fleet)
          facts = await scenario.seed({ ...ctxBase, tag })
          const logFile = path.join(runDir, `${scenario.id}-${n}.mcp.jsonl`)
          const proxy = proxyCommand({ logFile, home: target.home, port: target.port, label: scenario.id })
          const conversation = o.client === 'replay'
            ? await replayConversation(scenario, facts, proxy)
            : await agentConversation({ o, model, scenario, facts, proxy, dir: path.join(runDir, 'clients', `${scenario.id}-${n}`), root: o.workDir })
          row.client = conversation.client
          row.turns = conversation.turns
          spent += conversation.client?.costUsd ?? 0
          if (conversation.authError) { row.status = 'error'; row.reason = `client not signed in${o.auth === 'session' ? ' (session auth)' : ' inside its temp home'}: ${conversation.authError}`; log(`${scenario.id}: ${row.reason}`); continue }
          await new Promise(r => setTimeout(r, 2000)) // let settled effects land before the HTTP check
          const records = fs.existsSync(logFile) ? parseLog(fs.readFileSync(logFile, 'utf8')) : []
          const { calls } = pairCalls(records)
          row.metrics = scenarioMetrics(records, tokens, { v1: o.v1 })
          row.assertions = o.v1 ? [] : await scenario.check({ api: instance.api, facts, calls, metrics: row.metrics, finalText: o.client === 'replay' ? null : conversation.finalText })
          row.status = o.v1 ? 'baseline' : passed(row.assertions) ? 'pass' : 'fail'
          row.finalText = conversation.finalText?.slice(0, 1500) ?? null
          log(`${scenario.id}: ${row.status} (${row.metrics.calls} calls, ${row.metrics.errors} errors${row.client?.costUsd ? `, $${row.client.costUsd.toFixed(4)}` : ''})`)
        } catch (error) {
          row.status = 'error'
          row.reason = String(error?.message ?? error).slice(0, 300)
          log(`${scenario.id}: error — ${row.reason}`)
        } finally {
          row.wallMs = Date.now() - t0
          if (scenario.teardown && facts) await scenario.teardown(facts).catch(error => log(`${scenario.id}: teardown — ${String(error?.message ?? error).slice(0, 200)}`))
        }
      }
    }
    if (o.probe) {
      log('probe: seeding and measuring')
      const projects = ctxBase.fleet ?? (o.fleet ? await seedManyProjects(instance.api, o.workDir, o.fleet) : [])
      probe = await runProbe({ mcp: prober, api: instance.api, workDir: o.workDir, projects: projects.length ? projects : [], tag: `probe-${Date.now().toString(36).slice(-4)}` })
      log(`probe: p95 read ${probe.p95ReadMs} ms, wait wake ${probe.waitWakeMs} ms`)
    }
    await prober.close()
  } finally {
    if (!o.keepServer && !instance.reused) await instance.stop()
  }
  const baseline = o.baseline ? JSON.parse(fs.readFileSync(o.baseline, 'utf8')).rows ?? [] : []
  const report = buildReport({ startedAt, finishedAt: new Date().toISOString(), options: { client: o.client, model, auth: o.auth ?? 'temp', effort: o.client === 'codex' && o.auth === 'session' ? (o.effort ?? 'low') : (o.effort ?? null), scenario: o.scenario, repeat: o.repeat, v1: o.v1, fleet: o.fleet, port: target.port }, rows, baseline, probe, quota })
  const out = o.out ?? path.join(EVAL_DIR, 'results')
  fs.mkdirSync(out, { recursive: true })
  const base = path.join(out, `${startedAt.slice(0, 10)}-${o.client}${o.v1 ? '-v1' : ''}-${stamp().slice(11)}`)
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(`${base}.md`, renderMarkdown(report))
  log(`report: ${base}.md`)
  return { report, files: [`${base}.json`, `${base}.md`] }
}

async function replayConversation(scenario, facts, proxy) {
  const mcp = await connectMcp(proxy)
  try { await scenario.reference(mcp, facts) } finally { await mcp.close() }
  return { client: null, turns: 0, finalText: null }
}

async function agentConversation({ o, model, scenario, facts, proxy, dir, root }) {
  const prepared = prepareClientHome({ client: o.client, dir, root, proxy, auth: o.auth ?? 'temp', effort: o.effort ?? 'low' })
  let usage = { input: null, output: null, cacheRead: null, cacheWrite: null, costUsd: null }
  let prompt = promptOf(scenario, facts)
  let session = null
  let finalText = ''
  let used = 0
  let turns = 0
  for (; turns < 6; turns++) {
    const turn = await runTurn({ client: o.client, binary: o.clientBin, model, prompt, session, prepared, timeoutMs: o.turnTimeoutS * 1000, budgetUsd: o.client === 'claude' && o.maxCostUsd ? o.maxCostUsd : null })
    const auth = authProblem(turn)
    if (auth && !turn.parsed.toolUses) return { client: { tokens: usage, costUsd: usage.costUsd }, turns: turns + 1, finalText: turn.parsed.text, authError: auth }
    usage = addUsage(usage, { ...turn.parsed.tokens, costUsd: turn.parsed.costUsd })
    session = turn.parsed.session ?? session
    finalText = turn.parsed.text || finalText
    const records = fs.existsSync(proxy.args[proxy.args.indexOf('--log') + 1]) ? parseLog(fs.readFileSync(proxy.args[proxy.args.indexOf('--log') + 1], 'utf8')) : []
    const reply = session ? nextReply(scenario.person, { calls: pairCalls(records).calls, lastText: finalText, used }) : null
    if (!reply) { turns++; break }
    used++
    prompt = reply
  }
  return { client: { tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }, costUsd: usage.costUsd }, turns, finalText }
}
