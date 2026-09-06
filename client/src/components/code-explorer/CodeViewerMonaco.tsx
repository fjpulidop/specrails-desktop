import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { useTranslation } from 'react-i18next'
import { useActiveTheme } from '../../context/ThemeContext'
import { ensureMonacoEnvironment, defineMonacoThemeFor } from '../../lib/monaco-setup'

export interface CodeViewerMonacoProps {
  content: string
  language: string
  initialLine?: number
}

/** Source exploration only: model edits and server writes are never enabled. */
export function CodeViewerMonaco({ content, language, initialLine }: CodeViewerMonacoProps) {
  const { t } = useTranslation('code')
  const theme = useActiveTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [loadRevision, setLoadRevision] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [lineInput, setLineInput] = useState('')
  const current = useRef({ content, language, theme, initialLine, wrap })
  current.current = { content, language, theme, initialLine, wrap }

  const reveal = (requested: number | undefined, focus = false) => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !Number.isFinite(requested) || requested! < 1) return
    const line = Math.min(model.getLineCount(), Math.max(1, Math.floor(requested!)))
    editor.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) })
    editor.revealLineInCenter(line)
    if (focus) editor.focus()
  }

  useEffect(() => {
    let disposed = false
    setReady(false); setLoadError(false)
    ensureMonacoEnvironment()
    void import('monaco-editor').then((monaco) => {
      if (disposed || !hostRef.current) return
      monacoRef.current = monaco
      const values = current.current
      const editor = monaco.editor.create(hostRef.current, {
        value: values.content,
        language: values.language,
        readOnly: true,
        domReadOnly: true,
        theme: defineMonacoThemeFor(monaco, values.theme),
        minimap: { enabled: false },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderValidationDecorations: 'off',
        wordWrap: values.wrap ? 'on' : 'off',
        fontSize: 13,
      })
      editorRef.current = editor
      reveal(values.initialLine)
      setReady(true)
    }).catch(() => { if (!disposed) setLoadError(true) })
    return () => {
      disposed = true
      const model = editorRef.current?.getModel()
      editorRef.current?.dispose()
      model?.dispose()
      editorRef.current = null
      monacoRef.current = null
    }
  }, [loadRevision])

  useEffect(() => {
    const editor = editorRef.current
    if (editor && editor.getValue() !== content) editor.setValue(content)
  }, [content])
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model && monacoRef.current) monacoRef.current.editor.setModelLanguage(model, language)
  }, [language])
  useEffect(() => {
    const monaco = monacoRef.current
    if (monaco) monaco.editor.setTheme(defineMonacoThemeFor(monaco, theme))
  }, [theme])
  useEffect(() => { reveal(initialLine) }, [initialLine, ready])
  useEffect(() => { editorRef.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off' }) }, [wrap])

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-3 py-1 text-xs">
      <button type="button" disabled={!ready} className="rounded px-2 py-1 hover:bg-muted disabled:opacity-50" onClick={() => { void editorRef.current?.getAction('actions.find')?.run() }}>{t('reader.find', { defaultValue: 'Find in file' })}</button>
      <button type="button" disabled={!ready} aria-pressed={wrap} className="rounded px-2 py-1 hover:bg-muted disabled:opacity-50" onClick={() => setWrap((value) => !value)}>{t('reader.wrap', { defaultValue: 'Wrap lines' })}</button>
      <form className="ml-auto flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); reveal(Number(lineInput), true) }}>
        <input type="number" min={1} step={1} aria-label={t('reader.line', { defaultValue: 'Line number' })} placeholder="#" title={t('reader.line', { defaultValue: 'Line number' })} value={lineInput} onChange={(event) => setLineInput(event.target.value)} className="w-28 rounded border border-border bg-background px-2 py-1" />
        <button type="submit" disabled={!ready || !Number.isInteger(Number(lineInput)) || Number(lineInput) < 1} className="rounded px-2 py-1 hover:bg-muted disabled:opacity-50">{t('reader.go', { defaultValue: 'Go' })}</button>
      </form>
    </div>
    {loadError ? <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="monaco-load-error">
      <span>{t('monaco.loadFailed')}</span>
      <button onClick={() => setLoadRevision((value) => value + 1)} className="rounded border px-3 py-1">{t('reader.retry', { defaultValue: 'Retry' })}</button>
    </div> : <div className="relative min-h-0 flex-1">
      {!ready && <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{t('reader.loading', { defaultValue: 'Loading source viewer…' })}</div>}
      <div ref={hostRef} className="h-full w-full" data-testid="monaco-host" />
    </div>}
  </div>
}

export default CodeViewerMonaco
