import { describe, it, expect } from 'vitest'
import { toolRepositories } from './agent-runtime-repositories'
const repos = [{ id: 'front', name: 'Front', path: '/work/front/ticket-6' }, { id: 'back', name: 'Back', path: '/work/back/ticket-6' }]
const ids = (event: Parameters<typeof toolRepositories>[0]) => toolRepositories(event, repos, '/workspace').map(repo => repo.id)
describe('runtime tool repository attribution', () => {
  it('distinguishes worktrees with identical leaf names and multiple targets', () => {
    expect(ids({ targetPaths: ['/work/front/ticket-6/src/app.ts'] })).toEqual(['front'])
    expect(ids({ targetPaths: ['/work/back/ticket-6/src/app.ts', '/work/front/ticket-6/src/app.ts'] })).toEqual(['front', 'back'])
    expect(ids({ targetPaths: ['/work/back/ticket-60/src/app.ts'] })).toEqual([])
  })
  it('uses explicit cwd for relative paths, without carrying context between actions', () => {
    expect(ids({ targetPaths: ['src/app.ts'], cwd: '/work/back/ticket-6' })).toEqual(['back'])
    expect(ids({ detail: 'npm test' })).toEqual([])
    expect(ids({ detail: 'npm test', cwd: '/work/front/ticket-6' })).toEqual(['front'])
    expect(ids({ targetPaths: ['/work/back/ticket-6/a.ts'], cwd: '/work/front/ticket-6' })).toEqual(['back'])
  })
  it('recognizes shell root paths, spaces, and older detail-only events', () => {
    expect(ids({ detail: 'cd /work/back/ticket-6 && ./mvnw test' })).toEqual(['back'])
    expect(ids({ detail: '/work/front/ticket-6/src/app.ts' })).toEqual(['front'])
    expect(ids({ detail: 'cd /work/back/ticket-60 && npm test' })).toEqual([])
    expect(toolRepositories({ detail: 'cd "/my repo/back" && npm test' }, [{ id: 'back', path: '/my repo/back' }], '/')).toHaveLength(1)
  })
})
