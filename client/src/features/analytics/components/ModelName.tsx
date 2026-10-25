import { modelLabel } from '../../../lib/model-label'

/**
 * A model as people read it ("Claude Sonnet", "GPT-6.1 Sol"). The raw slug stays in the tooltip;
 * an unmapped slug is shown verbatim in monospace so it is never mistaken for a product name.
 */
export function ModelName({ slug, className }: { slug: string | null | undefined; className?: string }) {
  const { text, known } = modelLabel(slug)
  if (!text) return null
  if (known) return <span className={className} title={slug ?? undefined}>{text}</span>
  return <span className={`${className ?? ''} font-mono`.trim()}>{text}</span>
}
