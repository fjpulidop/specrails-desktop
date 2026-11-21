// After a one-objective burst: preview how the project's pending deliveries
// merge (conflicts with the base, sibling collisions), integrate them locally
// one by one in the order they finished (`merge-local`, never a push), and run
// the repository's tests on the integrated base. Every call goes through the API.

import { execFileSync } from 'node:child_process'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Deliveries waiting for the person's decision, oldest first (`GET /rails` → `prDeliveries`). Pure. */
export function pendingDeliveries(railsPayload) {
  return Object.values(railsPayload?.prDeliveries ?? {})
    .filter(d => d?.id && d.decision === 'on_review')
    .map(d => ({ id: d.id, rail: d.railIndex, at: d.onReviewAt ?? d.updatedAt ?? d.createdAt ?? null }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/** Summarize a merge-preview payload for the report. Pure. */
export function previewSummary(payload) {
  return (payload?.previews ?? []).map(p => ({ deliveryId: p.deliveryId, rail: p.railIndex, status: p.status, conflictFiles: p.conflictFiles ?? [],
    baseAdvancedBy: p.baseAdvancedBy ?? null, siblings: (p.siblings ?? []).map(s => ({ rail: s.railIndex ?? null, status: s.status ?? null, files: s.conflictFiles ?? s.files ?? [] })) }))
}

export async function mergeObjective(api, projectId, { repoPath, log, deliveries }) {
  const out = { previewBefore: null, merges: [], testsAfter: null }
  const preview = await api.get(`/projects/${projectId}/rails/merge-preview`)
  out.previewBefore = preview.status === 200 ? previewSummary(preview.data) : { status: preview.status }
  for (const delivery of deliveries) {
    const t0 = Date.now()
    const res = await api.post(`/projects/${projectId}/rails/pr-decision`, { prDeliveryId: delivery.id, action: 'merge-local', expectedDecision: 'on_review' }, { timeoutMs: 600_000 })
    out.merges.push({ deliveryId: delivery.id, rail: delivery.rail, status: res.status, ms: Date.now() - t0, decision: res.data?.decision ?? null, merged: res.data?.merged ?? null, detail: String(res.data?.detail ?? res.data?.error ?? '').slice(0, 300) })
    log?.(`merge-local rail ${delivery.rail}: ${res.status} ${res.data?.decision ?? ''} ${String(res.data?.detail ?? res.data?.error ?? '').slice(0, 120)}`)
    await sleep(1000)
  }
  if (repoPath) {
    try { execFileSync('npm', ['test'], { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 300_000 }); out.testsAfter = 'pass' } catch (error) { out.testsAfter = `fail: ${String(error.stdout ?? error.message).slice(-600)}` }
    try { out.log = execFileSync('git', ['log', '--oneline', '-12'], { cwd: repoPath, encoding: 'utf8' }) } catch { /* none */ }
  }
  return out
}
