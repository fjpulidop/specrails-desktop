// Event-loop stall benchmark for the job start/finish git work.
//
// Provenance capture (and the loop progress fingerprint) used to run as
// synchronous git children on the server's only event loop, freezing HTTP,
// WebSocket and queue work for the whole capture. On a 2,000-file repository
// with 200 changed files the measured stalls were ~200 ms (pre-job snapshot),
// ~1,075 ms (post-job diff + 50 patches) and ~140 ms (loop fingerprint). This
// test re-measures the async implementation on the same shape and fails if any
// phase blocks the loop for longer than a generous ceiling (well under the old
// numbers, well above scheduler noise on a loaded CI runner).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { snapshotWorkingTree, captureProvenance, type WorkingTreeSnapshot } from './file-provenance'
import { createLoopExecutors } from '../../loops/runtime/loop-executors'

const FILES = 2000
const CHANGED = 200
const MAX_STALL_MS = 250

interface Sample { wallMs: number; maxStallMs: number; histogramMaxMs: number }

/** Run `fn` while sampling the event loop: a 1 ms interval records the largest
 *  gap between ticks (a synchronous block shows up as one long gap), alongside
 *  perf_hooks' own delay histogram. */
async function measure(fn: () => Promise<unknown>): Promise<Sample> {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  let last = performance.now()
  let maxGap = 0
  const tick = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 1)
  const started = performance.now()
  await fn()
  const wallMs = performance.now() - started
  await new Promise((resolve) => setTimeout(resolve, 5))
  clearInterval(tick)
  histogram.disable()
  return { wallMs, maxStallMs: maxGap, histogramMaxMs: histogram.max / 1e6 }
}

describe('job start/finish git work does not stall the event loop', () => {
  let dir: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  const file = (i: number) => path.join(dir, `d${i % 50}`, `f${i}.ts`)

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-stall-'))
    git('init', '-q')
    git('config', 'user.email', 'bench@example.test')
    git('config', 'user.name', 'Bench')
    git('config', 'commit.gpgsign', 'false')
    for (let i = 0; i < FILES; i++) {
      fs.mkdirSync(path.dirname(file(i)), { recursive: true })
      fs.writeFileSync(file(i), `export const v${i} = ${i}\n`.repeat(20))
    }
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }, 60_000)

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it(`captures ${CHANGED} changed files of ${FILES} with a bounded loop stall`, async () => {
    // Half the changes predate the job (dirty tree at snapshot), half are its own.
    for (let i = 0; i < CHANGED / 2; i++) fs.appendFileSync(file(i), 'pre-existing edit\n')
    let snap!: WorkingTreeSnapshot
    const start = await measure(async () => { snap = await snapshotWorkingTree(dir) })
    for (let i = CHANGED / 2; i < CHANGED; i++) fs.appendFileSync(file(i), 'job edit\n')
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `created-${i}.ts`), 'created\n')
    let entries = 0
    let patches = 0
    const finish = await measure(async () => {
      const captured = await captureProvenance(dir, snap)
      entries = captured.diff.length
      patches = captured.patches.size
    })
    const fingerprint = await measure(() => Promise.resolve(createLoopExecutors().repoStateHash!(dir)))

    const report = (name: string, s: Sample) =>
      `${name}: wall ${s.wallMs.toFixed(0)} ms, max stall ${s.maxStallMs.toFixed(1)} ms (histogram ${s.histogramMaxMs.toFixed(1)} ms)`
    console.info(`[provenance-stall] ${FILES} files / ${CHANGED} changed\n  ${report('snapshot', start)}\n  ${report('finish', finish)}\n  ${report('loop fingerprint', fingerprint)}`)

    // Same capture semantics: only the job's own 100 edits + 20 new files.
    expect(entries).toBe(CHANGED / 2 + 20)
    expect(patches).toBe(50)
    expect(start.maxStallMs).toBeLessThan(MAX_STALL_MS)
    expect(finish.maxStallMs).toBeLessThan(MAX_STALL_MS)
    expect(fingerprint.maxStallMs).toBeLessThan(MAX_STALL_MS)
  }, 60_000)
})
