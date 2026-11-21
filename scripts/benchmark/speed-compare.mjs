#!/usr/bin/env node
// A/B report of speed-benchmark sessions (the JSON written next to each report.md).
//   node scripts/benchmark/speed-compare.mjs --a base=a1.json,a2.json --b cand=b1.json [--b other=c1.json] [--md out.md]
// Every --b variant is compared with --a. Quality is a floor: any worse quality count is flagged.
import fs from 'node:fs'
import { runRow, summarize, compareMetric, qualityFloor } from './lib/speed-stats.mjs'

const groups = []
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]
  if (flag === '--a' || flag === '--b') {
    const [label, files] = process.argv[++i].split('=')
    groups.push({ role: flag.slice(2), label, rows: files.split(',').flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).results.map(runRow)) })
  }
}
const mdIndex = process.argv.indexOf('--md')
const a = groups.find(g => g.role === 'a')
if (!a || !groups.some(g => g.role === 'b')) { console.error('usage: --a label=files --b label=files [--md out.md]'); process.exit(2) }

const f = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d))
const lines = []
const sa = summarize(a.rows)
const head = '| Variant | Runs | Delivered | Accepted (hidden) | Suite | Lint | 1st-pass review | Hidden tests | Stray files | Wall median / p90 (s) | Cost median ($) | Tokens in median (k) | Out (k) | Corrections mean | Plan / Dev / Review / Fix median (s) | Verify runs mean |'
lines.push(head, '|' + head.split('|').slice(2).map(() => '---').join('|') + '|')
const row = (label, s) => lines.push(`| ${label} | ${s.runs} | ${s.delivered} | ${s.accepted} | ${s.suitePass} | ${s.lintPass} | ${s.firstPassReview} | ${s.hiddenPass}/${s.hiddenTests} | ${s.unexpectedFiles} | ${f(s.wallS.median, 0)} / ${f(s.wallS.p90, 0)} | ${f(s.costUsd.median, 3)} | ${f(s.tokensIn.median / 1000, 0)} | ${f(s.tokensOut.median / 1000, 1)} | ${f(s.corrections.mean, 2)} | ${f(s.planS.median, 0)} / ${f(s.developS.median, 0)} / ${f(s.reviewS.median, 0)} / ${f(s.fixS.median, 0)} | ${f(s.verifyRuns.mean, 1)} |`)
row(a.label, sa)
for (const b of groups.filter(g => g.role === 'b')) {
  const sb = summarize(b.rows)
  row(b.label, sb)
}
for (const b of groups.filter(g => g.role === 'b')) {
  const sb = summarize(b.rows)
  lines.push('', `### ${b.label} vs ${a.label}`, '', '| Metric | Ratio B/A (geo-mean, spec-normalized) | 95 % CI | Mann-Whitney p |', '|---|---|---|---|')
  for (const m of ['wallS', 'coreS', 'costUsd', 'tokensIn', 'tokensOut', 'planS', 'developS', 'reviewS']) {
    const c = compareMetric(a.rows, b.rows, m)
    lines.push(`| ${m} | ${f(c.ratio, 3)} | ${c.ci ? `${f(c.ci[0], 3)}–${f(c.ci[1], 3)}` : '—'} | ${f(c.p, 3)} |`)
  }
  const wall = compareMetric(a.rows, b.rows, 'wallS')
  lines.push('', 'Wall median per spec (A → B): ' + Object.entries(wall.perSpec).map(([s, v]) => `${s} ${f(v.a, 0)}→${f(v.b, 0)}`).join(', '))
  const floor = qualityFloor(sa, sb)
  lines.push('', 'Quality floor: ' + floor.map(q => `${q.key} ${q.a}→${q.b}${q.worse ? ' **WORSE**' : ''}${q.p !== undefined ? ` (p ${f(q.p, 2)})` : ''}`).join('; '))
}
lines.push('', '#### Runs', '', '| Variant | Run | Status | Wall s | Cost | Corr | Accepted | Hidden | Notes |', '|---|---|---|---|---|---|---|---|---|')
for (const g of groups) for (const r of g.rows) lines.push(`| ${g.label} | ${r.name} | ${r.status} | ${r.wallS} | ${f(r.costUsd, 3)} | ${r.corrections} | ${r.accepted} | ${r.hiddenPass}/${r.hiddenTests} | ${r.unexpectedFiles ? `${r.unexpectedFiles} stray` : ''} |`)
const text = lines.join('\n') + '\n'
if (mdIndex > 0) fs.writeFileSync(process.argv[mdIndex + 1], text)
process.stdout.write(text)
