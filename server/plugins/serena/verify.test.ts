import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { verifySerena } from './verify'
import './../../providers'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

let fakeChild: FakeChild
let projectPath: string

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-serena-'))
  fakeChild = new FakeChild()
  vi.mocked(spawn).mockReturnValue(fakeChild as never)
})
afterEach(() => {
  vi.clearAllMocks()
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('verifySerena', () => {
  it('reports ok when uv exits 0', async () => {
    const promise = verifySerena()
    fakeChild.stdout.emit('data', Buffer.from('uv 0.10.9\n'))
    fakeChild.emit('close', 0)
    const r = await promise
    expect(r.ok).toBe(true)
  })

  it('reports uv-non-zero-exit when exit code != 0', async () => {
    const promise = verifySerena()
    fakeChild.stderr.emit('data', Buffer.from('boom\n'))
    fakeChild.emit('close', 1)
    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/uv-non-zero-exit/)
  })

  it('requires the Serena registration in Kimi native project config', async () => {
    const promise = verifySerena({
      projectPath,
      projectId: 'pid',
      providerId: 'kimi',
    })
    fakeChild.emit('close', 0)
    const r = await promise
    expect(r).toMatchObject({ ok: false, reason: 'mcp-registration-missing' })
  })

  it('accepts Serena registered in .kimi-code/mcp.json', async () => {
    const config = path.join(projectPath, '.kimi-code', 'mcp.json')
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, JSON.stringify({
      mcpServers: { serena: { command: 'uvx' } },
    }))

    const promise = verifySerena({
      projectPath,
      projectId: 'pid',
      providerId: 'kimi',
    })
    fakeChild.emit('close', 0)
    const r = await promise
    expect(r.ok).toBe(true)
  })

  it('reports uv-not-on-path when ENOENT fires', async () => {
    const promise = verifySerena()
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
    fakeChild.emit('error', err)
    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('uv-not-on-path')
  })

  it('reports verify-timeout when child never emits close', async () => {
    vi.useFakeTimers()
    const promise = verifySerena()
    vi.advanceTimersByTime(2000)
    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verify-timeout')
    vi.useRealTimers()
  })
})
