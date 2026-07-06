import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AtSign, Bot, BriefcaseBusiness, Check, Copy, FileText, GitPullRequest, Hash, Paperclip, Sparkles, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { getDateFnsLocale } from '../../lib/i18n'
import { toDate } from '../../lib/relative-time'
import { cn } from '../../lib/utils'
import { useWebViewModal } from '../../context/WebViewModalContext'
import { extractAgentOptions } from './agent-options'
import { extractAgentSpecDraft } from './agent-spec-draft'
import { AgentSpecDraftCard, AgentSpecDraftPending } from './AgentSpecDraftCard'
import { parseAgentRefHref, remarkAgentRefs, type AgentRefTarget } from '../../lib/agent-refs'
import type { AgentContextReference } from '../../lib/agent-api'
import { AgentRefChip } from './AgentRefChip'

// Token-based markdown styling — works across ALL themes (no prose-invert, which
// would break light themes). Tables, bold, code, lists, blockquotes, links.
const MD = cn(
  'text-sm leading-7 text-foreground',
  '[&_p]:my-3.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-[15px] [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_a]:text-accent-info [&_a]:underline [&_a]:underline-offset-2',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
  '[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-accent-info',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-accent-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-foreground/80',
  '[&_hr]:my-3 [&_hr]:border-border/60',
  // Premium tables
  '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-lg',
  '[&_th]:border [&_th]:border-border [&_th]:bg-surface [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5',
  '[&_tr:nth-child(even)]:bg-surface/40',
)

function CopyButton({ text, timestampIso }: { text: string; timestampIso?: string }) {
  const { t } = useTranslation('agent')
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      // Include the same `yyyy-MM-dd HH:mm:ss` shown under the bubble as a header
      // line, so a copied message carries its timestamp.
      let payload = text
      if (timestampIso) {
        const d = toDate(timestampIso)
        if (d) payload = `[${format(d, 'yyyy-MM-dd HH:mm:ss')}]\n${text}`
      }
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={t('copy')}
      title={t('copy')}
      className="rounded-md p-1 text-foreground/40 opacity-0 transition-opacity hover:bg-surface hover:text-foreground group-hover:opacity-100"
      data-agent-interactive
    >
      {copied ? <Check className="h-3 w-3 text-accent-success" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

/**
 * Whisper-subtle per-bubble timestamp (messaging-app convention). Always present
 * so the time is visually recorded + consultable, but at 10px / 25% opacity it
 * never competes with the message; it brightens slightly on hover of the bubble
 * group and carries the full locale date+time as a tooltip. Shows the absolute
 * `yyyy-MM-dd HH:mm:ss` (24h, ISO-ish, sortable at a glance). Renders nothing
 * without a valid timestamp (streaming buffer / optimistic rows) so it can't
 * flicker.
 */
function MessageTime({ iso }: { iso?: string }) {
  if (!iso) return null
  const d = toDate(iso)
  if (!d) return null
  const locale = getDateFnsLocale()
  return (
    <time
      dateTime={d.toISOString()}
      title={format(d, 'PPpp', { locale })}
      className="shrink-0 select-none font-mono text-[10px] leading-none tabular-nums tracking-tight text-foreground/25 transition-colors duration-200 group-hover:text-foreground/50"
    >
      {format(d, 'yyyy-MM-dd HH:mm:ss')}
    </time>
  )
}

function contextIcon(kind: string): LucideIcon {
  if (kind === 'project' || kind === 'alias') return BriefcaseBusiness
  if (kind === 'spec') return FileText
  if (kind === 'job') return Bot
  if (kind === 'trace') return Hash
  if (kind === 'conversation') return Bot
  if (kind === 'file') return Paperclip
  if (kind === 'pr') return GitPullRequest
  if (kind === 'action') return Sparkles
  return AtSign
}

function contextTone(kind: string): string {
  if (kind === 'action') return 'border-accent-highlight/30 bg-accent-highlight/10 text-accent-highlight'
  if (kind === 'job' || kind === 'trace') return 'border-accent-info/30 bg-accent-info/10 text-accent-info'
  if (kind === 'spec') return 'border-accent-highlight/30 bg-accent-highlight/10 text-accent-highlight'
  if (kind === 'project' || kind === 'alias') return 'border-accent-primary/30 bg-accent-primary/10 text-accent-primary'
  return 'border-border/60 bg-surface/70 text-foreground/80'
}

function AgentContextInlineChip({ refItem }: { refItem: AgentContextReference }) {
  const Icon = contextIcon(refItem.kind)
  const title = [refItem.label, refItem.scope?.projectName, refItem.status].filter(Boolean).join(' · ')
  return (
    <span
      title={title || refItem.token}
      className={cn(
        'mx-0.5 inline-flex max-w-[16rem] translate-y-[2px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 shadow-sm shadow-black/5',
        contextTone(refItem.kind),
      )}
      data-agent-context-token={refItem.kind}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{refItem.label || refItem.token}</span>
    </span>
  )
}

export function AgentContextInlineTokens({
  content,
  contextRefs,
}: {
  content: string
  contextRefs?: AgentContextReference[]
}) {
  if (!contextRefs || contextRefs.length === 0) return <>{content}</>
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let matched = 0
  const matchedIndexes = new Set<number>()
  const ordered = contextRefs
    .map((ref, originalIndex) => ({ ref, originalIndex, index: ref.token ? content.indexOf(ref.token) : -1 }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index || a.originalIndex - b.originalIndex)
  for (const entry of ordered) {
    const index = content.indexOf(entry.ref.token, cursor)
    if (index < cursor || index === -1) continue
    if (index > cursor) nodes.push(content.slice(cursor, index))
    nodes.push(<AgentContextInlineChip key={`${entry.ref.kind}:${entry.ref.id}:${index}:${entry.originalIndex}`} refItem={entry.ref} />)
    cursor = index + entry.ref.token.length
    matchedIndexes.add(entry.originalIndex)
    matched++
  }
  if (cursor < content.length) nodes.push(content.slice(cursor))
  const unmatched = contextRefs.filter((_, index) => !matchedIndexes.has(index))
  if (unmatched.length === 0) return <>{matched ? nodes : content}</>
  return (
    <>
      {unmatched.map((ref, index) => (
        <AgentContextInlineChip key={`unmatched:${ref.kind}:${ref.id}:${index}`} refItem={ref} />
      ))}
      {content.trim() && <span className="mx-0.5" />}
      {matched ? nodes : content}
    </>
  )
}

interface Props {
  /** `system` rows are app-authored inline cards (PR-decision card, P7);
   *  until the card branch lands they render through the assistant path. */
  role: 'user' | 'assistant' | 'system'
  content: string
  /** ISO creation time — rendered as a subtle per-bubble timestamp. Absent on
   *  the live streaming buffer (the time appears once the turn settles). */
  createdAt?: string
  /** Streaming assistant bubble: render markdown live, hide the copy button. */
  streaming?: boolean
  /** True only for the newest message while no turn is streaming — gates chips. */
  isLast?: boolean
  /** Sends the clicked option label as the user's reply. */
  onPickOption?: (option: string) => void
  /** Project scope for ticket/job ref chips — the mission's pinned project.
   *  null/undefined (Home / app-global conversations) ⇒ refs stay plain text. */
  refsProjectId?: string | null
  /** Opens a clicked ref chip (ticket → TicketDetailModal, job → JobDetailModal). */
  onOpenRef?: (ref: AgentRefTarget) => void
  /** Structured refs selected in the composer. User messages render them as chips. */
  contextRefs?: AgentContextReference[]
}

/** A single agent chat message: markdown-rendered, with a subtle per-bubble copy. */
export function AgentMessage({ role, content, createdAt, streaming, isLast, onPickOption, refsProjectId, onOpenRef, contextRefs }: Props) {
  const isUser = role === 'user'
  const { openWebView, canOpenWebView } = useWebViewModal()

  // Ref chips linkify ONLY settled assistant content: the live streaming buffer
  // re-parses per frame (useSmoothStream), so it must stay untouched.
  const refsEnabled = !isUser && !streaming && !!refsProjectId && !!onOpenRef
  const remarkPlugins = useMemo(
    () => (refsEnabled ? [remarkGfm, remarkAgentRefs] : [remarkGfm]),
    [refsEnabled],
  )

  // http(s) links open in the app's embedded browser (same pattern as spec
  // descriptions) instead of navigating the whole webview away. When the
  // embedded browser can't open (no project / feature off), keep target=_blank.
  const markdownComponents = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      // `#agentref:` fragments are emitted by remarkAgentRefs (settled renders
      // only) — render them as clickable ticket/job chips instead of anchors.
      const refTarget = parseAgentRefHref(href)
      if (refTarget && onOpenRef) {
        return (
          <AgentRefChip refTarget={refTarget} onOpen={onOpenRef}>
            {children}
          </AgentRefChip>
        )
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          data-agent-interactive
          onClick={(e) => {
            if (canOpenWebView && typeof href === 'string' && /^https?:\/\//i.test(href)) {
              e.preventDefault()
              e.stopPropagation()
              openWebView(href)
            }
          }}
        >
          {children}
        </a>
      )
    },
  }), [openWebView, canOpenWebView, onOpenRef])

  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-0.5">
        <div className="flex items-start justify-end gap-1">
          <CopyButton text={content} timestampIso={createdAt} />
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-border/50 bg-foreground/[0.06] px-3.5 py-2 text-sm text-foreground">
            <AgentContextInlineTokens content={content} contextRefs={contextRefs} />
          </div>
        </div>
        {createdAt && (
          <div className="pr-1.5">
            <MessageTime iso={createdAt} />
          </div>
        )}
      </div>
    )
  }

  // Assistant messages are always markdown-rendered — including WHILE streaming,
  // so formatting (bold, lists, tables) appears live instead of showing raw
  // markdown until the turn settles. The bottom activity chip signals streaming;
  // the copy button appears once it's done.
  //
  // A valid trailing ```options block (the agent asking the user to choose) is
  // ALWAYS stripped from the rendered markdown; the chips themselves render only
  // on the last settled message — older questions keep just their prose.
  //
  // A fenced ```spec-draft block (the spec-refinement live draft protocol) is
  // likewise stripped and rendered as a premium draft card below the prose;
  // while it is still streaming in, the raw JSON tail is cut and a small
  // "updating draft" chip shows instead.
  const { body: bodyWithDraft, options } = extractAgentOptions(content)
  const { body, draft, pending } = extractAgentSpecDraft(bodyWithDraft, streaming)
  const showChips = !!options && !!isLast && !streaming && !!onPickOption
  return (
    <div className="group flex flex-col gap-1">
      <div className={cn('max-w-full', MD)}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>{body}</ReactMarkdown>
      </div>
      {draft && <AgentSpecDraftCard draft={draft} />}
      {pending && <AgentSpecDraftPending />}
      {showChips && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {options.map((option, i) => (
            <button
              key={`${i}-${option}`}
              type="button"
              onClick={() => onPickOption?.(option)}
              className="rounded-full border border-border/60 bg-surface/70 px-3 py-1 text-xs text-foreground/80 transition-colors hover:border-accent-primary/45 hover:bg-accent-primary/15 hover:text-foreground"
              data-agent-interactive
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {!streaming && (body.trim() || createdAt) && (
        <div className="flex items-center gap-2">
          {body.trim() && <CopyButton text={body} timestampIso={createdAt} />}
          {createdAt && <MessageTime iso={createdAt} />}
        </div>
      )}
    </div>
  )
}
