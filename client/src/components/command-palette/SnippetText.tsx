import { Fragment } from 'react'
import { highlightParts, type HighlightRange } from './snippet'

/** Text with its match ranges marked. Plain text nodes + `<mark>`: never raw HTML. */
export function SnippetText({ text, ranges }: { text: string; ranges?: readonly HighlightRange[] | null }) {
  return (
    <>
      {highlightParts(text, ranges).map((part, i) =>
        part.mark ? (
          <mark key={i} className="rounded-sm bg-accent-primary/20 px-0.5 text-foreground">{part.text}</mark>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}
