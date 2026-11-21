// Markdown report for a benchmark session (pure: data in, text out).

const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const money = v => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(3)}`)
const cell = v => String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** Summarize latency samples `[{ healthMs, boardMs }]`. */
export function latencySummary(samples) {
  const h = samples.map(s => s.healthMs).filter(Number.isFinite)
  const b = samples.map(s => s.boardMs).filter(Number.isFinite)
  return { samples: samples.length, health: { p50: pct(h, 50), p95: pct(h, 95), max: h.length ? Math.max(...h) : null }, board: { p50: pct(b, 50), p95: pct(b, 95), max: b.length ? Math.max(...b) : null } }
}

/**
 * @param {{ startedAt: string, finishedAt?: string, target: object, options: object, results: object[], quota: object[], latency?: object[], skipped?: object[], stopReason?: string|null }} session
 */
export function renderReport(session) {
  const r = session.results ?? []
  const lines = []
  lines.push(`# Implement benchmark report`, '')
  lines.push(`- Started: ${session.startedAt}${session.finishedAt ? ` · finished: ${session.finishedAt}` : ''}`)
  lines.push(`- Target: port ${session.target.port}, home \`${session.target.home}\``)
  lines.push(`- Provider/model: ${session.options.provider} / ${session.options.model ?? 'default'} · budget ${session.options.budgetRuns} runs · stop at weekly ${session.options.stopAtWeekly}%`)
  if (session.stopReason) lines.push(`- **Stopped launching:** ${session.stopReason}`)
  const total = r.reduce((s, x) => s + (Number(x.costUsd) || 0), 0)
  const by = k => r.filter(x => x.status === k).length
  lines.push('', '## Totals', '', `| Runs | Delivered | Failed | Stopped | Declined | Other | Matched expectation | Spend |`, `|---|---|---|---|---|---|---|---|`,
    `| ${r.length} | ${by('delivered')} | ${by('failed')} | ${by('stopped')} | ${by('declined')} | ${r.length - by('delivered') - by('failed') - by('stopped') - by('declined')} | ${r.filter(x => x.pass).length}/${r.length} | ${money(total)} |`)
  lines.push('', '## Scenarios', '', '| Scenario | Group | Engine | Expected | Outcome | Cost | Time | Launch | Questions | Actions | Notes |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (const x of r) {
    const qs = x.questions.map(q => `${q.asker}${q.answer?.optionId ? `→${q.answer.optionId}` : q.answer?.approve ? '→approve' : q.answer?.reject !== undefined ? '→reject' : q.answer ? '→text' : '→none'}`).join(', ')
    lines.push(`| ${cell(x.name)} | ${cell(x.group)} | ${cell(`${x.provider}/${x.model ?? '-'}`)} | ${x.expected} | ${x.pass ? '' : '**'}${x.status}${x.pass ? '' : '**'} | ${money(x.costUsd)} | ${x.durationS ?? '—'} s | ${x.launchMs ?? '—'} ms | ${cell(qs || '—')} | ${cell(x.actions.map(a => `${a.do}@${a.t}s`).join(', ') || '—')} | ${cell([x.endReason, ...x.notes].filter(Boolean).join('; ').slice(0, 300) || '—')} |`)
  }
  if (session.skipped?.length) {
    lines.push('', '## Not launched', '', '| Scenario | Reason |', '|---|---|')
    for (const s of session.skipped) lines.push(`| ${cell(s.name)} | ${cell(s.reason)} |`)
  }
  lines.push('', '## Quota timeline', '')
  if (!session.quota?.length) lines.push('No samples.')
  else {
    const keys = [...new Set(session.quota.flatMap(q => Object.keys(q).filter(k => k !== 'at').flatMap(p => Object.keys(q[p]).map(l => `${p} ${l}`))))]
    lines.push(`| Time | ${keys.join(' | ')} |`, `|---|${keys.map(() => '---').join('|')}|`)
    for (const q of session.quota) lines.push(`| ${q.at.slice(11, 16)}Z | ${keys.map(k => { const [p, l] = k.split(' '); return q[p]?.[l] !== undefined ? `${q[p][l]}%` : '—' }).join(' | ')} |`)
  }
  if (session.latency?.length) {
    const s = latencySummary(session.latency)
    lines.push('', '## Responsiveness', '', `${s.samples} samples. \`/api/health\` p50 ${s.health.p50} ms, p95 ${s.health.p95} ms, max ${s.health.max} ms. \`/api/live-board\` p50 ${s.board.p50} ms, p95 ${s.board.p95} ms, max ${s.board.max} ms.`)
  }
  const phaseRows = r.filter(x => x.phases.length)
  if (phaseRows.length) {
    lines.push('', '## Live-board phases', '')
    for (const x of phaseRows) lines.push(`- **${x.name}:** ${x.phases.map(p => `${p.phase}@${p.t}s`).join(' → ')}`)
  }
  return lines.join('\n') + '\n'
}
