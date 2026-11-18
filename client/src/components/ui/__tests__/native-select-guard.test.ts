import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard for the native `<select>` migration to the themed `ui/select` picker.
 *
 * Native selects open the OS menu, which ignores the app theme and density.
 * New code must use `components/ui/select`. The files below still carry a
 * native select and are migrated wave by wave; this list may only shrink:
 * a file not listed here fails the guard when it adds a native select, and a
 * listed file fails it once its native select is gone (prune it from the list).
 */
const ALLOWLIST: readonly string[] = [
  // Wave 2: agent profiles and routing
  'features/agents/components/ProfilesTab.tsx',
  'features/agents/components/ProfileEditor.tsx',
  'features/agents/components/RoutingRuleDialog.tsx',
  'features/agents/components/AgentRoleFields.tsx',
  'features/agents/components/AgentStudio.tsx',
  // Wave 2: loop editor
  'features/loops/components/CoreParameterForm.tsx',
  'features/loops/pages/LoopBuilderPage.tsx',
  'features/loops/components/LoopAgentsEditor.tsx',
  'features/loops/components/CoreWorkflowInspector.tsx',
  'features/loops/components/LegacyConversionModal.tsx',
  // Wave 3: specs
  'features/specs/components/explore-spec/SpecDraftPanel.tsx',
  'features/specs/components/SpecAddendaSection.tsx',
  'features/specs/components/RegressionOfPicker.tsx',
  // Wave 3: code, analytics, background processes, plugins
  'features/code/pages/CodePage.tsx',
  'features/code/components/code-explorer/CodeSearch.tsx',
  'features/code/components/code-explorer/CodeActivity.tsx',
  'features/analytics/components/InvocationsTable.tsx',
  'features/background/components/BackgroundProcessLogsModal.tsx',
  'features/plugins/pages/PluginsPage.tsx',
  // Project settings navigation
  'features/settings/pages/SettingsPage.tsx',
]

// client/src, resolved from this file (components/ui/__tests__).
const SRC_ROOT = resolve(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

/** Drops block, JSX and line comments so prose mentioning `<select>` does not count. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1')
}

const NATIVE_SELECT = /<select(?=[\s>/])/

function filesWithNativeSelect(): string[] {
  return sourceFiles(SRC_ROOT)
    .filter((file) => NATIVE_SELECT.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
    .sort()
}

describe('native <select> guard', () => {
  const found = filesWithNativeSelect()

  it('ignores mentions of <select> inside comments', () => {
    expect(stripComments('/** a native `<select>` */\nconst a = 1 // <select>\n{/* <select> */}')).not.toMatch(NATIVE_SELECT)
    expect(stripComments('const url = "http://x"; return <select value={v} />')).toMatch(NATIVE_SELECT)
  })

  it('allows no new native <select>: use components/ui/select', () => {
    const unexpected = found.filter((file) => !ALLOWLIST.includes(file))
    expect(unexpected, 'Use the themed picker from components/ui/select instead of a native <select>').toEqual([])
  })

  it('keeps the allowlist pruned: migrated files must leave it', () => {
    const stale = ALLOWLIST.filter((file) => !found.includes(file))
    expect(stale, 'These files no longer use a native <select>; remove them from ALLOWLIST').toEqual([])
  })
})
