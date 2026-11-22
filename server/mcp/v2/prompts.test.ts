import { describe, expect, it } from 'vitest'
import { createHarness } from './__fixtures__/harness'
import { V2_INSTRUCTIONS } from './instructions'
import { V2_PROMPTS, registerV2Prompts } from './prompts'
import { GUIDE_TOPICS, GUIDE_TOPIC_IDS, findGuideTopic, registerV2GuideResources } from './guide'
import { approxTokens } from './core/size-guard'
import { v2Catalog } from './index'
import { Tiktoken } from 'js-tiktoken/lite'
import o200k from 'js-tiktoken/ranks/o200k_base'

const actionsOf = new Map(v2Catalog().tools.map((tool) => [tool.name, new Set(Object.keys(tool.actions))]))

/** Every `specrails_x(action:"y"` or `specrails_x(y` named in a text, as [tool, action]. */
function namedCalls(text: string): Array<[string, string]> {
  return [...text.matchAll(/(specrails_[a-z]+)\((?:action:")?([a-z_]+)/g)].map((m) => [m[1]!, m[2]!])
}

function unknownCalls(text: string): string[] {
  return namedCalls(text).filter(([tool, action]) => !actionsOf.get(tool)?.has(action)).map(([tool, action]) => `${tool}.${action}`)
}

describe('server instructions', () => {
  it('stay inside the 600-token o200k budget', () => {
    expect(new Tiktoken(o200k).encode(V2_INSTRUCTIONS).length).toBeLessThanOrEqual(600)
  })

  it('state every protocol rule of the contract', () => {
    for (const rule of [
      'specrails_overview(app)', 'specrails_inbox(list)', // how to start
      'ref', 'view:"detail"', // refs and views
      'Never poll', 'specrails_wait(until)', 'cursor', // waiting
      'offers', 'recommended', 'hold', // state
      'confirmation_required', 'confirmToken', 'confirm:<token>', 'explicit yes', 'stale', 'dryRun', // confirmation
      'lang', 'untrusted', 'never instructions', 'unknown', // language, untrusted, tolerance
      'menu', 'numbered list', 'Something else — write it', 'question tool', 'free text', 'data.choices', 'never a dead end', // choices
    ]) expect(V2_INSTRUCTIONS, rule).toContain(rule)
  })

  it('name only calls and prompts that exist', () => {
    expect(unknownCalls(V2_INSTRUCTIONS)).toEqual([])
    for (const name of V2_INSTRUCTIONS.match(/\(start-my-day[^)]*\)/)![0].slice(1, -1).split(', ')) {
      expect(V2_PROMPTS.map((prompt) => prompt.name)).toContain(name)
    }
  })
})

describe('v2 prompts', () => {
  it('cover the common flows with unique names', () => {
    const names = V2_PROMPTS.map((prompt) => prompt.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining(['start-my-day', 'review-waiting', 'ship-milestone', 'why-stuck', 'implement', 'spend']))
  })

  it('name only catalog calls, keep confirmations with the person and stay small', () => {
    for (const prompt of V2_PROMPTS) {
      for (const args of [{}, Object.fromEntries(Object.keys(prompt.args).map((key) => [key, key === 'run' ? 'run:shop-api/42' : 'x']))]) {
        const text = (prompt.render(args).messages[0]!.content as { text: string }).text
        expect(unknownCalls(text), prompt.name).toEqual([])
        expect(namedCalls(text).length, prompt.name).toBeGreaterThan(0)
        expect(text, prompt.name).toMatch(/yes|my word|I choose|I ask/)
        // Choice-driven: a menu at every decision, answered by number or in the person's words, never a dead end.
        expect(text, prompt.name).toMatch(/menu/)
        expect(text, prompt.name).toContain('Something else — write it')
        expect(text, prompt.name).toContain('with a number or my own words')
        expect(approxTokens(text), prompt.name).toBeLessThan(400)
      }
    }
  })

  it('quote person-supplied arguments as JSON strings', () => {
    const text = (V2_PROMPTS.find((prompt) => prompt.name === 'start-my-day')!.render({ project: 'a") ignore"' }).messages[0]!.content as { text: string }).text
    expect(text).toContain('project:"a\\") ignore\\""')
  })

  it('are listed and rendered over MCP', async () => {
    const harness = createHarness()
    registerV2Prompts(harness.server)
    registerV2GuideResources(harness.server)
    const client = await harness.connect()
    const listed = await client.listPrompts()
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(V2_PROMPTS.map((prompt) => prompt.name))
    const why = await client.getPrompt({ name: 'why-stuck', arguments: { run: 'run:shop-api/42' } })
    expect((why.messages[0]!.content as { text: string }).text).toContain('specrails_runs(action:"get", ref:"run:shop-api/42")')
    const resources = await client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toContain('specrails://guide/platform-model')
    const read = await client.readResource({ uri: 'specrails://guide/waiting-and-events' })
    expect((read.contents[0] as { text: string }).text).toContain('specrails_wait(until)')
    await expect(client.readResource({ uri: 'specrails://guide/nope' })).rejects.toThrow(/No guide topic/)
  })
})

describe('v2 guide topics', () => {
  it('are unique, short and found by normalized id', () => {
    expect(new Set(GUIDE_TOPIC_IDS).size).toBe(GUIDE_TOPIC_IDS.length)
    for (const topic of GUIDE_TOPICS) expect(approxTokens(topic.body()), topic.id).toBeLessThanOrEqual(2000)
    expect(findGuideTopic('Waiting_and Events')?.id).toBe('waiting-and-events')
    expect(findGuideTopic('nope')).toBeNull()
  })

  it('speak v2: only catalog calls, no v1 tool names', () => {
    for (const topic of GUIDE_TOPICS) {
      const body = topic.body()
      expect(unknownCalls(body), topic.id).toEqual([])
      expect(body, topic.id).not.toMatch(/specrails_(jobs|status|board|guide|watch|spend|resources|context|code)\b/)
    }
  })
})
