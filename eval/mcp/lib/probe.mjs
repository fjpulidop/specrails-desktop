// Load probe (design §8/§14): read latency over the MCP surface on the seeded
// instance (the 100-project mode), and `wait` wake-up latency after an event.
// It uses the programmatic client, so it costs no model tokens.
import { percentile } from './metrics.mjs'
import { seedProject, seedSpec } from './seed.mjs'

/** The read mix a person's agent makes all day (each call is timed client-side). */
export function readMix(projects) {
  const slugs = projects.map(p => p.slug)
  const pick = i => slugs[i % slugs.length]
  const calls = [
    ['specrails_overview', { action: 'app' }],
    ['specrails_inbox', { action: 'list' }],
    ['specrails_projects', { action: 'list' }],
    ['specrails_deliveries', { action: 'list' }],
    ['specrails_runs', { action: 'list' }],
  ]
  for (let i = 0; i < Math.min(10, slugs.length); i++) {
    calls.push(['specrails_overview', { action: 'project', project: pick(i * 7) }])
    calls.push(['specrails_specs', { action: 'list', project: pick(i * 7 + 3) }])
    calls.push(['specrails_runs', { action: 'list', project: pick(i * 7 + 5) }])
  }
  return calls
}

export async function runProbe({ mcp, api, workDir, projects, rounds = 2, tag = 'probe' }) {
  const latencies = []
  const errors = []
  for (let r = 0; r < rounds; r++) {
    for (const [tool, args] of readMix(projects)) {
      const t0 = performance.now()
      const res = await mcp.call(tool, args)
      latencies.push(performance.now() - t0)
      if (res.isError) errors.push(`${tool}.${args.action}: ${res.envelope?.error?.code ?? 'error'}`)
    }
  }
  // wait wake-up: block on a spec, then move it over HTTP.
  const project = await seedProject(api, workDir, `${tag}-wake`)
  const specId = await seedSpec(api, project, { title: 'Wake probe', description: 'Changes once.' })
  const wakes = []
  for (let i = 0; i < 3; i++) {
    let changedAt
    const waiting = mcp.call('specrails_wait', { action: 'until', refs: [`spec:${project.slug}/${specId}`], for: 'changed', timeoutMs: 20_000 }).then(res => ({ res, at: performance.now() }))
    await new Promise(r => setTimeout(r, 800))
    // Measured from the moment the change is sent: includes the HTTP write (conservative).
    changedAt = performance.now()
    // The journal records state transitions, not edits: change the spec's status.
    await api.patch(`/projects/${project.id}/tickets/${specId}`, { status: i % 2 === 0 ? 'in_progress' : 'todo' })
    const { res, at } = await waiting
    if (!res.envelope?.data?.timedOut && res.envelope?.ok !== false) wakes.push(at - changedAt)
    else errors.push(`wait: ${res.envelope?.error?.code ?? (res.envelope?.data?.timedOut ? 'timed out' : 'error')}`)
  }
  return {
    projects: projects.length, reads: latencies.length,
    p50ReadMs: Math.round(percentile(latencies, 50) ?? 0), p95ReadMs: Math.round(percentile(latencies, 95) ?? 0),
    waitWakeMs: wakes.length ? Math.round(percentile(wakes, 95)) : null, wakes: wakes.map(Math.round), errors: errors.slice(0, 20),
  }
}
