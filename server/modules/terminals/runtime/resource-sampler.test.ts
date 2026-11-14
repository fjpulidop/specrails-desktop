import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessTableReader, createWindowsProcessTableReader, readPosixProcessTable, walkDiskUsage } from './resource-sampler'

const table = (cpuTicks: number) => JSON.stringify([
  { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: 2048, KernelModeTime: 0, UserModeTime: cpuTicks, CommandLine: 'node a.js' },
])

describe('Windows process table reader', () => {
  it('derives cpu from the previous sample and shares scans inside the ttl', async () => {
    let clock = 1000
    const run = vi.fn(async () => table(clock === 1000 ? 0 : 5_000_000))
    const read = createWindowsProcessTableReader(run, () => clock, 500)

    const first = await read()
    expect(first?.[0]).toMatchObject({ pid: 10, ppid: 1, rssBytes: 2048, cpuPercent: 0 })
    clock = 1200
    await read()
    expect(run).toHaveBeenCalledTimes(1) // within ttl: cached

    clock = 2000
    const second = await read()
    expect(run).toHaveBeenCalledTimes(2)
    expect(second?.[0].cpuPercent).toBe(50) // 500 ms of cpu over 1000 ms
  })

  it('joins an in-flight scan instead of starting another', async () => {
    let release: (value: string) => void = () => {}
    const run = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const read = createWindowsProcessTableReader(run, () => 1, 0)
    const a = read(); const b = read()
    release(table(0))
    expect(await a).toEqual(await b)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('returns null when PowerShell fails or returns nothing, and recovers', async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('spawn powershell.exe ENOENT')).mockResolvedValueOnce('').mockResolvedValue(table(0))
    const read = createWindowsProcessTableReader(run, () => 1, 0)
    expect(await read()).toBeNull()
    expect(await read()).toBeNull()
    expect((await read())?.length).toBe(1)
  })

  it('picks the reader by platform', () => {
    expect(createProcessTableReader('darwin')).toBe(readPosixProcessTable)
    expect(createProcessTableReader('linux')).toBe(readPosixProcessTable)
    expect(createProcessTableReader('win32')).not.toBe(readPosixProcessTable)
  })
})

describe('walkDiskUsage', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('sums regular files recursively without following symlinks', async () => {
    dir = await mkdtemp(join(tmpdir(), 'walk-disk-'))
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'one.txt'), Buffer.alloc(100))
    await writeFile(join(dir, 'a', 'two.txt'), Buffer.alloc(250))
    await writeFile(join(dir, 'a', 'b', 'three.txt'), Buffer.alloc(50))
    await symlink(join(dir, 'a'), join(dir, 'link')).catch(() => {})
    expect(await walkDiskUsage(dir)).toBe(400)
  })

  it('rejects when the root cannot be read', async () => {
    await expect(walkDiskUsage(join(tmpdir(), 'definitely-missing-dir-xyz'))).rejects.toThrow()
  })
})
