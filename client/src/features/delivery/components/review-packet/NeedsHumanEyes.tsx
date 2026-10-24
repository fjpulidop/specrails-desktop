/**
 * "Needs human eyes" (project rules inventory, feedback-2026-10 task 4.4): the
 * project's written rules no check can enforce, frozen when the delivery
 * settled. A reminder for the reviewer, never a verdict.
 */
import { useTranslation } from 'react-i18next'
import { Eye } from 'lucide-react'

export function NeedsHumanEyes({ rules }: { rules: Array<{ text: string; source: string | null }> }) {
  const { t } = useTranslation('packet')
  return (
    <section className="rounded-lg border border-accent-highlight/30 bg-accent-highlight/5 p-4" data-testid="packet-human-eyes" aria-labelledby="packet-human-eyes-title">
      <h2 id="packet-human-eyes-title" className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Eye className="size-4 text-accent-highlight" aria-hidden />
        {t('humanEyes.title', { count: rules.length })}
      </h2>
      <p className="mb-2 text-[11px] text-muted-foreground">{t('humanEyes.caveat')}</p>
      <ul className="space-y-1">
        {rules.map((rule, index) => (
          <li key={`${index}:${rule.text}`} className="flex items-start gap-2 text-xs text-foreground">
            <span aria-hidden className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-accent-highlight" />
            <span className="min-w-0 break-words">
              {rule.text}
              {rule.source ? <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{rule.source}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
