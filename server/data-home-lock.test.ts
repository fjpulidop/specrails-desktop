import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataHomeLock, DataHomeInUseError, isLiveSpecrailsServer } from './data-home-lock'

const dirs: string[] = []
const tempDir = (): string => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-home-lock-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('acquireDataHomeLock', () => {
  it('refuses a second live server on the same data home and frees it on release', () => {
    const dir = tempDir()
    const release = acquireDataHomeLock(dir, 4200, { pid: 111, isLive: () => true })
    expect(() => acquireDataHomeLock(dir, 4300, { pid: 222, isLive: () => true })).toThrow(DataHomeInUseError)
    try { acquireDataHomeLock(dir, 4300, { pid: 222, isLive: () => true }) } catch (error) {
      expect((error as DataHomeInUseError).owner).toEqual({ pid: 111, port: 4200 })
    }
    release()
    expect(fs.existsSync(path.join(dir, 'server.lock'))).toBe(false)
    acquireDataHomeLock(dir, 4300, { pid: 222, isLive: () => true })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'server.lock'), 'utf8'))).toEqual({ pid: 222, port: 4300 })
  })

  it('takes over a lock left by a crashed server or a reused PID', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid: 333, port: 4200 }))
    acquireDataHomeLock(dir, 4300, { pid: 444, isLive: () => false })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'server.lock'), 'utf8')).pid).toBe(444)
    fs.writeFileSync(path.join(dir, 'server.lock'), 'not json')
    expect(() => acquireDataHomeLock(dir, 4300, { pid: 444, isLive: () => true })).not.toThrow()
  })

  it('never releases a lock another server took over', () => {
    const dir = tempDir()
    const release = acquireDataHomeLock(dir, 4200, { pid: 555, isLive: () => false })
    acquireDataHomeLock(dir, 4300, { pid: 666, isLive: () => false })
    release()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'server.lock'), 'utf8')).pid).toBe(666)
  })
})

describe.skipIf(process.platform === 'win32')('isLiveSpecrailsServer', () => {
  it('rejects dead PIDs and live processes that are not a Specrails server', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    try {
      expect(isLiveSpecrailsServer(child.pid!)).toBe(false)
    } finally {
      child.kill()
      await new Promise(resolve => child.once('exit', resolve))
    }
    expect(isLiveSpecrailsServer(child.pid!)).toBe(false)
  })

  it('recognizes a running Specrails server by its command line', async () => {
    const dir = tempDir()
    const fake = path.join(dir, 'server', 'index.js')
    fs.mkdirSync(path.dirname(fake), { recursive: true })
    fs.writeFileSync(fake, 'setTimeout(() => {}, 30000)')
    const child = spawn(process.execPath, [fake])
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(isLiveSpecrailsServer(child.pid!)).toBe(true)
    } finally {
      child.kill()
      await new Promise(resolve => child.once('exit', resolve))
    }
  })
})
