import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { NO_PHASE3_CAPABILITIES } from '../../agent-runtime/runtime/core-capabilities'
import { phase3HarvestOptions, runBaselineCost } from './phase3-harvest'

describe('phase-3 harvest options', () => {
  let dir: string
  let db: DbInstance
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-'))
    db = initDb(':memory:')
    fs.mkdirSync(path.join(dir, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.specrails', 'rules.json'), JSON.stringify({
      gates: [], rules: [{ text: 'Copy reviewed by design', source: 'AGENTS.md:3', status: 'humanOnly' }, { text: 'Use getApiBase', status: 'automatable' }],
    }))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const project = () => ({ slug: `phase3-${process.pid}`, path: dir })

  it('is empty without capabilities', async () => {
    const options = await phase3HarvestOptions({ db, project: project(), capabilities: async () => NO_PHASE3_CAPABILITIES })
    expect(options).toEqual({ specTrace: false, baselineOnTouch: false, humanRules: null })
  })

  it('freezes human-only rules and wires the baseline cost lookup when announced', async () => {
    const options = await phase3HarvestOptions({ db, project: project(), capabilities: async () => ({ architectClarifications: true, specTrace: true, baselineOnTouch: true, rulesInventory: true }) })
    expect(options.specTrace).toBe(true)
    expect(options.humanRules).toEqual([{ text: 'Copy reviewed by design', source: 'AGENTS.md:3' }])
    expect(options.baselineCost?.('unknown-run')).toBeNull()
    expect(runBaselineCost(db, 'unknown-run')).toBeNull()
  })
})
