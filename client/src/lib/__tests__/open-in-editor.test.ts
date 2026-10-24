import { beforeEach, describe, expect, it, vi } from 'vitest'

const openExternalUrl = vi.fn(async () => {})
vi.mock('../tauri-shell', () => ({ openExternalUrl: (url: string) => openExternalUrl(url) }))

import { buildEditorUrl, DEFAULT_EDITOR, getEditorPref, joinProjectPath, openInEditor, setEditorPref } from '../open-in-editor'

beforeEach(() => { localStorage.clear(); openExternalUrl.mockClear() })

describe('buildEditorUrl', () => {
  it('builds VS Code and Cursor file URLs with an optional line', () => {
    expect(buildEditorUrl('vscode', '/Users/me/app/src/a.ts', 12)).toBe('vscode://file/Users/me/app/src/a.ts:12')
    expect(buildEditorUrl('cursor', '/Users/me/app/src/a.ts')).toBe('cursor://file/Users/me/app/src/a.ts')
    expect(buildEditorUrl('vscode', '/x/a.ts', 0)).toBe('vscode://file/x/a.ts')
  })

  it('encodes awkward characters per segment and keeps the Windows drive colon', () => {
    expect(buildEditorUrl('vscode', '/Users/me/My App/a b#1.ts', 3)).toBe('vscode://file/Users/me/My%20App/a%20b%231.ts:3')
    expect(buildEditorUrl('vscode', 'C:\\Users\\me\\app\\a.ts', 7)).toBe('vscode://file/C:/Users/me/app/a.ts:7')
  })

  it('builds the JetBrains URL with the whole path encoded', () => {
    expect(buildEditorUrl('jetbrains', '/Users/me/app/a.ts', 5)).toBe('idea://open?file=%2FUsers%2Fme%2Fapp%2Fa.ts&line=5')
    expect(buildEditorUrl('jetbrains', '/Users/me/app/a.ts')).toBe('idea://open?file=%2FUsers%2Fme%2Fapp%2Fa.ts')
  })

  it('joins the checkout root and a repository-relative path', () => {
    expect(joinProjectPath('/repo/', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(joinProjectPath('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts')
  })
})

describe('editor preference', () => {
  it('defaults to VS Code, persists the choice and ignores junk', () => {
    expect(getEditorPref()).toBe(DEFAULT_EDITOR)
    setEditorPref('cursor')
    expect(getEditorPref()).toBe('cursor')
    localStorage.setItem('specrails-desktop:editor', 'emacs')
    expect(getEditorPref()).toBe(DEFAULT_EDITOR)
  })

  it('hands the URL to the shell opener', async () => {
    await openInEditor('vscode', '/r/a.ts', 4)
    expect(openExternalUrl).toHaveBeenCalledWith('vscode://file/r/a.ts:4')
  })
})
