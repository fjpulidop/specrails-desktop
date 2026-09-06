import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { createLoopExecutors } from './loop-executors'
import { spawnClaude, spawnGemini } from './util/cli-prompt'
import { __resetWindowsBinaryResolveCacheForTest } from './util/win-spawn'
import { startBackgroundProcess, getBackgroundProcess, getBackgroundProcessLogs, killOwnedBackgroundProcess } from './transient-children'

// Actual Windows cmd.exe/Node fixtures. These shims never import or invoke any
// installed AI provider; the isolated PATH contains only our harmless fixtures.
const directories: string[] = []
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'specrails Windows España ')); directories.push(dir)
  return dir
}
function output(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}
function installShim(dir: string, name: string, code: string) {
  const entry = path.join(dir, `${name}-fixture.cjs`)
  writeFileSync(entry, code)
  writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
  vi.stubEnv('PATH', dir)
  __resetWindowsBinaryResolveCacheForTest()
}
afterEach(() => {
  vi.unstubAllEnvs(); __resetWindowsBinaryResolveCacheForTest()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('native Windows execution (no model requests)', () => {
  it('executes a quoted Node path and quoted arguments in a spaced Unicode cwd through the actual loop shell', async () => {
    const dir = fixture(), entry = path.join(dir, 'read args.cjs')
    writeFileSync(entry, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))')
    const result = await createLoopExecutors({ env: { ...process.env } }).runShell({
      command: `"${process.execPath}" "${entry}" "España & spaces"`, cwd: dir,
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ cwd: dir, args: ['España & spaces'] })
  })

  it('preserves a large UTF-8 Gemini prompt and model arguments through a real cmd shim and stdin', async () => {
    const dir = fixture()
    installShim(dir, 'gemini', "const fs=require('node:fs');console.log(JSON.stringify({input:fs.readFileSync(0,'utf8'),args:process.argv.slice(2),cwd:process.cwd()}))")
    const prompt = 'España & "quoted"\n'.repeat(2000)
    const result = await output(spawnGemini(['-p', prompt, '--model', 'fixture', '--output-format', 'stream-json'], { cwd: dir }))
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ input: prompt, args: ['--model', 'fixture', '--output-format', 'stream-json'], cwd: dir })
  })

  it('preserves Claude system context and keeps stdin available for its first protocol frame through cmd', async () => {
    const dir = fixture()
    installShim(dir, 'claude', "const fs=require('node:fs');const a=process.argv.slice(2);console.log(JSON.stringify({system:fs.readFileSync(a[a.indexOf('--append-system-prompt-file')+1],'utf8'),input:fs.readFileSync(0,'utf8')}))")
    const child = spawnClaude(['-p', '--input-format', 'stream-json', '--append-system-prompt', 'Contexto\nEspaña'], { cwd: dir })
    expect(child.stdin!.writableEnded).toBe(false)
    const completed = output(child)
    const frame = JSON.stringify({ type: 'user', message: { role: 'user', content: 'implementa #1' } }) + '\n'
    child.stdin!.end(frame)
    const result = await completed
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ system: 'Contexto\nEspaña', input: frame })
  })

  it('retains immediate background failure output after identity admission, with no ghost running state', async () => {
    const dir = fixture(), entry = path.join(dir, 'fails.cjs')
    writeFileSync(entry, "process.stderr.write('fixture immediate failure\\n');process.exit(7)")
    const app = startBackgroundProcess(`"${process.execPath}" "${entry}"`, dir, 'windows-fixture', 'windows-project')
    expect(app.status).toBe('starting')
    try {
      await vi.waitFor(() => expect(getBackgroundProcess(app.pid, app.processId)?.status).toBe('failed'), { timeout: 15_000, interval: 100 })
      expect(getBackgroundProcess(app.pid, app.processId)?.exitCode).toBe(7)
      expect(getBackgroundProcessLogs(app.pid, { processId: app.processId })?.lines.some(line => line.line.includes('fixture immediate failure'))).toBe(true)
    } finally { killOwnedBackgroundProcess(app.pid, { projectId: app.projectId, chatId: app.chatId, processId: app.processId }) }
  }, 20_000)

  it('cancels before bootstrap identity admission without executing the command', async () => {
    const dir = fixture(), marker = path.join(dir, 'must-not-run.txt'), entry = path.join(dir, 'write.cjs')
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)
    const app = startBackgroundProcess(`"${process.execPath}" "${entry}"`, dir, 'windows-cancel', 'windows-project')
    expect(killOwnedBackgroundProcess(app.pid, { projectId: app.projectId, chatId: app.chatId, processId: app.processId })).toBe(true)
    await vi.waitFor(() => expect(getBackgroundProcess(app.pid, app.processId)?.status).toBe('killed'), { timeout: 10_000, interval: 100 })
    expect(() => readFileSync(marker)).toThrow()
  }, 15_000)
})
