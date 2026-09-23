import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useLanguageOptional } from '../../context/LanguageContext'
import { LANGUAGE_IDS, LANGUAGES, type LanguageId } from '../../../../lib/i18n'

/**
 * Language card grid shared by the Settings Language section and the
 * onboarding wizard. One card per supported language — rendered from the
 * `LANGUAGE_IDS` registry so adding a language requires zero changes here.
 * Click applies hot (no restart) and persists to the server; failure reverts
 * to the previously active language.
 */
export function LanguagePickerGrid() {
  const { t } = useTranslation('settings')
  const ctx = useLanguageOptional()
  // No provider mounted — graceful no-op (unit tests rendering the host
  // surface in isolation).
  if (!ctx) return null
  const { languageId, setLanguage, isUpdating } = ctx

  async function handleSelect(id: LanguageId): Promise<void> {
    if (id === languageId) return
    try {
      await setLanguage(id)
    } catch (err) {
      toast.error(t('language.updateFailed'), {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  return (
    <div
      className="grid grid-cols-2 sm:grid-cols-4 gap-2"
      role="radiogroup"
      aria-label={t('language.selectLabel')}
    >
      {LANGUAGE_IDS.map((id) => {
        const lang = LANGUAGES[id]
        const selected = id === languageId
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={isUpdating}
            onClick={() => void handleSelect(id)}
            className={
              'flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-all ' +
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 ' +
              'disabled:opacity-60 disabled:cursor-not-allowed ' +
              (selected
                ? 'border-accent-primary ring-1 ring-accent-primary '
                : 'border-border hover:border-accent-primary/40 hover:shadow-md ')
            }
            data-testid={`language-card-${id}`}
            data-selected={selected ? 'true' : 'false'}
          >
            <span className="min-w-0">
              <span className="block text-xs font-semibold truncate">{lang.nativeName}</span>
              <span className="block text-[10px] text-muted-foreground truncate">
                {lang.englishName}
              </span>
            </span>
            {selected && <Check className="w-3.5 h-3.5 text-accent-primary shrink-0" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}
