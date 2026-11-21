import { describe, it, expect, afterEach } from 'vitest'
import { initDesktopDb } from '../desktop-db'
import { MobileEventBus } from '../mobile/mobile-event-bus'
import type { ProjectRegistry } from '../project-registry'
import { levelAllowsTier } from '../modules/missions/runtime/agent-tier'
import { buildOperatorSystemPrompt } from '../modules/missions/runtime/agent-operator-prompt'
import { GUIDE_TOPICS, GUIDE_TOPIC_IDS, findGuideTopic, fullGuide, guideIndex, normalizeGuideTopicId } from './guide'
import { buildToolSpecs } from './tools/catalog'
import { errorEnvelope } from './tools/envelope'
import type { McpToolContext } from './tools/types'

const guideTool = () => {
  const spec = buildToolSpecs().find((entry) => entry.name === 'specrails_guide')
  if (!spec) throw new Error('specrails_guide missing')
  return spec
}
const ctx = (): McpToolContext => ({
  registry: { listContexts: () => [] } as unknown as ProjectRegistry,
  desktopDb: initDesktopDb(':memory:'), broadcast: () => {}, eventBus: new MobileEventBus(), desktopPort: 4200,
})

afterEach(() => { delete process.env.SPECRAILS_MISSION_RAIL_CARDS })

describe('specrails_guide topics', () => {
  it('returns the index without a topic: one line per topic', async () => {
    const index = String(await guideTool().handler(ctx(), {}))
    expect(index).toBe(guideIndex())
    for (const entry of GUIDE_TOPICS) expect(index).toContain(`- \`${entry.id}\` — ${entry.when}`)
  })

  it('resolves every index entry to its topic body', async () => {
    for (const id of GUIDE_TOPIC_IDS) {
      const body = String(await guideTool().handler(ctx(), { topic: id }))
      expect(body).toBe(findGuideTopic(id)?.body())
      expect(body.startsWith('# ')).toBe(true)
      expect(body.length).toBeGreaterThan(200)
    }
  })

  it('has unique, normalised ids and one-line "when" descriptions', () => {
    expect(new Set(GUIDE_TOPIC_IDS).size).toBe(GUIDE_TOPIC_IDS.length)
    for (const entry of GUIDE_TOPICS) {
      expect(normalizeGuideTopicId(entry.id)).toBe(entry.id)
      expect(entry.when).not.toContain('\n')
    }
    expect(normalizeGuideTopicId(' Rails_and Launch ')).toBe('rails-and-launch')
  })

  it('accepts a loosely spelled id', async () => {
    expect(String(await guideTool().handler(ctx(), { topic: 'Rails_And_Launch' }))).toBe(findGuideTopic('rails-and-launch')?.body())
  })

  it('rejects an unknown topic with invalid_input and the valid choices', async () => {
    let thrown: unknown
    try { await guideTool().handler(ctx(), { topic: 'nope' }) } catch (err) { thrown = err }
    const envelope = errorEnvelope(thrown, 'specrails_guide', null)
    expect(envelope.error.code).toBe('invalid_input')
    expect(envelope.error.message).toContain('rails-and-launch')
    expect(envelope.error.choices).toEqual([...GUIDE_TOPIC_IDS])
  })

  it('is a read tool, so every mission permission level can call it', () => {
    expect(guideTool().tier).toBe('read')
    for (const level of [0, 1, 2, 3] as const) expect(levelAllowsTier(level, 'read')).toBe(true)
  })

  it('declares an optional topic argument', () => {
    expect(Object.keys(guideTool().inputSchema)).toEqual(['topic'])
    expect(guideTool().inputSchema.topic.safeParse(undefined).success).toBe(true)
  })

  it('serves the rail-launch card protocol only while the feature is on', () => {
    expect(findGuideTopic('rail-launch-cards')?.body()).toContain('```rail-launch')
    process.env.SPECRAILS_MISSION_RAIL_CARDS = 'false'
    expect(findGuideTopic('rail-launch-cards')?.body()).not.toContain('```rail-launch')
  })

  it('the full guide (specrails://guide) is the index plus every topic', () => {
    const full = fullGuide()
    expect(full.startsWith(guideIndex())).toBe(true)
    for (const entry of GUIDE_TOPICS) expect(full).toContain(entry.body())
  })

  it('keeps the MCP guide sections it replaced', () => {
    const full = fullGuide()
    for (const heading of ['## The object model (MCP guide)', '## Start here, and how results look', '## Establish project context before acting', '## Creating specs — three paths, one decision rule', '## Running the pipeline (MCP guide)', '## Async results (IMPORTANT)', '## Live mission follow-ups (embedded agent only)', '## Permissions — two regimes', '## Providers & capability-gated surfaces', '## Operating discipline', '## Resources and prompts']) {
      expect(full).toContain(heading)
    }
    for (const bullet of ['**Specs read vs write**', '**Epics / SMASH**', '**Attachments**', '**Jira**', '**Code explorer**', '**Why a job failed**', '**Run failures & recovery**', '**Scoped repair**', '**Execution evidence**', '**Analytics**', '**Plugins**', '**Profiles**', '**Setup**', '**Support**', '**Loops lifecycle**', '**Addenda**']) {
      expect(full).toContain(bullet)
    }
  })

  it('every specrails_* tool the operator core names exists in the catalog', () => {
    const names = new Set(buildToolSpecs().map((spec) => spec.name))
    const named = [...buildOperatorSystemPrompt().replace(/mcp_specrails_/g, '').matchAll(/specrails_[a-z_]+/g)].map((match) => match[0])
    expect(named.length).toBeGreaterThan(10)
    expect(named.filter((name) => !names.has(name))).toEqual([])
  })

  it('is byte-stable', () => {
    expect(guideIndex()).toBe(guideIndex())
    expect(fullGuide()).toBe(fullGuide())
    expect(fullGuide()).not.toMatch(/\$\{|undefined|\[object /)
  })
})
