import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import { initDb } from '../../../db'
import { __resetFetchOriginCache } from '../../../integration-branch'
import type { ProjectContext } from '../../../project-registry'
import type { WorktreeHandle } from '../../../worktree-manager'
import {
  isolatedWorktreesRoot, materializeIsolatedWorktree, prepareIsolatedWorktree,
  type IsolatedWorktreeIO, type OverlaySources,
} from './isolated-worktree'
import { ticketBranchName } from './pr-naming'

const SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
const overlaySources: OverlaySources = { sourceRoot: '/repo', providerDir: '.claude', instructionsFilename: 'CLAUDE.md' }

beforeEach(() => { __resetFetchOriginCache() })

function gitRecorder(answer?: (args: string[]) => { code: number; stdout: string; stderr: string } | undefined) {
  const calls: string[][] = []
  const run = vi.fn(async (args: string[]) => {
    calls.push(args)
    const custom = answer?.(args)
    if (custom) return custom
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.endsWith('^{commit}')) return { code: 0, stdout: `${BASE_SHA}\n`, stderr: '' }
    if (args[0] === 'rev-parse' && args.includes('--verify')) return { code: 0, stdout: `${SHA}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
  return { git: { run }, calls }
}

function baseIo(handle: Partial<WorktreeHandle> = {}): Required<Pick<IsolatedWorktreeIO, 'create' | 'remove' | 'overlay' | 'linkNodeModules'>> & IsolatedWorktreeIO {
  return {
    create: vi.fn(async (_git, input) => ({
      branch: input.branch!, worktreePath: path.join(input.worktreesRoot, `ticket-${input.ticketId}`),
      worktreeCreated: true, branchCreated: true, ...handle,
    })),
    remove: vi.fn(async () => {}),
    overlay: vi.fn(() => ({ createdPaths: ['.claude'], warnings: [], cleanupEvidence: [{ path: '.claude' }] })) as never,
    linkNodeModules: vi.fn(() => ({ linked: ['node_modules'], authenticated: ['node_modules'], warnings: [], evidence: [{ path: 'node_modules' }] })) as never,
    snapshot: vi.fn(() => null) as never,
  }
}

describe('materializeIsolatedWorktree', () => {
  it('creates the worktree and returns overlay, warm-link and ownership evidence', async () => {
    const { git } = gitRecorder()
    const io = { ...baseIo(), git }
    const onDegraded = vi.fn()
    const result = await materializeIsolatedWorktree({
      repoDir: '/repo', worktreesRoot: '/wt/run-1', slug: 'p', ticketId: 7, baseRef: 'origin/main',
      branch: 'feat/7-x', branchOwnership: 'created', fresh: true, overlay: overlaySources, onDegraded,
    }, io)
    expect(io.create).toHaveBeenCalledWith(git, expect.objectContaining({ baseRef: 'origin/main', branch: 'feat/7-x', fresh: true }))
    expect(io.linkNodeModules).toHaveBeenCalledWith('/repo', '/wt/run-1/ticket-7')
    expect(result).toMatchObject({
      worktreePath: '/wt/run-1/ticket-7', branch: 'feat/7-x', initialSha: SHA,
      overlayExcludes: ['.claude', 'node_modules'],
      overlayCleanupEvidence: [{ path: '.claude' }], warmLinkEvidence: [{ path: 'node_modules' }],
      branchOwnership: 'created', worktreeOwnership: 'created',
    })
    expect(onDegraded).not.toHaveBeenCalled()
  })

  it('degrades (never aborts) when the overlay or warm links fail', async () => {
    const { git } = gitRecorder()
    const io = {
      ...baseIo(), git,
      overlay: vi.fn(() => { throw new Error('overlay boom') }) as never,
      linkNodeModules: vi.fn(() => ({ linked: [], warnings: ['lockfile differs'], evidence: [] })) as never,
    }
    const onDegraded = vi.fn()
    const result = await materializeIsolatedWorktree({
      repoDir: '/repo', worktreesRoot: '/wt/r', slug: 'p', ticketId: 1, baseRef: 'main',
      branch: 'b', branchOwnership: 'created', overlay: overlaySources, onDegraded,
    }, io)
    expect(onDegraded).toHaveBeenNthCalledWith(1, ['overlay boom'])
    expect(onDegraded).toHaveBeenNthCalledWith(2, ['lockfile differs'])
    expect(result.overlayExcludes).toEqual([])
  })

  it('rolls back only created resources when verification fails', async () => {
    const { git } = gitRecorder()
    const io = { ...baseIo(), git }
    await expect(materializeIsolatedWorktree({
      repoDir: '/repo', worktreesRoot: '/wt/r', slug: 'p', ticketId: 2, baseRef: 'main',
      branch: 'b', branchOwnership: 'created', overlay: overlaySources, onDegraded: vi.fn(),
      verifyHead: async () => { throw new Error('head moved') },
    }, io)).rejects.toThrow('head moved')
    expect(io.remove).toHaveBeenCalledWith(git, { repoDir: '/repo', worktreePath: '/wt/r/ticket-2', branch: 'b', deleteBranch: true })
    expect(io.overlay).not.toHaveBeenCalled()

    const borrowed = { ...baseIo({ worktreeCreated: false, branchCreated: false }), git }
    await expect(materializeIsolatedWorktree({
      repoDir: '/repo', worktreesRoot: '/wt/r', slug: 'p', ticketId: 2, baseRef: 'main',
      branch: 'b', branchOwnership: 'borrowed-pr', pinBranchOwnership: true, overlay: overlaySources, onDegraded: vi.fn(),
      verifyHead: async () => { throw new Error('head moved') },
    }, borrowed)).rejects.toThrow('head moved')
    expect(borrowed.remove).not.toHaveBeenCalled()
  })

  it('downgrades branch ownership for reused branches unless pinned', async () => {
    const { git } = gitRecorder()
    const reused = await materializeIsolatedWorktree({
      repoDir: '/repo', worktreesRoot: '/wt/r', slug: 'p', ticketId: 3, baseRef: 'main',
      branch: 'b', branchOwnership: 'created', overlay: overlaySources, onDegraded: vi.fn(),
    }, { ...baseIo({ branchCreated: false }), git })
    expect(reused.branchOwnership).toBe('preexisting')
    const pinned = await materializeIsolatedWorktree({
      repoDir: '/repo', worktreesRoot: '/wt/r', slug: 'p', ticketId: 3, baseRef: 'main',
      branch: 'b', branchOwnership: 'borrowed-pr', pinBranchOwnership: true, overlay: overlaySources, onDegraded: vi.fn(),
    }, { ...baseIo({ branchCreated: false, worktreeCreated: false }), git })
    expect(pinned).toMatchObject({ branchOwnership: 'borrowed-pr', worktreeOwnership: 'preexisting' })
  })
})

describe('prepareIsolatedWorktree', () => {
  function ctx(): ProjectContext {
    return {
      project: { id: 'proj', slug: 'p', path: '/repo' },
      db: initDb(':memory:'),
      getTicketSpec: (id: number) => ({ title: `Add login ${id}`, labels: ['feature'] }),
    } as unknown as ProjectContext
  }

  it('fetches, resolves the integration base and plans a fresh conventional branch under a run-specific root', async () => {
    const { git, calls } = gitRecorder()
    const io = { ...baseIo(), git }
    const project = ctx()
    const result = await prepareIsolatedWorktree({ ctx: project, ticketId: 4, provider: 'claude', runId: 'run-4' }, io)
    const expectedBranch = ticketBranchName({ ticketId: 4, title: 'Add login 4', labels: ['feature'], jiraKey: null })
    expect(calls[0]).toEqual(['fetch', 'origin'])
    expect(io.create).toHaveBeenCalledWith(git, expect.objectContaining({
      repoDir: '/repo', worktreesRoot: path.join(isolatedWorktreesRoot('p'), 'run-4'), ticketId: 4,
      baseRef: 'origin/main', branch: expectedBranch, fresh: true,
    }))
    expect(result).toMatchObject({
      runId: 'run-4', baseRef: 'origin/main', baseSha: BASE_SHA, integrationBranch: 'main',
      branch: expectedBranch, initialSha: SHA, branchOwnership: 'created', worktreeOwnership: 'created',
      overlayExcludes: ['.claude', 'node_modules'],
    })
  })

  it('honours an explicit base ref and branch, and suffixes colliding conventional names', async () => {
    const { git } = gitRecorder()
    const io = { ...baseIo(), git }
    const explicit = await prepareIsolatedWorktree({ ctx: ctx(), ticketId: 5, provider: 'claude', baseRef: 'release/1', branch: 'flow/5-x' }, io)
    expect(io.create).toHaveBeenLastCalledWith(git, expect.objectContaining({ baseRef: 'release/1', branch: 'flow/5-x', fresh: true }))
    expect(explicit).toMatchObject({ baseRef: 'release/1', integrationBranch: 'release/1' })

    const taken = ticketBranchName({ ticketId: 6, title: 'Add login 6', labels: ['feature'], jiraKey: null })
    const colliding = gitRecorder((args) => args[0] === 'for-each-ref' ? { code: 0, stdout: `${taken}\n`, stderr: '' } : undefined)
    const suffixed = await prepareIsolatedWorktree({ ctx: ctx(), ticketId: 6, provider: 'claude' }, { ...baseIo(), git: colliding.git })
    expect(suffixed.branch).toBe(`${taken}-2`)
  })

  it('reports a degraded fetch and fails closed when the worktree cannot be created', async () => {
    const { git } = gitRecorder((args) => args[0] === 'fetch' ? { code: 1, stdout: '', stderr: 'offline' } : undefined)
    const onDegraded = vi.fn()
    const io = { ...baseIo(), git, create: vi.fn(async () => { throw new Error('Fresh launch cannot reuse existing branch b') }) }
    await expect(prepareIsolatedWorktree({ ctx: ctx(), ticketId: 8, provider: 'claude', branch: 'b', onDegraded }, io)).rejects.toThrow('cannot reuse existing branch')
    expect(onDegraded).toHaveBeenCalledWith(['git fetch origin failed; using local ref'])
    expect(io.remove).not.toHaveBeenCalled()
  })
})
