import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  blueprintJsonPath,
  readBlueprint,
  renderBlueprintMarkdown,
  writeBlueprintPair,
} from './blueprint-render'
import { Blueprint } from './blueprint-types'

function fullBlueprint(): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'Recipes from your pantry', audience: 'home cooks' },
    coreFlow: 'photo → recipes → cook',
    platform: 'web',
    stack: { language: 'TypeScript', framework: 'Next.js', db: 'SQLite', notes: 'edge-ready' },
    assumptions: ['no auth in M1', 'English only'],
    milestones: [
      { id: 'm1', title: 'Walking skeleton', goal: 'end-to-end', status: 'committed', plannedSpecs: [], ticketIds: [1, 2] },
      { id: 'm2', title: 'Accounts', goal: 'auth', status: 'planned', plannedSpecs: ['signup', 'login'] },
    ],
    specsComplete: true,
    m1Specs: [
      {
        kind: 'scaffold',
        title: 'Scaffold',
        shortSummary: 'Create the executable application skeleton.',
        description: 'init',
        acceptanceCriteria: ['The application starts locally.'],
        priority: 'critical',
        labels: ['M1'],
      },
      {
        kind: 'feature',
        title: 'Pantry photo upload',
        shortSummary: 'Let cooks upload a pantry photo.',
        description: 'upload',
        acceptanceCriteria: ['A supported photo can be selected.'],
        priority: 'high',
        labels: ['M1'],
        dependsOnIndex: 0,
      },
    ],
  }
}

describe('renderBlueprintMarkdown', () => {
  it('is byte-deterministic for identical input', () => {
    expect(renderBlueprintMarkdown(fullBlueprint())).toBe(renderBlueprintMarkdown(fullBlueprint()))
  })

  it('renders all sections for a full blueprint', () => {
    const md = renderBlueprintMarkdown(fullBlueprint())
    expect(md).toContain('# Blueprint — Recipely')
    expect(md).toContain('- **Pitch**: Recipes from your pantry')
    expect(md).toContain('- **Notes**: edge-ready')
    expect(md).toContain('### M1 — Walking skeleton')
    expect(md).toContain('- **Status**: committed')
    expect(md).toContain('  - signup')
    expect(md).toContain('1. **Scaffold** (M1)')
    expect(md).toContain('Do not edit')
  })

  it('renders N/A placeholders and omits empty sections', () => {
    const md = renderBlueprintMarkdown({
      blueprintVersion: 1,
      product: { name: '', pitch: '', audience: '' },
      coreFlow: '',
      platform: '',
      stack: { language: '', framework: '', db: '' },
      assumptions: [],
      milestones: [],
      specsComplete: false,
      m1Specs: [],
    })
    expect(md).toContain('# Blueprint — Untitled project')
    expect(md).toContain('- **Pitch**: _N/A_')
    expect(md).not.toContain('## Assumptions')
    expect(md).not.toContain('## Milestones')
    expect(md).not.toContain('## Milestone 1 specs')
  })
})

describe('writeBlueprintPair / readBlueprint', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-render-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes both files and round-trips every rich blueprint field', () => {
    const blueprint = fullBlueprint()
    writeBlueprintPair(dir, blueprint)
    expect(fs.existsSync(path.join(dir, '.specrails', 'blueprint.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.specrails', 'blueprint.md'))).toBe(true)
    expect(readBlueprint(dir)).toEqual(blueprint)
  })

  it('normalizes legacy version-1 blueprints with rich-spec defaults', () => {
    const legacy = {
      blueprintVersion: 1,
      product: { name: 'Legacy', pitch: 'Existing idea', audience: 'teams' },
      coreFlow: 'open → act',
      platform: 'web',
      stack: { language: 'TypeScript', framework: 'React', db: 'SQLite' },
      assumptions: ['legacy snapshot'],
      milestones: [
        { id: 'm1', title: 'First milestone', goal: 'ship', status: 'committed', plannedSpecs: [] },
      ],
      m1Specs: [
        { title: 'Legacy scaffold', description: 'Older description', labels: ['M1'] },
      ],
    }
    fs.mkdirSync(path.join(dir, '.specrails'), { recursive: true })
    fs.writeFileSync(blueprintJsonPath(dir), JSON.stringify(legacy))

    const back = readBlueprint(dir)
    expect(back).not.toBeNull()
    expect(back?.specsComplete).toBe(false)
    expect(back?.m1Specs[0]).toEqual({
      kind: 'feature',
      title: 'Legacy scaffold',
      shortSummary: '',
      description: 'Older description',
      acceptanceCriteria: [],
      priority: 'medium',
      labels: ['M1'],
    })
  })

  it('re-render on every write: md tracks json', () => {
    const bp = fullBlueprint()
    writeBlueprintPair(dir, bp)
    bp.milestones[1].status = 'committed'
    writeBlueprintPair(dir, bp)
    const md = fs.readFileSync(path.join(dir, '.specrails', 'blueprint.md'), 'utf-8')
    expect(md).toContain('### M2 — Accounts')
    expect(md.match(/- \*\*Status\*\*: committed/g)).toHaveLength(2)
  })

  it('identical writes produce identical md bytes', () => {
    writeBlueprintPair(dir, fullBlueprint())
    const first = fs.readFileSync(path.join(dir, '.specrails', 'blueprint.md'))
    writeBlueprintPair(dir, fullBlueprint())
    const second = fs.readFileSync(path.join(dir, '.specrails', 'blueprint.md'))
    expect(first.equals(second)).toBe(true)
  })

  it('readBlueprint returns null when absent or corrupt', () => {
    expect(readBlueprint(dir)).toBeNull()
    fs.mkdirSync(path.join(dir, '.specrails'), { recursive: true })
    fs.writeFileSync(blueprintJsonPath(dir), '{ torn')
    expect(readBlueprint(dir)).toBeNull()
    fs.writeFileSync(blueprintJsonPath(dir), 'null')
    expect(readBlueprint(dir)).toBeNull()
    fs.writeFileSync(blueprintJsonPath(dir), JSON.stringify({ nope: true }))
    expect(readBlueprint(dir)).toBeNull()
  })
})
