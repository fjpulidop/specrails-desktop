import { describe, expect, it } from 'vitest'
import {
  attributeListeners, blockRange, candidateBlocks, detectPortConflict, isRunWorktreePath, parseLsofCwds, parseLsofListeners,
  parseProcNetTcp, runPortArea, runPortEnv, type RunPortLease,
} from './run-ports'
import type { ProcessSample } from './mission-resources'

const area = runPortArea({})
const lease = (worktreePath: string, block: number): RunPortLease => ({ worktreePath, block, ...blockRange(area, block), leasedAt: 0 })

describe('run port area', () => {
  it('defaults below every OS ephemeral range and honours overrides', () => {
    expect(area).toEqual({ base: 30100, blockSize: 10, blocks: 200 })
    expect(blockRange(area, 199).end).toBe(32099)
    expect(runPortArea({ SPECRAILS_RUN_PORT_BASE: '40000', SPECRAILS_RUN_PORT_BLOCK_SIZE: '5', SPECRAILS_RUN_PORT_BLOCKS: '3' })).toEqual({ base: 40000, blockSize: 5, blocks: 3 })
    expect(runPortArea({ SPECRAILS_RUN_PORT_BASE: '80', SPECRAILS_RUN_PORT_BLOCKS: 'x' })).toEqual(area)
    // Never past 65535.
    expect(runPortArea({ SPECRAILS_RUN_PORT_BASE: '65000', SPECRAILS_RUN_PORT_BLOCKS: '1000' }).blocks).toBe(53)
  })

  it('prefers a stable home block per worktree and skips taken ones', () => {
    const first = candidateBlocks(area, '/h/.specrails/projects/p/worktrees/r1/ticket-1', new Set())
    expect(first).toHaveLength(200)
    expect(candidateBlocks(area, '/h/.specrails/projects/p/worktrees/r1/ticket-1', new Set())[0]).toBe(first[0])
    const next = candidateBlocks(area, '/h/.specrails/projects/p/worktrees/r1/ticket-1', new Set([first[0]]))
    expect(next[0]).toBe((first[0] + 1) % 200)
  })

  it('exports PORT only when the environment does not pin one', () => {
    const l = lease('/w', 0)
    expect(runPortEnv(l, {})).toEqual({ PORT: '30100', SPECRAILS_RUN_PORT: '30100', SPECRAILS_RUN_PORT_RANGE_START: '30100', SPECRAILS_RUN_PORT_RANGE_END: '30109' })
    expect(runPortEnv(l, { PORT: '8080' })).not.toHaveProperty('PORT')
    expect(runPortEnv(null, {})).toEqual({})
  })

  it('recognises only mounts under the run worktree root', () => {
    const root = '/Users/a/.specrails/projects'
    expect(isRunWorktreePath(`${root}/app/worktrees/run1/ticket-3`, root)).toBe(true)
    expect(isRunWorktreePath(`${root}/app/worktrees/repo-2/run1/ticket-3`, root)).toBe(true)
    expect(isRunWorktreePath(`${root}/app/worktrees/run1`, root)).toBe(false)
    expect(isRunWorktreePath(`${root}/app/workspace/x/y`, root)).toBe(false)
    expect(isRunWorktreePath('/Users/a/code/app', root)).toBe(false)
    expect(isRunWorktreePath('C:\\Users\\A\\.specrails\\projects\\app\\worktrees\\r\\t', 'c:/users/a/.specrails/projects', true)).toBe(true)
  })
})

describe('listener tables', () => {
  it('parses lsof field output', () => {
    const out = 'p501\ncnode\nf23\nn*:30100\nf24\nn[::1]:30101\np77\ncPython\nf3\nn127.0.0.1:8000\nnbogus\n'
    expect(parseLsofListeners(out)).toEqual([
      { port: 30100, host: '*', pid: 501, command: 'node', cwd: null },
      { port: 30101, host: '[::1]', pid: 501, command: 'node', cwd: null },
      { port: 8000, host: '127.0.0.1', pid: 77, command: 'Python', cwd: null },
    ])
    expect(parseLsofCwds('p501\nfcwd\nn/tmp/w one\np77\nfcwd\nn/\n')).toEqual(new Map([[501, '/tmp/w one'], [77, '/']]))
  })

  it('parses LISTEN rows of /proc/net/tcp and tcp6', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:7594 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4243 1 0000000000000000 100 0 0 10 0',
      '   2: 0100007F:1F41 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4244 1 0000000000000000 100 0 0 10 0',
    ].join('\n')
    expect(parseProcNetTcp(tcp, 4)).toEqual([{ port: 30100, host: '*', inode: '4242' }, { port: 8000, host: '127.0.0.1', inode: '4243' }])
    const tcp6 = 'header\n   0: 00000000000000000000000001000000:7595 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99 1'
    expect(parseProcNetTcp(tcp6, 6)).toEqual([{ port: 30101, host: '::1', inode: '99' }])
  })
})

describe('attributeListeners', () => {
  const wt1 = '/h/.specrails/projects/p/worktrees/r1/ticket-4'
  const wt2 = '/h/.specrails/projects/p/worktrees/r2/ticket-40'
  const owners = [{ worktreePath: wt1, lease: lease(wt1, 0) }, { worktreePath: wt2, lease: lease(wt2, 1) }]
  const table: ProcessSample[] = [
    { pid: 10, ppid: 1, cpuPercent: 0, rssBytes: 0, command: `node ${wt2}/node_modules/.bin/vite` },
    { pid: 11, ppid: 10, cpuPercent: 0, rssBytes: 0, command: 'esbuild --service' },
  ]

  it('prefers cwd, then a command line of the process or an ancestor, and never confuses ticket-4 with ticket-40', () => {
    const result = attributeListeners([
      { port: 3000, host: '*', pid: 5, command: 'node', cwd: `${wt1}/client` },
      { port: 30115, host: '*', pid: 11, command: 'esbuild', cwd: '/' },
      { port: 5432, host: '*', pid: 99, command: 'postgres', cwd: '/var' },
    ], table, owners)
    expect(result.map((r) => [r.port, r.owner?.worktreePath, r.confidence, r.squatting])).toEqual([
      [3000, wt1, 'cwd', false],
      [30115, wt2, 'command', false],
    ])
  })

  it('flags a foreign process listening inside a run block', () => {
    const [squatter] = attributeListeners([{ port: 30102, host: '*', pid: 99, command: 'python', cwd: '/elsewhere' }], table, owners)
    expect(squatter).toMatchObject({ port: 30102, confidence: 'none', squatting: true, owner: { worktreePath: wt1 } })
    const [other] = attributeListeners([{ port: 30103, host: '*', pid: 11, command: 'esbuild', cwd: '/' }], table, owners)
    expect(other).toMatchObject({ squatting: true, confidence: 'command', owner: { worktreePath: wt2 } })
  })
})

describe('detectPortConflict', () => {
  it.each([
    ['Error: listen EADDRINUSE: address already in use :::3000', 3000],
    ['Error: listen EADDRINUSE: address already in use 127.0.0.1:5173', 5173],
    ['OSError: [Errno 48] Address already in use', null],
    ['listen tcp :8080: bind: address already in use', 8080],
    ['Port 3000 is in use, trying another one...', 3000],
    ['Error: http://localhost:4173 is already used, make sure that your server is not already running. Port 4173 is already in use', 4173],
  ])('%s', (line, port) => {
    expect(detectPortConflict(line)).toMatchObject({ port })
  })

  it('stays silent on ordinary output', () => {
    expect(detectPortConflict('✓ 42 tests passed')).toBeNull()
    expect(detectPortConflict('the feature is in use by customers')).toBeNull()
    expect(detectPortConflict('')).toBeNull()
  })
})
