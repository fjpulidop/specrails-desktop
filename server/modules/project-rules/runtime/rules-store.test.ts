import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readProjectRules, readProjectRulesInventory, RULES_INVENTORY_ARGS, runRulesInventory } from './rules-store'

vi.mock('../../../core-runtime', () => ({ resolveCoreRuntime: vi.fn(() => ({ cli: '/core/dist/installer/cli.js', root: '/core', version: '6.7.0', source: 'override' })) }))
import { resolveCoreRuntime } from '../../../core-runtime'

describe('rules store', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-store-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const project = () => ({ slug: `rules-store-${process.pid}`, path: dir })

  it('reads the repository rules file and reports oversized or foreign files', () => {
    expect(readProjectRules(project())).toEqual({ state: 'missing' })
    fs.mkdirSync(path.join(dir, '.specrails'))
    fs.writeFileSync(path.join(dir, '.specrails', 'rules.json'), JSON.stringify({ hello: true }))
    expect(readProjectRules(project())).toMatchObject({ state: 'invalid', message: expect.stringContaining('does not match') })
    fs.writeFileSync(path.join(dir, '.specrails', 'rules.json'), JSON.stringify({ gates: [{ id: 'g', kind: 'lint', command: 'npm run lint' }], rules: [] }))
    expect(readProjectRulesInventory(project())?.gates).toHaveLength(1)
    fs.writeFileSync(path.join(dir, '.specrails', 'rules.json'), 'x'.repeat(2 * 1024 * 1024 + 1))
    expect(readProjectRules(project())).toMatchObject({ state: 'invalid', message: 'rules.json is larger than 2 MB' })
  })

  it('runs the Core inventory verb with the project root and reports an unavailable Core', async () => {
    const runner = vi.fn(async () => ({ ok: true, exitCode: 0, output: '' }))
    await runRulesInventory(project(), runner)
    expect(runner).toHaveBeenCalledWith(expect.any(String), ['/core/dist/installer/cli.js', ...RULES_INVENTORY_ARGS, '--root', dir], expect.objectContaining({ cwd: dir }))
    vi.mocked(resolveCoreRuntime).mockReturnValueOnce(null)
    expect(await runRulesInventory(project(), runner)).toEqual({ ok: false, exitCode: null, output: 'Core is unavailable' })
    vi.mocked(resolveCoreRuntime).mockImplementationOnce(() => { throw new Error('older than active framework') })
    expect(await runRulesInventory(project(), runner)).toMatchObject({ ok: false, output: 'older than active framework' })
  })

  it('surfaces the real process failure through the default runner', async () => {
    const result = await runRulesInventory(project())
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('Cannot find module')
  })
})
