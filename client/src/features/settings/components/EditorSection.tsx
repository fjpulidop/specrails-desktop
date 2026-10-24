import { useTranslation } from 'react-i18next'
import { DEFAULT_EDITOR, EDITOR_IDS, setEditorPref, useEditorPref, type EditorId } from '../../../lib/open-in-editor'
import { SettingsCard } from './SettingsCard'
import { SettingsSelect } from './SettingsSelect'

/**
 * Settings ▸ Code ▸ Editor: which editor "Open in editor" (review packet,
 * Changes tab) opens files in. Per machine, like the other viewer prefs.
 */
export function EditorSection() {
  const { t } = useTranslation('settings')
  const editor = useEditorPref()
  return (
    <SettingsCard title={t('editorSection.heading')} description={t('editorSection.description')} data-testid="editor-section">
      <div className="flex items-center justify-between gap-3 text-body">
        <span id="editor-choice-label" className="text-muted-foreground">{t('editorSection.label')}</span>
        <SettingsSelect
          value={editor}
          onChange={(value) => setEditorPref(EDITOR_IDS.includes(value as EditorId) ? (value as EditorId) : DEFAULT_EDITOR)}
          options={EDITOR_IDS.map((id) => ({ value: id, label: t(`editorSection.names.${id}`) }))}
          aria-labelledby="editor-choice-label"
          className="h-7 w-48 text-label"
          data-testid="editor-choice"
        />
      </div>
    </SettingsCard>
  )
}
