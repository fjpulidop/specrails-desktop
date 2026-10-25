import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertCircle, AtSign, Bot, BriefcaseBusiness, Check, Copy, Download, File, FileText, GitPullRequest, Hash, Image as ImageIcon, Loader2, Paperclip, Sparkles, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { format, isToday } from 'date-fns'
import { getDateFnsLocale } from '../../../lib/i18n'
import { toDate } from '../../../lib/relative-time'
import { splitStreamedMarkdown } from '../lib/stream-markdown-blocks'
import { cn } from '../../../lib/utils'
import { useWebViewModal } from '../../browser/context/WebViewModalContext'
import { MediaLightbox } from '../../chat/components/AttachmentPreviewLightbox'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { extractAgentOptions } from './agent-options'
import { promoteAgentProtocolFences } from './agent-fence-promotion'
import { extractAgentSpecDraft } from './agent-spec-draft'
import { AgentSpecDraftCard, AgentSpecDraftPending } from './AgentSpecDraftCard'
import { extractRailLaunchProposals } from '../../rails/lib/rail-launch-draft'
import { AgentRailLaunchCard, AgentRailLaunchPending, AgentRailLaunchUnreadable } from './AgentRailLaunchCard'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../lib/feature-flags'
import { intentFor, useLocalIntents } from '../../rails/lib/rail-launch-intents'
import type { AgentMessageIntent } from '../lib/agent-api'
import { extractAgentProblemFrame } from './agent-problem-frame'
import { AgentProblemFrameCard, AgentProblemFramePending } from './AgentProblemFrameCard'
import { parseAgentRefHref, remarkAgentRefs, type AgentRefTarget } from '../lib/agent-refs'
import { fetchAgentAttachmentBlob, type AgentAttachment, type AgentContextReference } from '../lib/agent-api'
import { AgentRefChip } from './AgentRefChip'
import { AgentDeliveryReceipt } from './AgentDeliveryReceipt'
import { extractExtensionFences } from './agent-extension-fences'
import { useIsConversationStreaming } from '../hooks/useAgentLive'
import { extensionFenceTags, modeAccent, useMissionExtensions, type MissionFenceCardProps, type MissionModeBadge } from '../context/MissionExtensionsContext'
import { LiveDot } from '../../../components/ui/live-dot'

// Token-based markdown styling — works across ALL themes (no prose-invert, which
// would break light themes). Tables, bold, code, lists, blockquotes, links.
const MD = cn(
  'max-w-[72ch] text-body leading-relaxed text-foreground',
  '[&_p]:my-3.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-title [&_h1]:font-semibold',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-strong [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_a]:text-accent-info [&_a]:underline [&_a]:underline-offset-2',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
  '[&_code]:rounded-control [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-foreground',
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

/** Clipboard write with a short-lived "copied" flag (announced, not just drawn). */
function useCopyFeedback(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return { copied, copy }
}

function CopyButton({ text, timestampIso }: { text: string; timestampIso?: string }) {
  const { t } = useTranslation('agent')
  const { copied, copy } = useCopyFeedback()
  const onCopy = () => {
    // Include the full `yyyy-MM-dd HH:mm:ss` as a header line, so a copied
    // message carries its timestamp (the bubble shows a compact form).
    let payload = text
    if (timestampIso) {
      const d = toDate(timestampIso)
      if (d) payload = `[${format(d, 'yyyy-MM-dd HH:mm:ss')}]\n${text}`
    }
    void copy(payload)
  }
  const label = copied ? t('copied') : t('copy')
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      title={label}
      className="rounded-md p-1 text-foreground/60 opacity-0 transition-opacity hover:bg-surface hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary group-hover:opacity-100"
      data-agent-interactive
    >
      {copied ? <Check className="h-3 w-3 text-accent-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      <span className="sr-only" role="status">{copied ? t('copied') : ''}</span>
    </button>
  )
}

/**
 * Fenced code block: the language as a quiet label and a copy button, both in
 * a top band so neither covers the code. The copy reads the rendered text, so
 * it matches exactly what the reader sees.
 */
function AgentCodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('agent')
  const preRef = useRef<HTMLPreElement>(null)
  const { copied, copy } = useCopyFeedback()
  const child = Children.toArray(children)[0]
  const codeClass = isValidElement<{ className?: string }>(child) ? child.props.className ?? '' : ''
  const language = /language-([\w+#.-]+)/.exec(codeClass)?.[1] ?? null
  const label = copied ? t('copied') : t('copyCode')
  return (
    <div className="group/code relative" data-testid="agent-code-block">
      {language && (
        <span className="pointer-events-none absolute left-3 top-1.5 select-none font-mono text-xs text-foreground/60" data-testid="agent-code-language">
          {language}
        </span>
      )}
      <button
        type="button"
        onClick={() => void copy(preRef.current?.textContent ?? '')}
        aria-label={label}
        title={label}
        className="absolute right-1.5 top-1 rounded-md p-1 text-foreground/60 opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary group-hover/code:opacity-100"
        data-agent-interactive
      >
        {copied ? <Check className="h-3.5 w-3.5 text-accent-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        <span className="sr-only" role="status">{copied ? t('copied') : ''}</span>
      </button>
      <pre ref={preRef} style={{ paddingTop: '1.75rem' }}>{children}</pre>
    </div>
  )
}

/**
 * Quiet per-bubble timestamp (messaging-app convention). 12px at 60% (75% on
 * hover of the bubble group) — readable without competing with the message.
 * Today shows `HH:mm`, older messages `MMM d, HH:mm` (locale-aware); the full
 * locale date+time is the tooltip and the copy payload keeps the sortable
 * `yyyy-MM-dd HH:mm:ss`. Renders nothing without a valid timestamp (streaming
 * buffer / optimistic rows) so it can't flicker.
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
      className="shrink-0 select-none text-xs leading-none tabular-nums text-foreground/60 transition-colors duration-200 group-hover:text-foreground/75"
    >
      {format(d, isToday(d) ? 'HH:mm' : 'MMM d, HH:mm', { locale })}
    </time>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isImageAttachment(attachment: AgentAttachment): boolean {
  return attachment.mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.filename)
}

function AgentAttachmentDialog({
  conversationId,
  attachment,
  onClose,
}: {
  conversationId: string
  attachment: AgentAttachment | null
  onClose: () => void
}) {
  const { t } = useTranslation('agent')
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!attachment) {
      setObjectUrl(null)
      setLoadError(null)
      return
    }
    let disposed = false
    setObjectUrl(null)
    setLoadError(null)
    fetchAgentAttachmentBlob(conversationId, attachment.id)
      .then((blob) => {
        if (disposed) return
        setObjectUrl(URL.createObjectURL(blob))
      })
      .catch((err) => {
        if (disposed) return
        setLoadError(err instanceof Error ? err.message : t('attachment.loadFailed'))
      })
    return () => {
      disposed = true
    }
  }, [attachment, conversationId, t])

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [objectUrl])

  if (!attachment) return null

  if (isImageAttachment(attachment)) {
    // One lightbox for the whole app (modal standard): Radix on the media layer.
    return (
      <MediaLightbox
        open
        onClose={onClose}
        filename={attachment.filename}
        subtitle={formatBytes(attachment.size) || attachment.mimeType}
        src={objectUrl}
        mimeType={attachment.mimeType}
        error={loadError ? t('attachment.loadError', { error: loadError }) : null}
      />
    )
  }

  // Non-image attachment: a short download confirm on the modal standard.
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="confirm" layer="media" showCloseButton={false}>
        <DialogHeader icon={<File />}>
          <DialogTitle>{t('attachment.downloadTitle')}</DialogTitle>
          <DialogDescription>{t('attachment.downloadPrompt')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-foreground">{attachment.filename}</p>
            <p className="text-xs text-muted-foreground">{[formatBytes(attachment.size), attachment.mimeType].filter(Boolean).join(' · ')}</p>
          </div>
          {loadError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('attachment.loadError', { error: loadError })}</span>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} data-agent-interactive>
            {t('attachment.cancelDownload')}
          </Button>
          {objectUrl ? (
            <Button asChild data-agent-interactive>
              <a href={objectUrl} download={attachment.filename}>
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('attachment.download')}
              </a>
            </Button>
          ) : (
            <Button type="button" disabled>
              {loadError ? <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
              {t('attachment.download')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AgentAttachmentChips({
  conversationId,
  attachments,
}: {
  conversationId?: string
  attachments?: AgentAttachment[]
}) {
  const { t } = useTranslation('agent')
  const [selected, setSelected] = useState<AgentAttachment | null>(null)
  if (!conversationId || !attachments || attachments.length === 0) return null
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/40 pt-2">
        {attachments.map((attachment) => {
          const image = isImageAttachment(attachment)
          const Icon = image ? ImageIcon : FileText
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => setSelected(attachment)}
              title={attachment.filename}
              aria-label={image ? t('attachment.openPreview', { name: attachment.filename }) : t('attachment.openDownload', { name: attachment.filename })}
              className="inline-flex max-w-[12rem] items-center gap-1.5 rounded-lg border border-border/60 bg-background/45 px-2 py-1 text-left text-xs text-foreground/75 transition-colors hover:border-accent-primary/45 hover:bg-accent-primary/10 hover:text-foreground"
              data-agent-interactive
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-accent-primary" />
              <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
              {attachment.size > 0 && <span className="shrink-0 text-xs text-foreground/60">{formatBytes(attachment.size)}</span>}
            </button>
          )
        })}
      </div>
      <AgentAttachmentDialog conversationId={conversationId} attachment={selected} onClose={() => setSelected(null)} />
    </>
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
        'mx-0.5 inline-flex max-w-[16rem] translate-y-[2px] items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-medium leading-4 shadow-sm shadow-black/5',
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

/** Streaming placeholder while an extension card block is still arriving. */
function AgentExtensionPending() {
  const { t } = useTranslation('agent')
  return (
    <div data-testid="agent-extension-card-pending" className="my-1 inline-flex items-center gap-1.5 rounded-full border border-accent-primary/30 bg-accent-primary/10 px-2.5 py-1 text-xs text-accent-primary">
      <LiveDot tone="primary" size="xs" aria-hidden />
      {t('cardPending')}
    </div>
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
  /** A discreet mode mark next to the timestamp (an agent turn produced in an
   *  extension's mode, e.g. Flow): its icon, color and words come from the
   *  extension (useMissionTurnMark), never hard-coded here. */
  modeMark?: MissionModeBadge | null
  /** Streaming assistant bubble: render markdown live, hide the copy button. */
  streaming?: boolean
  /** True only for the newest message while no turn is streaming — gates chips. */
  isLast?: boolean
  /** True for the newest message in the thread, streaming or not. Unlike
   *  `isLast` this survives an in-flight turn, so the problem-frame card can
   *  keep its (disabled) reading affordance instead of silently going static. */
  isLatest?: boolean
  /** A turn is in flight anywhere in the conversation — disables the frame
   *  card's readings so a click can't queue a duplicate concurrent reply. */
  isStreaming?: boolean
  /** Sends the clicked option label — or a picked problem-frame reading — as
   *  the user's reply (the same send() the composer's submit() calls). */
  onPickOption?: (option: string) => void
  /** Project scope for ticket/job ref chips — the mission's pinned project.
   *  null/undefined (Home / app-global conversations) ⇒ refs stay plain text. */
  refsProjectId?: string | null
  /** Opens a clicked ref chip (ticket → TicketDetailModal, job → JobDetailModal). */
  onOpenRef?: (ref: AgentRefTarget) => void
  /** Structured refs selected in the composer. User messages render them as chips. */
  contextRefs?: AgentContextReference[]
  /** Attachments persisted with a user message. */
  attachments?: AgentAttachment[]
  deliveryStatus?: 'delivered' | 'interrupted' | 'cancelled'
  deliveryReceipt?: 'sent' | 'received' | 'read'
  /** Conversation id needed to fetch the attachment blob for preview/download. */
  conversationId?: string
  /** Local (OpenAI-compatible) engines only: re-tag ```json protocol blocks. CLI providers stay strict. */
  tolerantFences?: boolean
  /** The message row id — needed to persist a rail-launch card decision. */
  messageId?: string
  /** Persisted card decisions on this row, one per proposal (mission-rail-cards). */
  intents?: readonly AgentMessageIntent[] | null
  /** True when this message's undecided rail-launch proposals are rendered in
   *  the pinned dock instead — the history slot shows a slim marker. */
  railProposalsPinned?: boolean
}

type MarkdownPlugins = ComponentProps<typeof ReactMarkdown>['remarkPlugins']
type MarkdownComponents = ComponentProps<typeof ReactMarkdown>['components']

/** One settled chunk of a streaming answer: parsed once, never again. */
const StreamedChunk = memo(function StreamedChunk({ text, remarkPlugins, components }: { text: string; remarkPlugins: MarkdownPlugins; components: MarkdownComponents }) {
  return <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{text}</ReactMarkdown>
})

/**
 * The message body. A LONG streaming answer renders as settled chunks (memoised)
 * plus the live tail, so each frame re-parses the tail only; everything else
 * (settled messages, short streams) renders whole.
 */
function MessageMarkdown({ body, streaming, remarkPlugins, components }: { body: string; streaming: boolean; remarkPlugins: MarkdownPlugins; components: MarkdownComponents }) {
  const chunks = useMemo(() => (streaming ? splitStreamedMarkdown(body) : null), [body, streaming])
  if (!chunks || chunks.stable.length === 0) {
    return <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{body}</ReactMarkdown>
  }
  return (
    <>
      {chunks.stable.map((text, index) => <StreamedChunk key={index} text={text} remarkPlugins={remarkPlugins} components={components} />)}
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{chunks.tail}</ReactMarkdown>
    </>
  )
}

/** A single agent chat message: markdown-rendered, with a subtle per-bubble copy. */
/**
 * Settled rows far from the end ignore "a turn is in flight" on purpose (a turn
 * starting would re-parse the whole transcript). Their INTERACTIVE cards still
 * must not be clickable mid-turn, so each reads the conversation's streaming
 * flag itself through a boolean selector: only rows that hold such a card
 * re-render when a turn starts or ends.
 */
function useConversationBusy(conversationId: string | null, rowStreaming: boolean): boolean {
  const live = useIsConversationStreaming(conversationId)
  return rowStreaming || live
}
function LiveBusyFrameCard({ conversationId, isStreaming, ...rest }: ComponentProps<typeof AgentProblemFrameCard> & { conversationId: string | null }) {
  return <AgentProblemFrameCard {...rest} isStreaming={useConversationBusy(conversationId, !!isStreaming)} />
}
function LiveBusyFenceCard({ Card, ...props }: { Card: ComponentType<MissionFenceCardProps> } & MissionFenceCardProps) {
  const busy = useConversationBusy(props.conversationId, props.isStreaming)
  return <Card {...props} isStreaming={busy} />
}

export function AgentMessage({ role, content, createdAt, modeMark = null, streaming, isLast, isLatest, isStreaming, onPickOption, refsProjectId, onOpenRef, contextRefs, attachments, conversationId, deliveryStatus, deliveryReceipt, tolerantFences = false, messageId, intents = null, railProposalsPinned = false }: Props) {
  const { t } = useTranslation('agent')
  const localIntents = useLocalIntents()
  const extensions = useMissionExtensions()
  const extensionTags = extensionFenceTags(extensions).join(',')
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
    pre: AgentCodeBlock,
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
      <article aria-label={t('message.you')} className="group flex flex-col items-end gap-0.5">
        <div className="flex items-start justify-end gap-1">
          <CopyButton text={content} timestampIso={createdAt} />
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-border/50 bg-foreground/[0.06] px-3.5 py-2 text-sm text-foreground">
            <AgentContextInlineTokens content={content} contextRefs={contextRefs} />
            <AgentAttachmentChips conversationId={conversationId} attachments={attachments} />
            {(deliveryStatus || deliveryReceipt) && <div className="mt-1 flex justify-end"><AgentDeliveryReceipt receipt={deliveryReceipt} status={deliveryStatus} /></div>}
          </div>
        </div>
        {createdAt && (
          <div className="pr-1.5">
            <MessageTime iso={createdAt} />
          </div>
        )}
      </article>
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
  //
  // A fenced ```problem-frame block (the framing step that PRECEDES drafting)
  // gets the same treatment and renders above the draft card. A turn may carry
  // both when the agent re-frames and re-drafts in one reply. The whole
  // extraction chain is memoized on (content, streaming) so a streaming turn
  // does not reparse three protocols on every frame.
  const { body, options, frame, framePending, draft, pending, rail, extensionBlocks, extensionPending } = useMemo(() => {
    // Small/local models emit protocol JSON under ```json — re-tag first.
    const promoted = tolerantFences ? promoteAgentProtocolFences(content) : content
    const withoutOptions = extractAgentOptions(promoted)
    const withoutFrame = extractAgentProblemFrame(withoutOptions.body, streaming)
    const withoutDraft = extractAgentSpecDraft(withoutFrame.body, streaming)
    // A fenced ```rail-launch block (mission-rail-cards) is stripped too and
    // renders as an editable launch card; feature off ⇒ untouched.
    const withoutRail = FEATURE_MISSION_RAIL_CARDS
      ? extractRailLaunchProposals(withoutDraft.body, streaming)
      : { body: withoutDraft.body, proposals: [], rejected: [], pending: false, truncated: false, repaired: false }
    // Fences registered by mission extensions (e.g. ```flow-offer) — the
    // extension renders the card; missions only strips the block.
    const withoutExtensions = extractExtensionFences(withoutRail.body, extensionTags ? extensionTags.split(',') : [], streaming)
    return {
      body: withoutExtensions.body,
      options: withoutOptions.options,
      frame: withoutFrame.frame,
      framePending: withoutFrame.pending,
      draft: withoutDraft.draft,
      pending: withoutDraft.pending,
      rail: withoutRail,
      extensionBlocks: withoutExtensions.blocks,
      extensionPending: withoutExtensions.pending.length > 0,
    }
  }, [content, streaming, tolerantFences, extensionTags])
  const railUnreadable = !streaming && rail.rejected.length > 0 ? rail.rejected.map((r) => r.excerpt) : []
  const showChips = !!options && !!isLast && !streaming && !!onPickOption
  return (
    <article aria-label={t('message.agent')} aria-busy={streaming || undefined} className="group flex flex-col gap-1">
      <div className={cn('max-w-full', MD)}>
        <MessageMarkdown body={body} streaming={!!streaming} remarkPlugins={remarkPlugins} components={markdownComponents} />
      </div>
      {frame && (
        // Both readings are clickable answers to the discriminating question:
        // the same send() the option chips use, gated to the newest card and
        // disabled while a turn is in flight (no resend of an answered frame,
        // no duplicate concurrent turn).
        <LiveBusyFrameCard
          frame={frame}
          isLatest={!!isLatest}
          isStreaming={!!isStreaming || !!streaming}
          conversationId={conversationId ?? null}
          onSelect={onPickOption}
        />
      )}
      {framePending && <AgentProblemFramePending />}
      {draft && <AgentSpecDraftCard draft={draft} />}
      {pending && <AgentSpecDraftPending />}
      {!streaming && messageId && conversationId && rail.proposals.map((proposal, index) => {
        const decided = intentFor(localIntents, messageId, intents, index)
        // Undecided proposals live in the pinned dock; the slot keeps a marker
        // (rendered by the conversation view). Decided ones freeze here.
        if (!decided && railProposalsPinned) return null
        return (
          <AgentRailLaunchCard
            key={`${messageId}:${index}`}
            proposal={proposal}
            proposalIndex={index}
            messageId={messageId}
            conversationId={conversationId}
            projectId={refsProjectId ?? null}
            intent={decided}
          />
        )
      })}
      {rail.pending && <AgentRailLaunchPending />}
      {!streaming && extensionBlocks.map((block) => {
        const Card = extensions.fenceCards?.[block.tag]
        return Card ? (
          <LiveBusyFenceCard
            Card={Card}
            key={`${messageId ?? 'live'}:${block.tag}:${block.index}`}
            tag={block.tag}
            payload={block.payload}
            index={block.index}
            messageId={messageId ?? null}
            conversationId={conversationId ?? null}
            projectId={refsProjectId ?? null}
            intents={intents}
            isLatest={!!isLatest}
            isStreaming={!!isStreaming}
            onSend={onPickOption}
          />
        ) : null
      })}
      {extensionPending && <AgentExtensionPending />}
      {railUnreadable.length > 0 && <AgentRailLaunchUnreadable excerpts={railUnreadable} />}
      {showChips && (
        <div role="group" aria-label={t('options.groupLabel')} className="flex flex-wrap gap-1.5 pt-1" data-testid="agent-option-chips">
          {options.map((option, i) => (
            <button
              key={`${i}-${option}`}
              type="button"
              onClick={() => onPickOption?.(option)}
              title={i < 9 ? t('options.shortcut', { n: i + 1 }) : undefined}
              aria-keyshortcuts={i < 9 ? `Alt+${i + 1}` : undefined}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/70 px-3 py-1 text-xs text-foreground/80 transition-colors hover:border-accent-primary/45 hover:bg-accent-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
              data-agent-interactive
            >
              {i < 9 && <span aria-hidden className="text-xs tabular-nums text-foreground/60">{i + 1}</span>}
              {option}
            </button>
          ))}
        </div>
      )}
      {!streaming && (body.trim() || createdAt) && (
        <div className="flex items-center gap-2">
          {body.trim() && <CopyButton text={body} timestampIso={createdAt} />}
          {createdAt && <MessageTime iso={createdAt} />}
          {modeMark && (
            <span className="inline-flex shrink-0 select-none items-center gap-1 text-caption leading-none text-foreground/70" data-testid="agent-message-mode-mark" title={modeMark.description} style={{ '--turn-mode-accent': modeAccent(modeMark) } as CSSProperties}>
              {modeMark.icon && <modeMark.icon className="h-3 w-3 shrink-0 text-[color:var(--turn-mode-accent)]" aria-hidden />}
              {modeMark.label}
            </span>
          )}
        </div>
      )}
    </article>
  )
}
