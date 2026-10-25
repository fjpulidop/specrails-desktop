import { useSyncExternalStore } from 'react'
import { openExternalUrl } from './tauri-shell'

/**
 * "Open in editor" for the review packet: builds the editor's URL scheme and
 * hands it to the shell. The choice is a per-machine preference (Settings ▸
 * Code), kept in localStorage like the other viewer preferences.
 */
export type EditorId = 'vscode' | 'cursor' | 'jetbrains'
export const EDITOR_IDS: readonly EditorId[] = ['vscode', 'cursor', 'jetbrains']
export const DEFAULT_EDITOR: EditorId = 'vscode'
export const EDITOR_PREF_KEY = 'specrails-desktop:editor'
const EDITOR_PREF_EVENT = 'specrails:editor-changed'

/** Absolute path with forward slashes and a leading slash (`/C:/x`, `/Users/x`). */
function urlPath(absolutePath: string): string {
  const forward = absolutePath.replace(/\\/g, '/')
  return forward.startsWith('/') ? forward : `/${forward}`
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':')

export function buildEditorUrl(editor: EditorId, absolutePath: string, line?: number | null): string {
  const target = line && Number.isInteger(line) && line > 0 ? line : null
  if (editor === 'jetbrains') {
    return `idea://open?file=${encodeURIComponent(absolutePath.replace(/\\/g, '/'))}${target ? `&line=${target}` : ''}`
  }
  const scheme = editor === 'cursor' ? 'cursor' : 'vscode'
  return `${scheme}://file${encodePath(urlPath(absolutePath))}${target ? `:${target}` : ''}`
}

/** `root` + a repository-relative path, joined with the separator `root` already uses. */
export function joinProjectPath(root: string, relative: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  return `${base}${separator}${relative.split('/').join(separator)}`
}

function readEditor(): EditorId {
  try {
    const raw = localStorage.getItem(EDITOR_PREF_KEY)
    return EDITOR_IDS.includes(raw as EditorId) ? (raw as EditorId) : DEFAULT_EDITOR
  } catch {
    return DEFAULT_EDITOR
  }
}

export function getEditorPref(): EditorId { return readEditor() }

export function setEditorPref(editor: EditorId): void {
  try { localStorage.setItem(EDITOR_PREF_KEY, editor) } catch { /* private mode etc. */ }
  try { window.dispatchEvent(new CustomEvent(EDITOR_PREF_EVENT)) } catch { /* non-DOM */ }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EDITOR_PREF_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => { window.removeEventListener(EDITOR_PREF_EVENT, onChange); window.removeEventListener('storage', onChange) }
}

export function useEditorPref(): EditorId {
  return useSyncExternalStore(subscribe, readEditor, () => DEFAULT_EDITOR)
}

/** Whether the editor's URL could be handed to the shell (false = nothing opened). */
export async function openInEditor(editor: EditorId, absolutePath: string, line?: number | null): Promise<boolean> {
  return openExternalUrl(buildEditorUrl(editor, absolutePath, line))
}
