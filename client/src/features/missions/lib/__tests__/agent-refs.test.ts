import { describe, it, expect } from 'vitest'
import {
  agentRefHref,
  parseAgentRefHref,
  computeJobContextUuids,
  splitAgentRefs,
  remarkAgentRefs,
  type AgentRefSegment,
} from '../agent-refs'

const UUID = '85d6ab14-1111-4222-8333-444455556666'
const UUID2 = '38bcfb0a-2222-4333-9444-555566667777'

const noCtx = new Set<string>()
const ctx = (...ids: string[]) => new Set(ids.map((s) => s.toLowerCase()))

function refs(segments: AgentRefSegment[]): AgentRefSegment[] {
  return segments.filter((s) => s.kind !== 'text')
}

describe('agentRefHref / parseAgentRefHref codec', () => {
  it('round-trips a ticket ref', () => {
    const href = agentRefHref({ kind: 'ticket', ticketId: 42 })
    expect(href).toBe('#agentref:ticket:42')
    expect(parseAgentRefHref(href)).toEqual({ kind: 'ticket', ticketId: 42 })
  })

  it('round-trips a pull request ref with and without URL', () => {
    expect(parseAgentRefHref(agentRefHref({ kind: 'pull-request', prNumber: 2147 }))).toEqual({
      kind: 'pull-request',
      prNumber: 2147,
    })
    expect(parseAgentRefHref(agentRefHref({ kind: 'pull-request', prNumber: 2147, prUrl: 'https://github.com/org/repo/pull/2147' }))).toEqual({
      kind: 'pull-request',
      prNumber: 2147,
      prUrl: 'https://github.com/org/repo/pull/2147',
    })
  })

  it('round-trips a job ref', () => {
    const href = agentRefHref({ kind: 'job', jobId: UUID })
    expect(parseAgentRefHref(href)).toEqual({ kind: 'job', jobId: UUID })
  })

  it('rejects foreign hrefs and malformed payloads', () => {
    expect(parseAgentRefHref('https://example.com')).toBeNull()
    expect(parseAgentRefHref('#anchor')).toBeNull()
    expect(parseAgentRefHref(undefined)).toBeNull()
    expect(parseAgentRefHref(null)).toBeNull()
    expect(parseAgentRefHref('#agentref:ticket:abc')).toBeNull()
    expect(parseAgentRefHref('#agentref:ticket:0')).toBeNull()
    expect(parseAgentRefHref('#agentref:pr:abc')).toBeNull()
    expect(parseAgentRefHref('#agentref:pr:0')).toBeNull()
    expect(parseAgentRefHref('#agentref:job:not-a-uuid')).toBeNull()
    expect(parseAgentRefHref('#agentref:other:1')).toBeNull()
  })
})

describe('computeJobContextUuids', () => {
  it('collects uuids on lines with EN context words', () => {
    expect(computeJobContextUuids(`Job launched: ${UUID}`)).toEqual(ctx(UUID))
    expect(computeJobContextUuids(`loop run ${UUID}`)).toEqual(ctx(UUID))
    expect(computeJobContextUuids(`run id ${UUID}`)).toEqual(ctx(UUID))
  })

  it('collects uuids on lines with ES context words', () => {
    expect(computeJobContextUuids(`Job lanzado: ${UUID}`)).toEqual(ctx(UUID))
    expect(computeJobContextUuids(`la ejecución ${UUID} terminó`)).toEqual(ctx(UUID))
    expect(computeJobContextUuids(`trabajo ${UUID}`)).toEqual(ctx(UUID))
  })

  it('ignores uuids without a context word on the SAME line', () => {
    expect(computeJobContextUuids(`conversation id: ${UUID}`).size).toBe(0)
    expect(computeJobContextUuids(`the job is:\n${UUID}`).size).toBe(0)
  })

  it('is case-insensitive and lowercases collected ids', () => {
    const upper = UUID.toUpperCase()
    expect(computeJobContextUuids(`JOB: ${upper}`)).toEqual(ctx(UUID))
  })
})

describe('splitAgentRefs — ticket pattern matrix', () => {
  it('matches a bare #N', () => {
    expect(splitAgentRefs('#3', noCtx)).toEqual([{ kind: 'ticket', ticketId: 3, label: '#3' }])
  })

  it('matches "ticket #N" shapes with surrounding text', () => {
    const segs = splitAgentRefs('done: ticket #12 moved', noCtx)
    expect(segs).toEqual([
      { kind: 'text', text: 'done: ticket ' },
      { kind: 'ticket', ticketId: 12, label: '#12' },
      { kind: 'text', text: ' moved' },
    ])
  })

  it('matches up to 6 digits, not 7', () => {
    expect(refs(splitAgentRefs('#123456', noCtx))).toHaveLength(1)
    expect(refs(splitAgentRefs('#1234567', noCtx))).toHaveLength(0)
  })

  it('is word-bounded: no match mid-word, after # or &, or before word chars', () => {
    expect(refs(splitAgentRefs('a#3', noCtx))).toHaveLength(0)
    expect(refs(splitAgentRefs('&#39;', noCtx))).toHaveLength(0)
    expect(refs(splitAgentRefs('##3', noCtx))).toHaveLength(0)
    expect(refs(splitAgentRefs('#3abc', noCtx))).toHaveLength(0)
    expect(refs(splitAgentRefs('#123-fix', noCtx))).toHaveLength(0)
  })

  it('captures a same-line em-dash title tail into the label', () => {
    expect(splitAgentRefs('#3 — Add dark mode', noCtx)).toEqual([
      { kind: 'ticket', ticketId: 3, label: '#3 — Add dark mode' },
    ])
  })

  it('keeps trailing punctuation out of the label', () => {
    const segs = splitAgentRefs('closed #3 — Add dark mode.', noCtx)
    expect(segs).toEqual([
      { kind: 'text', text: 'closed ' },
      { kind: 'ticket', ticketId: 3, label: '#3 — Add dark mode' },
      { kind: 'text', text: '.' },
    ])
  })

  it('a second ref on the line is never swallowed by a title tail', () => {
    const segs = refs(splitAgentRefs('#3 — Add dark mode and #4 — Fix nav', noCtx))
    expect(segs).toEqual([
      { kind: 'ticket', ticketId: 3, label: '#3 — Add dark mode and' },
      { kind: 'ticket', ticketId: 4, label: '#4 — Fix nav' },
    ])
  })

  it('does not treat a bare hyphen as a title separator', () => {
    const segs = splitAgentRefs('#3 - 5 files changed', noCtx)
    expect(segs[0]).toEqual({ kind: 'ticket', ticketId: 3, label: '#3' })
  })

  it('title tail never crosses a newline', () => {
    const segs = splitAgentRefs('#3\n— not a title', noCtx)
    expect(segs[0]).toEqual({ kind: 'ticket', ticketId: 3, label: '#3' })
  })
})

describe('splitAgentRefs — pull request refs', () => {
  it('treats PR #N as a pull-request chip, not a ticket chip', () => {
    expect(refs(splitAgentRefs('review follow-ups from PR #2147', noCtx))).toEqual([
      { kind: 'pull-request', prNumber: 2147, label: 'PR #2147' },
    ])
  })

  it('treats pull request #N as a pull-request chip', () => {
    expect(refs(splitAgentRefs('see pull request #2147 before changing code', noCtx))).toEqual([
      { kind: 'pull-request', prNumber: 2147, label: 'PR #2147' },
    ])
  })

  it('keeps a ticket ref and PR ref distinct in the same sentence', () => {
    expect(refs(splitAgentRefs('ticket #98 follows up PR #2147', noCtx))).toEqual([
      { kind: 'ticket', ticketId: 98, label: '#98' },
      { kind: 'pull-request', prNumber: 2147, label: 'PR #2147' },
    ])
  })

  it('captures GitHub pull request URLs as pull-request refs with URL metadata', () => {
    expect(refs(splitAgentRefs('opened https://github.com/org/repo/pull/2147.', noCtx))).toEqual([
      {
        kind: 'pull-request',
        prNumber: 2147,
        prUrl: 'https://github.com/org/repo/pull/2147',
        label: 'PR #2147',
      },
    ])
  })
})

describe('splitAgentRefs — job uuid gating', () => {
  it('linkifies a uuid only when it is in the context set', () => {
    expect(splitAgentRefs(`Job lanzado: ${UUID}`, ctx(UUID))).toEqual([
      { kind: 'text', text: 'Job lanzado: ' },
      { kind: 'job', jobId: UUID, label: `${UUID.slice(0, 8)}…` },
    ])
    expect(refs(splitAgentRefs(`conversation ${UUID}`, noCtx))).toHaveLength(0)
  })

  it('normalizes uppercase uuids to lowercase job ids', () => {
    const upper = UUID.toUpperCase()
    const segs = refs(splitAgentRefs(`run ${upper}`, ctx(UUID)))
    expect(segs).toEqual([{ kind: 'job', jobId: UUID, label: `${UUID.slice(0, 8)}…` }])
  })

  it('requires token boundaries around the uuid', () => {
    expect(refs(splitAgentRefs(`x${UUID}`, ctx(UUID)))).toHaveLength(0)
    expect(refs(splitAgentRefs(`${UUID}9`, ctx(UUID)))).toHaveLength(0)
  })

  it('handles mixed ticket + job refs in one run', () => {
    const text = `#7 shipped by run ${UUID}`
    const segs = refs(splitAgentRefs(text, ctx(UUID)))
    expect(segs).toEqual([
      { kind: 'ticket', ticketId: 7, label: '#7' },
      { kind: 'job', jobId: UUID, label: `${UUID.slice(0, 8)}…` },
    ])
  })

  it('gates each uuid independently', () => {
    const set = ctx(UUID)
    const segs = refs(splitAgentRefs(`${UUID} and ${UUID2}`, set))
    expect(segs).toEqual([{ kind: 'job', jobId: UUID, label: `${UUID.slice(0, 8)}…` }])
  })
})

// Minimal mdast helpers for direct plugin tests.
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}
const text = (value: string): MdNode => ({ type: 'text', value })
const para = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children })
const root = (...children: MdNode[]): MdNode => ({ type: 'root', children })
const vfile = (source: string) => ({ toString: () => source })

describe('remarkAgentRefs plugin', () => {
  it('replaces ticket refs in text nodes with #agentref: links', () => {
    const tree = root(para(text('see #3 now')))
    remarkAgentRefs()(tree as never, vfile('see #3 now'))
    const children = tree.children![0].children!
    expect(children.map((c) => c.type)).toEqual(['text', 'link', 'text'])
    expect(children[1].url).toBe('#agentref:ticket:3')
    expect(children[1].children![0].value).toBe('#3')
  })

  it('renders PR #N as a pull-request #agentref link instead of a ticket link', () => {
    const tree = root(para(text('Review follow-ups from PR #2147')))
    remarkAgentRefs()(tree as never, vfile('Review follow-ups from PR #2147'))
    const link = tree.children![0].children!.find((c) => c.type === 'link')
    expect(link?.url).toBe('#agentref:pr:2147')
    expect(link?.children![0].value).toBe('PR #2147')
  })

  it('uses the raw source for job context even when split across siblings', () => {
    // "**Job lanzado:** <uuid>" — the context word lives in a STRONG sibling;
    // the raw-source line gating still linkifies the uuid text node.
    const tree = root(
      para({ type: 'strong', children: [text('Job lanzado:')] }, text(` ${UUID}`)),
    )
    remarkAgentRefs()(tree as never, vfile(`**Job lanzado:** ${UUID}`))
    const children = tree.children![0].children!
    const link = children.find((c) => c.type === 'link')
    expect(link?.url).toBe(`#agentref:job:${UUID}`)
  })

  it('never touches code blocks or inline code', () => {
    const tree = root(
      { type: 'code', value: '#3' },
      para({ type: 'inlineCode', value: '#4' }, text(' and #5')),
    )
    remarkAgentRefs()(tree as never, vfile('```\n#3\n```\n`#4` and #5'))
    expect(tree.children![0]).toEqual({ type: 'code', value: '#3' })
    const inline = tree.children![1].children!
    expect(inline[0]).toEqual({ type: 'inlineCode', value: '#4' })
    // ...but the plain-text sibling still linkifies.
    expect(inline.some((c) => c.type === 'link' && c.url === '#agentref:ticket:5')).toBe(true)
  })

  it('never linkifies inside existing links', () => {
    const tree = root(
      para({ type: 'link', url: 'https://x.test', children: [text('#3')] }),
    )
    remarkAgentRefs()(tree as never, vfile('[#3](https://x.test)'))
    expect(tree.children![0].children![0].children![0]).toEqual({ type: 'text', value: '#3' })
  })

  it('leaves ref-free trees untouched', () => {
    const tree = root(para(text('nothing here')))
    remarkAgentRefs()(tree as never, vfile('nothing here'))
    expect(tree.children![0].children!).toEqual([{ type: 'text', value: 'nothing here' }])
  })
})

describe('inline-code uuid refs (backticked ids)', () => {
  it('camelCase compounds (loopRunId/jobId/runId) gate context on their own', () => {
    const ctx = computeJobContextUuids('loopRunId `11111111-2222-3333-4444-555555555555` listo')
    expect(ctx.has('11111111-2222-3333-4444-555555555555')).toBe(true)
  })

  it('no context words → uuid not gated', () => {
    const ctx = computeJobContextUuids('sin contexto 11111111-2222-3333-4444-555555555555')
    expect(ctx.size).toBe(0)
  })
})

describe('loop refs (factory ids + href codec)', () => {
  it('round-trips a factory loop ref and a uuid loop ref', () => {
    const href = agentRefHref({ kind: 'loop', loopId: 'factory:implement' })
    expect(href).toBe('#agentref:loop:factory:implement')
    expect(parseAgentRefHref(href)).toEqual({ kind: 'loop', loopId: 'factory:implement' })
    const uuidHref = agentRefHref({ kind: 'loop', loopId: UUID })
    expect(parseAgentRefHref(uuidHref)).toEqual({ kind: 'loop', loopId: UUID })
    expect(parseAgentRefHref('#agentref:loop:not-a-loop')).toBeNull()
    expect(parseAgentRefHref('#agentref:loop:factory:otherthing')).toBeNull()
  })

  it('linkifies factory:implement|batch|freestyle literals without a context gate', () => {
    for (const id of ['factory:implement', 'factory:batch', 'factory:freestyle']) {
      expect(refs(splitAgentRefs(`lanzo con ${id} ahora`, noCtx))).toEqual([
        { kind: 'loop', loopId: id, label: id },
      ])
    }
  })

  it('is token-bounded: no match mid-word or with trailing word chars', () => {
    expect(refs(splitAgentRefs('myfactory:implement', noCtx))).toEqual([])
    expect(refs(splitAgentRefs('factory:implementation', noCtx))).toEqual([])
    expect(refs(splitAgentRefs('factory:other', noCtx))).toEqual([])
  })

  it('backticked factory ids become loop refs; other inline code stays code', () => {
    const tree = root(
      para({ type: 'inlineCode', value: 'factory:implement' }, text(' vs ')),
      para({ type: 'inlineCode', value: 'npm test' }),
    )
    remarkAgentRefs()(tree as never, vfile('`factory:implement` vs\n\n`npm test`'))
    const first = tree.children![0].children!
    expect(first[0].type).toBe('link')
    expect(first[0].url).toBe('#agentref:loop:factory:implement')
    expect(tree.children![1].children![0]).toEqual({ type: 'inlineCode', value: 'npm test' })
  })

  it('mixed line: ticket + factory loop + gated uuid all linkify', () => {
    const segs = refs(splitAgentRefs(`#7 via factory:batch job ${UUID}`, ctx(UUID)))
    expect(segs.map((s) => s.kind)).toEqual(['ticket', 'loop', 'job'])
  })
})
