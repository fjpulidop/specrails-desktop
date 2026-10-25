import type { ReactNode } from 'react'

/**
 * Marks a settings block as a ⌘K target (`data-setting-id`, see
 * `lib/settings-registry.ts`). It is a plain column that keeps the pane's
 * vertical rhythm (`gap-5`, as `space-y-5` does) for the cards inside it and takes no space when
 * the block renders nothing.
 */
export function SettingAnchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-setting-id={id} className="flex flex-col gap-5 scroll-mt-4 [&:empty]:[display:none]">
      {children}
    </div>
  )
}
