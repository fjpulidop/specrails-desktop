import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../../lib/utils'

/**
 * Markdown for the review packet's narrative slots ("what you asked", "what
 * was done"). The composer hands over spec markdown verbatim (bold section
 * labels, numbered journeys, inline code naming real files) — rendering it as
 * a plain `<p>` collapsed every list into one run-on line and left the
 * backticks visible. Typography is deliberately quiet: the packet is read by
 * a non-technical person, so lists breathe, code reads as a chip rather than
 * a terminal, links open in a new tab, and images/raw HTML never render.
 */
export function PacketMarkdown({ children, muted = false, className }: { children: string; muted?: boolean; className?: string }) {
  const components = useMemo(() => ({
    a: ({ href, children: label }: { href?: string; children?: React.ReactNode }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-accent-primary underline decoration-accent-primary/40 underline-offset-2 hover:decoration-accent-primary">
        {label}
      </a>
    ),
    img: () => null,
    code: ({ className: codeClass, children: code }: { className?: string; children?: React.ReactNode }) =>
      codeClass ? (
        <code className={codeClass}>{code}</code>
      ) : (
        <code className="rounded-md border border-border/50 bg-background-deep/60 px-1.5 py-px font-mono text-[0.85em] text-accent-info">{code}</code>
      ),
  }), [])
  return (
    <div
      data-testid="packet-markdown"
      className={cn(
        'prose prose-invert prose-sm max-w-none leading-relaxed',
        'prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold',
        'prose-strong:text-foreground prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-li:marker:text-accent-primary/70',
        'prose-pre:my-2 prose-pre:rounded-lg prose-pre:border prose-pre:border-border/50 prose-pre:bg-background-deep/60 prose-pre:text-xs',
        'prose-blockquote:border-accent-primary/40 prose-blockquote:text-muted-foreground prose-hr:border-border/50',
        muted ? 'text-muted-foreground' : 'text-foreground/85',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{children}</ReactMarkdown>
    </div>
  )
}
