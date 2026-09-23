import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import type { ThemeDescriptor } from '../../settings/lib/themes'

let installed = false

// ─── HSL → hex conversion (Monaco only accepts #RRGGBB) ────────────────────

function parseHsl(s: string): [number, number, number] | null {
  // Accepts "hsl(154 30% 5%)" or "hsl(154, 30%, 5%)"; case-insensitive.
  const m = s.trim().match(/^hsl\(\s*([-\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i)
  if (!m) return null
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]
}

function hslToHex(s: string, fallback = '#1e1e1e'): string {
  if (s.startsWith('#')) return s
  const parsed = parseHsl(s)
  if (!parsed) return fallback
  const [h, sPct, lPct] = parsed
  const sat = sPct / 100
  const light = lPct / 100
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0, g = 0, b = 0
  if (hp < 1) { r = c; g = x }
  else if (hp < 2) { r = x; g = c }
  else if (hp < 3) { g = c; b = x }
  else if (hp < 4) { g = x; b = c }
  else if (hp < 5) { r = x; b = c }
  else { r = c; b = x }
  const m = light - c / 2
  const to2 = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

export function monacoThemeNameFor(themeId: string): string {
  return `specrails-${themeId}`
}

/**
 * Register a Monaco theme that mirrors the active app theme's palette.
 * Backgrounds and token colours come from the xterm palette so the editor
 * blends with the rest of the UI (terminal, dashboards, sidebar).
 * Returns the theme name to pass to `monaco.editor.setTheme(...)`.
 */
export function defineMonacoThemeFor(
  monaco: typeof import('monaco-editor'),
  theme: ThemeDescriptor,
): string {
  const name = monacoThemeNameFor(theme.id)
  const x = theme.xterm
  const bg = hslToHex(x.background)
  const fg = hslToHex(x.foreground)
  const muted = hslToHex(x.brightBlack)
  const keyword = hslToHex(x.magenta)
  const str = hslToHex(x.yellow)
  const num = hslToHex(x.cyan)
  const fn = hslToHex(x.blue)
  const type = hslToHex(x.green)
  const comment = hslToHex(x.brightBlack)
  const constant = hslToHex(x.brightCyan)
  const tag = hslToHex(x.red)
  const selection = hslToHex(x.selectionBackground)

  monaco.editor.defineTheme(name, {
    base: theme.scheme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: fg.slice(1) },
      { token: 'comment', foreground: comment.slice(1), fontStyle: 'italic' },
      { token: 'keyword', foreground: keyword.slice(1) },
      { token: 'string', foreground: str.slice(1) },
      { token: 'number', foreground: num.slice(1) },
      { token: 'constant', foreground: constant.slice(1) },
      { token: 'constant.numeric', foreground: num.slice(1) },
      { token: 'type', foreground: type.slice(1) },
      { token: 'type.identifier', foreground: type.slice(1) },
      { token: 'identifier', foreground: fg.slice(1) },
      { token: 'function', foreground: fn.slice(1) },
      { token: 'tag', foreground: tag.slice(1) },
      { token: 'attribute.name', foreground: constant.slice(1) },
      { token: 'attribute.value', foreground: str.slice(1) },
      { token: 'delimiter', foreground: muted.slice(1) },
      { token: 'operator', foreground: muted.slice(1) },
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': fg,
      'editorCursor.foreground': hslToHex(x.cursor),
      'editor.selectionBackground': selection,
      'editor.inactiveSelectionBackground': selection,
      'editor.lineHighlightBackground': hslToHex(x.black),
      'editor.lineHighlightBorder': hslToHex(x.black),
      'editorGutter.background': bg,
      'editorWhitespace.foreground': muted,
      'editorIndentGuide.background1': hslToHex(x.black),
      'editorIndentGuide.activeBackground1': muted,
      'scrollbarSlider.background': `${muted}55`,
      'scrollbarSlider.hoverBackground': `${muted}88`,
      'scrollbarSlider.activeBackground': `${muted}bb`,
      'minimap.background': bg,
    },
  })
  return name
}

export function ensureMonacoEnvironment(): void {
  if (installed) return
  ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new JsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker()
        case 'typescript':
        case 'javascript':
          return new TsWorker()
        default:
          return new EditorWorker()
      }
    },
  }
  installed = true
}
