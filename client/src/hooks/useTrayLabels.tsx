import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { useLanguageOptional } from '../context/LanguageContext'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Push localized system-tray menu labels (Open / Exit / MCP status) to the Rust
 * host whenever the app mounts and whenever the UI language changes. The Rust
 * tray is built with English defaults at launch (so it is usable before the
 * client is ready); this hook relabels it in the active language.
 *
 * No-op outside the Tauri runtime (browser / jsdom tests) and swallows invoke
 * failures so a missing/older `set_tray_labels` command never breaks the app.
 */
export function useTrayLabels(): void {
  const { t } = useTranslation('mcp')
  // Re-fire on explicit language switches. `useTranslation` already re-renders on
  // `i18n.changeLanguage`, but reading the context id makes the dependency
  // explicit and keeps the effect in sync with the persisted language.
  const lang = useLanguageOptional()?.languageId

  useEffect(() => {
    if (!isTauriRuntime()) return
    // The Rust command takes (open, exit) — the tray menu has Open + Exit only.
    void invoke('set_tray_labels', {
      open: t('tray.open'),
      exit: t('tray.exit'),
    }).catch(() => {
      /* command not registered (older host) or transient failure — ignore */
    })
  }, [t, lang])
}
