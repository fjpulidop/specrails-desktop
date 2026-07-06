/**
 * Agent-chat reference linkifier (mission mode).
 *
 * Turns two kinds of references inside SETTLED assistant messages into
 * clickable chips that open the same detail modals the board uses:
 *   1. Ticket refs  — `#N` (word-bounded, 1-6 digits), optionally carrying a
 *      title tail (`#3 — Add dark mode`), → the board's TicketDetailModal.
 *   2. Pull request refs — `PR #N`, `pull request #N`, or GitHub `/pull/N`
 *      URLs, → an external PR link when a URL is present.
 *   3. Job/loop-run ids — v4-ish UUIDs, but ONLY when the same source line
 *      carries a job/run/loop context word (EN + ES) so conversation ids in
 *      debug output never linkify, → the mission-mode JobDetailModal. A uuid
 *      that turns out to be a LOOP DEFINITION id (not a job row) is resolved
 *      at click time (the click layer falls back to the loops API) and opens
 *      the read-only LoopPreviewModal instead — detection stays pattern-only.
 *   4. Factory loop ids — the literal `factory:implement|batch|ultracode`
 *      tokens, → the same LoopPreviewModal (built-in, locked).
 *
 * Implemented as a remark plugin (`remarkAgentRefs`) so code blocks and inline
 * code are excluded for free (their content is a `code`/`inlineCode` literal,
 * never a `text` node), plus pure, unit-testable scanning helpers. Ref nodes
 * are emitted as mdast `link` nodes whose url is a `#agentref:` fragment —
 * fragments survive react-markdown's default URL sanitizer, unlike custom
 * protocols — and the message renderer's `a` component maps them to chips.
 */

export type AgentRefTarget =
  | { kind: 'ticket'; ticketId: number }
  | { kind: 'pull-request'; prNumber: number; prUrl?: string }
  | { kind: 'job'; jobId: string }
  | { kind: 'loop'; loopId: string }

export type AgentRefSegment =
  | { kind: 'text'; text: string }
  | { kind: 'ticket'; ticketId: number; label: string }
  | { kind: 'pull-request'; prNumber: number; prUrl?: string; label: string }
  | { kind: 'job'; jobId: string; label: string }
  | { kind: 'loop'; loopId: string; label: string }

// ── href codec (fragment form survives defaultUrlTransform) ─────────────────

const HREF_PREFIX = '#agentref:'

export function agentRefHref(ref: AgentRefTarget): string {
  if (ref.kind === 'ticket') return `${HREF_PREFIX}ticket:${ref.ticketId}`
  if (ref.kind === 'pull-request') {
    return `${HREF_PREFIX}pr:${ref.prNumber}${ref.prUrl ? `:${encodeURIComponent(ref.prUrl)}` : ''}`
  }
  if (ref.kind === 'loop') return `${HREF_PREFIX}loop:${ref.loopId}`
  return `${HREF_PREFIX}job:${ref.jobId}`
}

export function parseAgentRefHref(href: string | null | undefined): AgentRefTarget | null {
  if (!href || !href.startsWith(HREF_PREFIX)) return null
  const rest = href.slice(HREF_PREFIX.length)
  if (rest.startsWith('ticket:')) {
    const id = Number.parseInt(rest.slice('ticket:'.length), 10)
    return Number.isInteger(id) && id > 0 ? { kind: 'ticket', ticketId: id } : null
  }
  if (rest.startsWith('pr:')) {
    const [, rawNumber, rawUrl] = /^pr:(\d+)(?::(.+))?$/.exec(rest) ?? []
    const prNumber = Number.parseInt(rawNumber ?? '', 10)
    if (!Number.isInteger(prNumber) || prNumber <= 0) return null
    const prUrl = rawUrl ? decodeURIComponent(rawUrl) : undefined
    return prUrl ? { kind: 'pull-request', prNumber, prUrl } : { kind: 'pull-request', prNumber }
  }
  if (rest.startsWith('job:')) {
    const jobId = rest.slice('job:'.length)
    return UUID_EXACT_RE.test(jobId) ? { kind: 'job', jobId } : null
  }
  if (rest.startsWith('loop:')) {
    const loopId = rest.slice('loop:'.length)
    return FACTORY_LOOP_EXACT_RE.test(loopId) || UUID_EXACT_RE.test(loopId)
      ? { kind: 'loop', loopId }
      : null
  }
  return null
}

// ── scanning ─────────────────────────────────────────────────────────────────

const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const UUID_EXACT_RE = new RegExp(`^${UUID_SOURCE}$`)
/** Built-in factory loop ids (`server/loop-factory.ts`) — unambiguous literal
 *  tokens, so they linkify without a context-word gate. */
const FACTORY_LOOP_SOURCE = 'factory:(?:implement|batch|ultracode)'
const FACTORY_LOOP_EXACT_RE = new RegExp(`^${FACTORY_LOOP_SOURCE}$`)
/** Context words that mark a line as job/run/loop-talk (EN + ES), including
 *  camelCase id compounds (`loopRunId`, `jobId`, `runId`) that `\b` alone
 *  would miss. */
const JOB_CONTEXT_RE = /\b(jobs?|runs?|loops?|rails?|ejecuci[oó]n(?:es)?|trabajos?|bucles?)\b|(?:loop|job|run)[a-z]*id/i

/**
 * Lines of `source` that carry a job/run/loop context word contribute their
 * UUIDs (lowercased) to the returned set — the gate for job-ref linkify.
 * Computed on the RAW markdown source so context words split across sibling
 * mdast nodes (e.g. a bold "**Job lanzado:**" prefix) still count.
 */
export function computeJobContextUuids(source: string): Set<string> {
  const out = new Set<string>()
  for (const line of source.split('\n')) {
    if (!JOB_CONTEXT_RE.test(line)) continue
    const re = new RegExp(UUID_SOURCE, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) out.add(m[0].toLowerCase())
  }
  return out
}

interface RawMatch {
  start: number
  end: number
  segment: Exclude<AgentRefSegment, { kind: 'text' }>
}

/** Chars that must NOT immediately precede a ref (mid-word / entity / anchor). */
const BAD_BEFORE_RE = /[\w#&$-]/
/** Chars that must NOT immediately follow a ref (mid-token). */
const BAD_AFTER_RE = /[\w-]/

function scanPullRequests(text: string, out: RawMatch[]): void {
  const phraseRe = /\b(?:PR|pull request)\s*#?(\d{1,10})\b/gi
  let phrase: RegExpExecArray | null
  while ((phrase = phraseRe.exec(text)) !== null) {
    const before = text[phrase.index - 1]
    const after = text[phrase.index + phrase[0].length]
    if (before !== undefined && BAD_BEFORE_RE.test(before)) continue
    if (after !== undefined && BAD_AFTER_RE.test(after)) continue
    const prNumber = Number.parseInt(phrase[1], 10)
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue
    out.push({
      start: phrase.index,
      end: phrase.index + phrase[0].length,
      segment: { kind: 'pull-request', prNumber, label: `PR #${prNumber}` },
    })
  }

  const urlRe = /https?:\/\/[^\s<>)]+\/pull\/(\d{1,10})(?:[/?#][^\s<>)]*)?/gi
  let url: RegExpExecArray | null
  while ((url = urlRe.exec(text)) !== null) {
    const prNumber = Number.parseInt(url[1], 10)
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue
    const prUrl = url[0].replace(/[.,;:!?…]+$/u, '')
    out.push({
      start: url.index,
      end: url.index + prUrl.length,
      segment: { kind: 'pull-request', prNumber, prUrl, label: `PR #${prNumber}` },
    })
  }
}

function parsePullRequestUrl(url: string | null | undefined): { prNumber: number; prUrl: string } | null {
  if (!url) return null
  const match = /^https?:\/\/[^\s<>)]+\/pull\/(\d{1,10})(?:[/?#][^\s<>)]*)?$/i.exec(url)
  if (!match) return null
  const prNumber = Number.parseInt(match[1], 10)
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null
  return { prNumber, prUrl: url }
}

function scanTickets(text: string, out: RawMatch[]): void {
  const re = /#(\d{1,6})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const before = text[m.index - 1]
    const afterIdx = m.index + m[0].length
    const after = text[afterIdx]
    if (before !== undefined && BAD_BEFORE_RE.test(before)) continue
    if (after !== undefined && BAD_AFTER_RE.test(after)) continue
    const ticketId = Number.parseInt(m[1], 10)
    if (!Number.isInteger(ticketId) || ticketId <= 0) continue

    let end = afterIdx
    let label = `#${ticketId}`
    // Optional title tail on the SAME line: `#3 — Add dark mode`. Em/en dash
    // only (a bare hyphen is too ambiguous); stops at the next `#` so a second
    // ref on the line is never swallowed; trailing punctuation stays as text.
    const tail = /^([ \t]*[—–][ \t]*)([^\n#]{1,80})/.exec(text.slice(end))
    if (tail) {
      const title = tail[2].replace(/[\s.,;:!?…]+$/u, '')
      if (title.length > 0) {
        end += tail[1].length + title.length
        label = `#${ticketId} — ${title}`
      }
    }
    out.push({ start: m.index, end, segment: { kind: 'ticket', ticketId, label } })
  }
}

function scanJobs(text: string, jobContextUuids: ReadonlySet<string>, out: RawMatch[]): void {
  const re = new RegExp(UUID_SOURCE, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const before = text[m.index - 1]
    const after = text[m.index + m[0].length]
    if (before !== undefined && BAD_BEFORE_RE.test(before)) continue
    if (after !== undefined && BAD_AFTER_RE.test(after)) continue
    const jobId = m[0].toLowerCase()
    if (!jobContextUuids.has(jobId)) continue
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      segment: { kind: 'job', jobId, label: `${jobId.slice(0, 8)}…` },
    })
  }
}

function scanFactoryLoops(text: string, out: RawMatch[]): void {
  const re = new RegExp(FACTORY_LOOP_SOURCE, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const before = text[m.index - 1]
    const after = text[m.index + m[0].length]
    if (before !== undefined && BAD_BEFORE_RE.test(before)) continue
    if (after !== undefined && BAD_AFTER_RE.test(after)) continue
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      segment: { kind: 'loop', loopId: m[0], label: m[0] },
    })
  }
}

/**
 * Pure segmentation of one plain-text run into text + ref segments.
 * `jobContextUuids` comes from `computeJobContextUuids(rawSource)`.
 */
export function splitAgentRefs(
  text: string,
  jobContextUuids: ReadonlySet<string>,
): AgentRefSegment[] {
  const matches: RawMatch[] = []
  scanPullRequests(text, matches)
  scanTickets(text, matches)
  scanJobs(text, jobContextUuids, matches)
  scanFactoryLoops(text, matches)
  if (matches.length === 0) return [{ kind: 'text', text }]
  matches.sort((a, b) => a.start - b.start)

  const segments: AgentRefSegment[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue // overlap safety — keep the earlier ref
    if (match.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.start) })
    segments.push(match.segment)
    cursor = match.end
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

// ── remark plugin ─────────────────────────────────────────────────────────────

/** Minimal structural mdast node — avoids a hard dep on @types/mdast. */
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  [key: string]: unknown
}

/**
 * Subtrees never linkified: code (block + inline) per the locked constraints,
 * existing links/images (no nested interactive elements), raw html.
 */
const SKIP_SUBTREES = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'definition',
  'html',
])

function segmentToNode(segment: AgentRefSegment): MdNode {
  if (segment.kind === 'text') return { type: 'text', value: segment.text }
  const ref: AgentRefTarget =
    segment.kind === 'ticket'
      ? { kind: 'ticket', ticketId: segment.ticketId }
      : segment.kind === 'pull-request'
        ? { kind: 'pull-request', prNumber: segment.prNumber, prUrl: segment.prUrl }
      : segment.kind === 'loop'
        ? { kind: 'loop', loopId: segment.loopId }
        : { kind: 'job', jobId: segment.jobId }
  return {
    type: 'link',
    url: agentRefHref(ref),
    children: [{ type: 'text', value: segment.label }],
  }
}

function walk(node: MdNode, jobContextUuids: ReadonlySet<string>): void {
  const children = node.children
  if (!children) return
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]
    // Agents habitually backtick ids (`loopRunId \`01f41203-…\``) — an inline
    // code span whose ENTIRE value is a context-gated uuid is a job ref, not
    // code. Fenced blocks and any other inline code stay excluded.
    if (child.type === 'inlineCode' && typeof child.value === 'string') {
      const value = child.value.trim()
      if (UUID_EXACT_RE.test(value) && jobContextUuids.has(value.toLowerCase())) {
        const jobId = value.toLowerCase()
        children.splice(i, 1, segmentToNode({ kind: 'job', jobId, label: `${jobId.slice(0, 8)}…` }))
      } else if (FACTORY_LOOP_EXACT_RE.test(value)) {
        // Backticked factory ids (`factory:implement`) are loop refs, not code.
        children.splice(i, 1, segmentToNode({ kind: 'loop', loopId: value, label: value }))
      }
      continue
    }
    if (child.type === 'link' && typeof child.url === 'string') {
      const pullRequest = parsePullRequestUrl(child.url)
      if (pullRequest) {
        children.splice(
          i,
          1,
          segmentToNode({
            kind: 'pull-request',
            prNumber: pullRequest.prNumber,
            prUrl: pullRequest.prUrl,
            label: `PR #${pullRequest.prNumber}`,
          }),
        )
      }
      continue
    }
    if (SKIP_SUBTREES.has(child.type)) continue
    if (child.type === 'text' && typeof child.value === 'string') {
      const segments = splitAgentRefs(child.value, jobContextUuids)
      if (segments.some((s) => s.kind !== 'text')) {
        children.splice(i, 1, ...segments.map(segmentToNode))
      }
    } else {
      walk(child, jobContextUuids)
    }
  }
}

/**
 * remark plugin: replaces ticket/job refs in text nodes with `#agentref:` link
 * nodes. Reads the vfile for the raw source (job-context line gating). NOTE:
 * only wire this into SETTLED renders — never the live streaming buffer.
 */
export function remarkAgentRefs() {
  return (tree: MdNode, file?: unknown) => {
    const source = file == null ? '' : String(file)
    const jobContextUuids = computeJobContextUuids(source)
    walk(tree, jobContextUuids)
  }
}
