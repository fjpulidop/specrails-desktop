import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WINDOWS_BACKGROUND_BOOTSTRAP } from './background-windows-bootstrap'

describe('background admission bootstrap protocol with real harmless Node children', () => {
  it.each(['', '{"command":'])('does not execute without a complete admission frame: %s', async frame => {
    const child = spawn(process.execPath, ['-e', WINDOWS_BACKGROUND_BOOTSTRAP], { stdio: ['pipe', 'pipe', 'pipe'] })
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    child.stdin.end(frame)
    expect(await done).toBe(125)
  })

  it('executes an admitted command exactly once and preserves its failure/output in a Unicode path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'specrails bootstrap España '))
    const marker = path.join(dir, 'started'), entry = path.join(dir, 'fixture app.cjs')
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'once');process.stderr.write('fallo ñ\\n');process.exit(7)`)
    const child = spawn(process.execPath, ['-e', WINDOWS_BACKGROUND_BOOTSTRAP], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    try {
      expect(existsSync(marker)).toBe(false)
      const command = `"${process.execPath}" "${entry}"`
      child.stdin.end(JSON.stringify({ command }) + '\n')
      expect(await done).toBe(7)
      expect(stderr).toContain('fallo ñ')
      expect(existsSync(marker)).toBe(true)
    } finally { child.kill(); rmSync(dir, { recursive: true, force: true }) }
  })
})
