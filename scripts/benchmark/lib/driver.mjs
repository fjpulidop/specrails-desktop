// Drives one benchmark scenario against the isolated server: repositories,
// registration, ticket, launch, question answers (by option id), restart/kill
// actions, and the final outcome. Every call goes through the HTTP API.

import { createRepo } from './repos.mjs'
import { chooseAnswer } from './scenarios.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function registerProject(api, repoPath, providers) {
  const res = await api.post('/projects', { path: repoPath, providers })
  if (res.status === 201 || res.status === 200) return (res.data.project ?? res.data).id
  if (res.status === 409) {
    const list = await api.get('/projects')
    const rows = Array.isArray(list.data) ? list.data : list.data?.projects ?? []
    const hit = rows.find(p => p.path === repoPath)
    if (hit) return hit.id
  }
  throw new Error(`register ${repoPath}: ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`)
}

async function waitProjectReady(api, projectId, timeoutMs = 600_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const res = await api.get(`/projects/${projectId}/rails`)
    if (res.status === 200) return Date.now() - t0
    await sleep(2000)
  }
  throw new Error(`project ${projectId} never became ready`)
}

/**
 * A published copy of the built-in Implement loop with "Approve archive" on
 * (the built-in keeps it off). Returns its loop id. Pure graph edit in `withApproval`.
 */
export function withApproval(graph) {
  const g = structuredClone(graph)
  g.config = { ...(g.config ?? {}), agents: { ...(g.config?.agents ?? {}), approvalBeforeArchive: true } }
  for (const n of g.nodes ?? []) if (n.id === 'approve' && n.data?.params) n.data.params.enabled = true
  return g
}

async function approvalLoop(api, cache) {
  if (cache.approvalLoopId) return cache.approvalLoopId
  const fork = await api.post('/loops/factory/factory:implement/fork', { name: 'Implement with approval (benchmark)' })
  if (fork.status !== 201) throw new Error(`fork implement loop: ${fork.status} ${JSON.stringify(fork.data).slice(0, 200)}`)
  const loop = fork.data.loop
  const put = await api.put(`/loops/${loop.id}`, { graph: withApproval(loop.graph) })
  if (put.status !== 200) throw new Error(`enable approval: ${put.status}`)
  const pub = await api.post(`/loops/${loop.id}/publish`, {})
  if (pub.status !== 200) throw new Error(`publish approval loop: ${pub.status} ${JSON.stringify(pub.data).slice(0, 200)}`)
  cache.approvalLoopId = loop.id
  return loop.id
}

/** Live board card for a run (matched by any id field). */
function cardFor(board, runId) {
  return (board?.cards ?? []).find(c => [c.id, c.runId, c.loopRunId, c.jobId].includes(runId)) ?? null
}

/**
 * Run a normalized scenario. `ctx` = { api, workDir, server: { restart(graceful) }, log(line), quota() }.
 * Returns a result row for the report.
 */
export async function runScenario(scenario, ctx) {
  const { api, workDir, log } = ctx
  const started = Date.now()
  const result = { name: scenario.name, group: scenario.group, provider: scenario.provider, model: scenario.model ?? null, expected: scenario.expect.status,
    status: 'error', costUsd: null, durationS: null, questions: [], actions: [], phases: [], runIds: [], notes: [] }
  try {
    const repoPaths = scenario.repos.map(spec => createRepo(spec, workDir))
    const projectId = await registerProject(api, repoPaths[0], [scenario.provider])
    result.projectId = projectId
    await waitProjectReady(api, projectId)
    if (repoPaths.length > 1) {
      for (const extra of repoPaths.slice(1)) {
        const r = await api.post(`/projects/${projectId}/repositories`, { path: extra })
        if (r.status >= 300) result.notes.push(`add repository ${extra}: ${r.status}`)
      }
    }
    const t = await api.post(`/projects/${projectId}/tickets`, { title: scenario.ticket.title, description: scenario.ticket.description })
    if (t.status >= 300) throw new Error(`ticket: ${t.status} ${JSON.stringify(t.data).slice(0, 300)}`)
    const ticketId = (t.data.ticket ?? t.data).id
    const rail = 0
    const slot = await api.put(`/projects/${projectId}/rails/${rail}/tickets`, { ticketIds: [ticketId], mode: 'implement', aiEngine: scenario.provider })
    if (slot.status >= 300) throw new Error(`rail slot: ${slot.status} ${JSON.stringify(slot.data).slice(0, 300)}`)
    const loopId = scenario.approvalBeforeArchive ? await approvalLoop(api, ctx.cache ?? (ctx.cache = {})) : 'factory:implement'
    const body = { loopId, aiEngine: scenario.provider, ...(scenario.model ? { model: scenario.model } : {}), ...(scenario.runCapUsd ? { runCapUsd: scenario.runCapUsd } : {}) }
    const launched = await api.post(`/projects/${projectId}/rails/${rail}/launch`, body)
    result.launchMs = Math.round(launched.ms)
    if (launched.status !== 202) throw new Error(`launch: ${launched.status} ${JSON.stringify(launched.data).slice(0, 400)}`)
    let runId = launched.data.loopRunIds?.[0] ?? launched.data.jobId
    result.runIds.push(runId)
    log(`${scenario.name}: launched ${runId}`)

    const used = new Set(); const fired = new Set()
    const deadline = started + scenario.timeoutMinutes * 60_000
    let lastPhase = null; let answeredInterrupts = new Set(); let autoResumes = 0
    while (Date.now() < deadline) {
      await sleep(5000)
      // The server may be restarting (another scenario's action): skip this poll, never fail the scenario.
      const polled = await Promise.all([
        api.get(`/projects/${projectId}/jobs/${runId}`), api.get(`/projects/${projectId}/loop-runs/${runId}`), api.get('/live-board', { timeoutMs: 30_000 }).catch(() => null)])
        .catch(() => { api.resetToken(); return null })
      if (!polled) continue
      const [jobRes, runRes, boardRes] = polled
      const job = jobRes.data?.job; const run = runRes.data?.loopRun
      const card = boardRes ? cardFor(boardRes.data, runId) : null
      const phase = card?.phase ?? null
      if (phase && phase !== lastPhase) { result.phases.push({ t: Math.round((Date.now() - started) / 1000), phase, column: card?.column ?? null }); lastPhase = phase }
      // Actions (restart / kill / cancel) at a phase, at a question, or after N seconds.
      for (const [i, action] of scenario.actions.entries()) {
        if (action.once && fired.has(i)) continue
        const due = action.when === 'question' ? Boolean(job?.question)
          : action.when.startsWith('phase:') ? phase === action.when.slice(6) || job?.currentPhase === action.when.slice(6)
          : (Date.now() - started) / 1000 >= Number(action.when.slice(8))
        if (!due) continue
        fired.add(i)
        const at = Math.round((Date.now() - started) / 1000)
        if (action.do === 'cancel') await api.post(`/projects/${projectId}/loop-runs/${runId}/cancel`, {})
        else await ctx.server.restart(action.do === 'restart')
        api.resetToken()
        result.actions.push({ t: at, do: action.do, when: action.when })
        log(`${scenario.name}: ${action.do} at ${at}s`)
        if (action.do !== 'cancel') await afterRestart(api, projectId, runId, result, log)
      }
      // A restart caused by ANOTHER scenario (or the person) pauses this run too: resume it once per pause.
      if (shouldResumeHeld(job, autoResumes)) {
        autoResumes++
        const resumed = await api.post(`/projects/${projectId}/loop-runs/${runId}/resume`, {})
        result.notes.push(`resumed a ${job.hold.kind} hold → ${resumed.status} in ${Math.round(resumed.ms)} ms`)
        log(`${scenario.name}: resumed ${job.hold.kind} hold → ${resumed.status}`)
        continue
      }
      if (job?.question && !answeredInterrupts.has(job.question.interruptId)) {
        const q = job.question
        const pick = chooseAnswer(q, scenario.answers, used)
        const entry = { t: Math.round((Date.now() - started) / 1000), asker: q.asker, kind: q.kind, text: String(q.text ?? '').slice(0, 400), options: (q.options ?? []).map(o => o.id), recommended: q.recommended ?? null, answer: pick?.body ?? null }
        result.questions.push(entry)
        if (!pick) { result.notes.push(`unanswered question: ${entry.text.slice(0, 120)}`); result.status = 'question-unanswered'; break }
        used.add(pick.index)
        let sent = await api.post(`/projects/${projectId}/jobs/${runId}/messages`, pick.body)
        if (sent.status === 409 && sent.data?.error === 'not_paused_here') {
          const b = pick.body
          const resumeBody = b.approve ? { approve: [b.interruptId] } : b.reject ? { reject: b.interruptId, reason: b.text } : { answer: b.text, interruptId: b.interruptId, ...(b.optionId ? { optionId: b.optionId } : {}) }
          sent = await api.post(`/projects/${projectId}/loop-runs/${runId}/resume`, resumeBody)
        }
        entry.answerStatus = sent.status
        answeredInterrupts.add(q.interruptId)
        log(`${scenario.name}: answered ${q.asker} ${JSON.stringify(pick.body).slice(0, 160)} → ${sent.status}`)
        continue
      }
      if (run && run.status === 'completed') {
        // Follow one automatic continuation (a fork of this run) when the outcome is a failure.
        if (run.final_outcome !== 'success' && !result.followed) {
          await sleep(20_000)
          const att = await api.get(`/projects/${projectId}/loop-runs/${runId}/attempts`)
          const next = (att.data?.attempts ?? []).map(a => a.id ?? a.runId).filter(id => id && !result.runIds.includes(id)).pop()
          if (next) { result.followed = true; result.runIds.push(next); runId = next; log(`${scenario.name}: following continuation ${next}`); continue }
        }
        result.status = outcomeOf(run)
        result.endReason = endReason(run)
        break
      }
    }
    if (result.status === 'error' && Date.now() >= deadline) result.status = 'timeout'
    let cost = 0
    for (const id of result.runIds) { const r = await api.get(`/projects/${projectId}/loop-runs/${id}`); cost += Number(r.data?.loopRun?.total_cost_usd ?? 0) }
    result.costUsd = Math.round(cost * 1000) / 1000
  } catch (error) {
    result.notes.push(String(error.message ?? error))
  }
  result.durationS = Math.round((Date.now() - started) / 1000)
  result.pass = scenario.expect.status === 'any' || result.status === scenario.expect.status
  return result
}

async function afterRestart(api, projectId, runId, result, log) {
  // A restart pauses the run; one Resume (or answering its question) continues it.
  for (let i = 0; i < 30; i++) {
    const job = (await api.get(`/projects/${projectId}/jobs/${runId}`)).data?.job
    if (job) {
      result.notes.push(`after restart: job ${job.status}, hold ${job.hold?.kind ?? 'none'}${job.question ? ', question pending' : ''}`)
      if (job.question) return
      if (job.hold) break
    }
    await sleep(1000)
  }
  const resumed = await api.post(`/projects/${projectId}/loop-runs/${runId}/resume`, {})
  log(`resume ${runId} → ${resumed.status} (${Math.round(resumed.ms)} ms)`)
  result.notes.push(`resume → ${resumed.status} in ${Math.round(resumed.ms)} ms`)
}

/** Max automatic resumes of one run held by a restart the scenario did not cause. */
export const MAX_AUTO_RESUMES = 3

/**
 * Should the driver resume this run? Only a restart/interruption hold with no pending
 * question (a question is answered instead), at most MAX_AUTO_RESUMES times. A provider
 * limit or budget hold is never resumed by the benchmark.
 */
export function shouldResumeHeld(job, autoResumes) {
  return Boolean(job?.hold && ['restart', 'interrupted'].includes(job.hold.kind) && !job.question && autoResumes < MAX_AUTO_RESUMES)
}

/** Map a settled loop run to a benchmark status. */
export function outcomeOf(run) {
  if (run.final_outcome === 'success') return 'delivered'
  if (run.final_outcome === 'cancelled' || run.final_outcome === 'stopped') return 'stopped'
  const reason = endReason(run) ?? ''
  if (/declined/i.test(reason)) return 'declined'
  return 'failed'
}

function endReason(run) {
  try { return JSON.parse(run.runtime_status_json ?? '{}')?.endReason ?? run.failureDiagnosis?.detail ?? null } catch { return run.failureDiagnosis?.detail ?? null }
}
