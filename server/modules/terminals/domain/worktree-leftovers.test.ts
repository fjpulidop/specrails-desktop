import { describe, expect, it } from 'vitest'
import type { ProcessSample } from './mission-resources'
import { commandHead, isReapableWorktreePath, protectedPids, selectWorktreeLeftovers } from './worktree-leftovers'

const WT = '/Users/me/.specrails/projects/game/worktrees/run-1/ticket-4'
const row = (pid: number, ppid: number, command: string): ProcessSample => ({ pid, ppid, cpuPercent: 0, rssBytes: 0, command })
const SERVER = 100

const table: ProcessSample[] = [
  row(1, 0, '/sbin/launchd'),
  row(90, 1, '/Applications/Specrails.app/Contents/MacOS/specrails'),
  row(SERVER, 90, 'specrails-server'),
  // Escaped Playwright webServer tree, re-parented to launchd.
  row(200, 1, `/bin/sh -c npm run build && npm run preview`),
  row(201, 200, `npm run preview`),
  row(202, 201, `node ${WT}/node_modules/.bin/vite preview`),
  row(203, 202, `${WT}/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5`),
  // A registered background process the user started in the same worktree.
  row(300, SERVER, `npm run dev --prefix ${WT}`),
  row(301, 300, `node ${WT}/node_modules/.bin/vite`),
  // The settlement's own git call.
  row(400, SERVER, `git -C ${WT} status --porcelain`),
  // Unrelated processes, including a sibling worktree with a longer name.
  row(500, 1, 'node /Users/me/code/other/server.js'),
  row(501, 1, `node ${WT}0/node_modules/.bin/vite preview`),
]

describe('selectWorktreeLeftovers', () => {
  it('selects the escaped tree by worktree path, with descendants, and nothing else', () => {
    const picked = selectWorktreeLeftovers(table, [WT], { protectedRootPids: [300], serverPid: SERVER })
    expect(picked.map((p) => p.pid).sort()).toEqual([202, 203])
    expect(picked.every((p) => p.worktreePath === WT)).toBe(true)
  })

  it('takes a matching ancestor with its whole subtree', () => {
    const rows = [...table, row(600, 1, `/bin/sh -c cd ${WT} && npx vite preview`), row(601, 600, 'npm exec vite preview'), row(602, 601, 'node vite preview')]
    const picked = selectWorktreeLeftovers(rows, [WT], { protectedRootPids: [300], serverPid: SERVER }).map((p) => p.pid)
    expect(picked).toEqual(expect.arrayContaining([600, 601, 602]))
    expect(picked).not.toContain(500)
  })

  it('never selects protected trees, the server, its ancestors or its git tooling', () => {
    const rows = [...table, row(700, SERVER, `node ${WT}/scripts/leftover.mjs`)]
    const picked = selectWorktreeLeftovers(rows, [WT], { protectedRootPids: [300], serverPid: SERVER }).map((p) => p.pid)
    expect(picked).toContain(700) // a non-tooling server child of the settled run is a leftover
    for (const pid of [1, 90, SERVER, 300, 301, 400, 500, 501]) expect(picked).not.toContain(pid)
  })

  it('stops descending at a protected process', () => {
    const rows = [row(SERVER, 1, 'server'), row(10, 1, `sh ${WT}/run.sh`), row(11, 10, 'node owned-by-terminal')]
    expect(selectWorktreeLeftovers(rows, [WT], { protectedRootPids: [11], serverPid: SERVER }).map((p) => p.pid)).toEqual([10])
  })

  it('matches Windows paths with either separator, case-insensitively', () => {
    const rows = [row(SERVER, 4, 'server'), row(20, 4, 'node C:\\Users\\Me\\.specrails\\Projects\\g\\worktrees\\r\\ticket-4\\node_modules\\vite\\bin\\vite.js preview')]
    expect(selectWorktreeLeftovers(rows, ['c:/users/me/.specrails/projects/g/worktrees/r/ticket-4'], { protectedRootPids: [], serverPid: SERVER, windows: true }).map((p) => p.pid)).toEqual([20])
  })

  it('returns each pid once across several worktrees', () => {
    const rows = [row(SERVER, 1, 'server'), row(30, 1, `node /a/b/wt-1/x /a/b/wt-2/y`)]
    expect(selectWorktreeLeftovers(rows, ['/a/b/wt-1', '/a/b/wt-2'], { protectedRootPids: [], serverPid: SERVER })).toHaveLength(1)
  })
})

describe('protectedPids', () => {
  it('includes init, the server chain and protected subtrees', () => {
    const kept = protectedPids(table, { protectedRootPids: [300], serverPid: SERVER })
    for (const pid of [0, 1, 90, SERVER, 300, 301, 400]) expect(kept.has(pid)).toBe(true)
    expect(kept.has(202)).toBe(false)
  })
})

describe('isReapableWorktreePath', () => {
  it('accepts a deep absolute worktree path', () => {
    expect(isReapableWorktreePath(WT, ['/Users/me', '/Users/me/code/game'])).toBe(true)
  })
  it('refuses relative, shallow, forbidden and ancestor-of-forbidden paths', () => {
    expect(isReapableWorktreePath('worktrees/ticket-4', [])).toBe(false)
    expect(isReapableWorktreePath('/Users/me', [])).toBe(false)
    expect(isReapableWorktreePath('/Users/me/code/game/', ['/Users/me/code/game'])).toBe(false)
    expect(isReapableWorktreePath('/Users/me/code', ['/Users/me/code/game'])).toBe(false)
  })
  it('compares Windows paths case-insensitively', () => {
    expect(isReapableWorktreePath('C:\\Users\\Me\\Code\\Game', ['c:/users/me/code/game'], { windows: true })).toBe(false)
    expect(isReapableWorktreePath('C:\\Users\\Me\\.specrails\\w\\t', ['c:/users/me/code/game'], { windows: true })).toBe(true)
  })
})

describe('commandHead', () => {
  it('flattens and truncates', () => {
    expect(commandHead('a\n  b')).toBe('a b')
    expect(commandHead('x'.repeat(200), 10)).toHaveLength(10)
  })
})
