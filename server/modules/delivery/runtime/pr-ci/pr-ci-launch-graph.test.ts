import { describe, expect, it } from 'vitest'
import { initDesktopDb } from '../../../../desktop-db'
import { ensureBuiltinLoops } from '../../../loops/runtime/builtin-loops'
import { prCiGraph } from '../../../loops/runtime/loop-pr-ci-recipe'
import { getLoop, publishLoop, updateLoop } from '../../../loops/runtime/loops-store'
import { prCiLaunchGraph } from './pr-ci-admission-runtime'

const CAPS = { engineV2: 1, workflowDefinitions: 1, hostTasks: 1 }

describe('prCiLaunchGraph (a mission-origin Fix PR CI run)', () => {
  it('[spec:pr-ci-loop-editable/every-door-runs-the-published-loop] runs the code default until the built-in is edited, then its published graph', async () => {
    const db = initDesktopDb(':memory:')
    expect(prCiLaunchGraph(db, CAPS)).toEqual(prCiGraph(CAPS))
    await ensureBuiltinLoops(db, { loadCapabilities: async () => CAPS })
    expect(prCiLaunchGraph(db, CAPS)).toEqual(prCiGraph(CAPS))
    const row = getLoop(db, 'factory:pr-ci')!
    updateLoop(db, row.id, { graph: { ...row.graph, config: { ...row.graph.config, maxIterations: 20 } } })
    // A Draft edit never reaches runs: they keep the last published graph.
    expect(prCiLaunchGraph(db, CAPS).config.maxIterations).toBe(12)
    publishLoop(db, row.id)
    expect(prCiLaunchGraph(db, CAPS).config.maxIterations).toBe(20)
    db.close()
  })
})
