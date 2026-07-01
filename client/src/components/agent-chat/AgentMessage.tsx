import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

// Token-based markdown styling — works across ALL themes (no prose-invert, which
// would break light themes). Tables, bold, code, lists, blockquotes, links.
const MD = cn(
  'text-sm leading-relaxed text-foreground',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-[15px] [&_h2]:font-semibold',
  '[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_a]:text-accent-info [&_a]:underline [&_a]:underline-offset-2',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
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

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation('agent')
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
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

interface Props {
  role: 'user' | 'assistant'
  content: string
  /** Streaming assistant bubble: render markdown live, hide the copy button. */
  streaming?: boolean
}

/** A single agent chat message: markdown-rendered, with a subtle per-bubble copy. */
export function AgentMessage({ role, content, streaming }: Props) {
  const isUser = role === 'user'

  if (isUser) {
    return (
      <div className="group flex items-start justify-end gap-1">
        <CopyButton text={content} />
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-border/50 bg-foreground/[0.06] px-3.5 py-2 text-sm text-foreground">
          {content}
        </div>
      </div>
    )
  }

  return (
    <div className="group flex flex-col gap-1">
      <div className={cn('max-w-full', MD)}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
      {!streaming && content.trim() && (
        <div className="flex justify-start">
          <CopyButton text={content} />
        </div>
      )}
    </div>
  )
}
