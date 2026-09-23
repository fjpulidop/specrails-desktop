import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeRuntimeHistory, readRuntimeHistory } from './agent-runtime-history'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-history-'))
const context = path.join(directory, 'desktop-context.json')
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
it('replaces prior optional data on continuation and rejects changed scope or corrupted history', () => {
  fs.writeFileSync(context, JSON.stringify({ runId: 'run-1', repositories: [{ path: '/removed/worktree' }] }))
  writeRuntimeHistory(context, { status: 'succeeded', nextStep: 'archive', error: 'old' })
  expect(readRuntimeHistory(context)).toMatchObject({ status: 'succeeded', nextStep: 'archive' })
  writeRuntimeHistory(context, { status: 'running' })
  expect(readRuntimeHistory(context)).toMatchObject({ status: 'running', nextStep: null })
  expect(readRuntimeHistory(context)).not.toHaveProperty('error')
  writeRuntimeHistory(context, { status: 'failed', error: 'new failure' })
  expect(readRuntimeHistory(context)).toMatchObject({ status: 'failed', error: 'new failure', metrics: undefined, efficiencySummary: undefined })
  fs.writeFileSync(context, JSON.stringify({ runId: 'other' }))
  expect(() => readRuntimeHistory(context)).toThrow('scope changed')
  fs.writeFileSync(path.join(directory, 'desktop-runtime-history.json'), JSON.stringify({ payload: '{}', integrity: 'wrong' }))
  expect(() => readRuntimeHistory(context)).toThrow('integrity')
})
