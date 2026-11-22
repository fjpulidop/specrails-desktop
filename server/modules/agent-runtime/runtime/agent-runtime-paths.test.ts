import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasAgentRuntimeRequest } from './agent-runtime-paths'

describe('hasAgentRuntimeRequest', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'sr-paths-')); dirs.push(dir); return dir }

  it('finds the request beside the context the run was admitted with, wherever the project layout moved since', () => {
    const repo = tmp(), worktree = tmp()
    const pipeline = join(worktree, '.specrails', 'pipeline', 'run-1')
    mkdirSync(pipeline, { recursive: true })
    writeFileSync(join(pipeline, 'agent-runtime-request.json'), '{}')
    // The project's own .specrails has no such run: only the frozen context path finds it.
    expect(hasAgentRuntimeRequest({ path: repo }, 'run-1')).toBe(false)
    expect(hasAgentRuntimeRequest({ path: repo }, 'run-1', join(pipeline, 'desktop-context.json'))).toBe(true)
  })

  it('falls back to the project pipeline and refuses unsafe ids', () => {
    const repo = tmp()
    mkdirSync(join(repo, '.specrails', 'pipeline', 'run-2'), { recursive: true })
    writeFileSync(join(repo, '.specrails', 'pipeline', 'run-2', 'agent-runtime-request.json'), '{}')
    expect(hasAgentRuntimeRequest({ path: repo }, 'run-2', '/gone/desktop-context.json')).toBe(true)
    expect(hasAgentRuntimeRequest({ path: repo }, '../run-2')).toBe(false)
    expect(hasAgentRuntimeRequest({ path: repo }, 'run-2', 'relative/desktop-context.json')).toBe(true)
  })
})
