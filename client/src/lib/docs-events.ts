/**
 * Cross-feature request to open the in-app guide, optionally at a section.
 * The Docs dialog is owned by the app shell (App.tsx, `?overlay=docs`), so a
 * hint deep in a feature asks for it through a window event instead of
 * importing the shell, exactly like `openAppSettings`.
 */
export const OPEN_DOCS_EVENT = 'specrails:open-docs'

/** A guide page and, optionally, where to land in it. */
export interface DocsTarget {
  /** Guide category directory (`pipeline`). */
  category: string
  /** Bare page slug without the `<order>-` prefix (`rails-and-jobs`). */
  slug: string
  /** Explicit heading anchor (`## Title {#anchor}` in the guide). */
  anchor?: string | null
  /** Heading text to land on when it has no explicit anchor (search results). */
  heading?: string | null
}

export interface OpenDocsDetail {
  target: DocsTarget | null
}

/** Open the guide (at `target`, or wherever it was last left when null). */
export function openDocs(target: DocsTarget | null = null): void {
  try {
    window.dispatchEvent(new CustomEvent<OpenDocsDetail>(OPEN_DOCS_EVENT, { detail: { target } }))
  } catch {
    // non-DOM environment — nothing to open
  }
}
