import { describe, expect, it } from 'vitest'
import {
  buildActionItems,
  buildAgentContextBlock,
  buildNoResultPaletteItems,
  buildReferenceItems,
  chipKey,
  detectAgentPaletteTrigger,
  filterPaletteItems,
  insertPaletteSelection,
  toContextReference,
  type AgentContextChip,
  type PaletteSourceState,
} from '../agent-context-palette'

const projects = [
  { id: 'p1', name: 'Home App', slug: 'home-app', path: '/repo/home', db_path: '', provider: 'claude', added_at: '', last_seen_at: '' },
  { id: 'p2', name: 'Billing API', slug: 'billing-api', path: '/repo/billing', db_path: '', provider: 'claude', added_at: '', last_seen_at: '' },
] as PaletteSourceState['projects']

const baseState: PaletteSourceState = {
  projects,
  conversations: [],
  activeConversation: null,
  pinnedProjectId: 'p1',
  activeProjectId: 'p2',
  tickets: [
    {
      id: 7,
      title: 'Checkout retry flow',
      description: '',
      status: 'in_progress',
      priority: 'high',
      labels: ['payments'],
      assignee: null,
      prerequisites: [],
      metadata: {},
      created_at: '',
      updated_at: '',
      created_by: 'test',
      source: 'manual',
    },
  ],
  jobs: [
    {
      id: 'job-abcdef123456',
      command: 'implement ticket 7',
      started_at: '',
      status: 'failed',
      total_cost_usd: 1.25,
    },
  ],
  chips: [],
}

describe('agent context palette', () => {
  it('detects @, #, and / triggers only at token boundaries', () => {
    expect(detectAgentPaletteTrigger('inspect @chec')?.mode).toBe('reference')
    expect(detectAgentPaletteTrigger('inspect #job')?.mode).toBe('trace')
    expect(detectAgentPaletteTrigger('/launch')?.mode).toBe('action')
    expect(detectAgentPaletteTrigger('email a@b')).toBeNull()
  })

  it('prioritizes current scoped references before global projects', () => {
    const items = buildReferenceItems(baseState)
    expect(items[0].title).toBe('@current')
    expect(filterPaletteItems(items, 'checkout')[0].title).toBe('Checkout retry flow')
    expect(filterPaletteItems(items, 'billing')[0].title).toBe('Billing API')
  })

  it('ranks actions from selected context', () => {
    const specChip = filterPaletteItems(buildReferenceItems(baseState), 'checkout')[0].chip!
    const actions = buildActionItems({ ...baseState, chips: [specChip] })
    expect(actions.slice(0, 4).map((item) => item.title)).toContain('Update spec')
    expect(actions.slice(0, 4).map((item) => item.title)).toContain('Launch rail')
  })

  it('inserts selected items and formats resolved context', () => {
    const chip: AgentContextChip = {
      kind: 'project',
      id: 'p1',
      label: 'Home App',
      token: '@Home App',
      projectId: 'p1',
      projectName: 'Home App',
    }
    const item = {
      id: 'project:p1',
      mode: 'reference' as const,
      title: 'Home App',
      group: 'Projects',
      icon: 'project' as const,
      chip,
    }
    const trigger = detectAgentPaletteTrigger('summarize @Ho')!
    const inserted = insertPaletteSelection('summarize @Ho', trigger, item)
    expect(inserted.text).toBe('summarize @Home App')
    expect(chipKey(chip)).toBe('project:p1')
    expect(buildAgentContextBlock([toContextReference(chip)])).toContain('kind=project id=p1 label="Home App"')
  })

  it('offers recovery actions when a query has no matches', () => {
    expect(buildNoResultPaletteItems('reference', 'unknown thing').map((item) => item.title)).toEqual([
      'Search all Specrails',
      'Create "unknown thing"',
      'Ask agent about "unknown thing"',
    ])
    expect(buildNoResultPaletteItems('trace', 'old-run').map((item) => item.title)).toContain('Include archived results')
  })
})
