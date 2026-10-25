import fs from 'fs'
import os from 'os'
import path from 'path'
import { defaultGitRunner, type GitRunner } from '../../../worktree-manager'
import { mutateStore, resolveTicketStoragePath, type Ticket } from '../../specs/runtime/ticket-store'
import { SAMPLE_SETTING_KEY, type SampleDefinition, type SampleLocale, type SampleRecord } from '../domain'
import type { SampleFilesPort, SampleGitPort, SampleSpecsPort, SampleStatePort } from '../ports'

/** Filesystem adapter (real disk; `home` is injectable for tests). */
export function createSampleFiles(home: () => string = os.homedir): SampleFilesPort {
  const resolve = (target: string): string => {
    const absolute = path.resolve(target)
    try { return fs.realpathSync(absolute) } catch {
      // A path that does not exist yet: resolve its nearest existing ancestor so
      // a symlinked parent (macOS /var -> /private/var) compares like the home dir.
      const parent = path.dirname(absolute)
      if (parent === absolute) return absolute
      return path.join(resolve(parent), path.basename(absolute))
    }
  }
  return {
    homeDir: () => home(),
    join: (...parts) => path.join(...parts),
    sep: path.sep,
    resolve,
    exists: (target) => fs.existsSync(target),
    writeTree(root, files) {
      for (const [relative, content] of Object.entries(files)) {
        const file = path.join(root, ...relative.split('/'))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, content, 'utf-8')
      }
    },
    remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
    isGitRepo: (target) => fs.existsSync(path.join(target, '.git')),
  }
}

/** git adapter: `init -b main` + one commit with a fixed, machine-independent identity. */
export function createSampleGit(git: GitRunner = defaultGitRunner): SampleGitPort {
  const identity = ['-c', 'user.name=Specrails Sample', '-c', 'user.email=sample@specrails.invalid', '-c', 'commit.gpgsign=false']
  const must = async (args: string[], cwd: string): Promise<void> => {
    const result = await git.run(args, cwd)
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim())
  }
  return {
    async initWithCommit(dir, message) {
      await must(['init', '-b', 'main'], dir)
      await must(['add', '-A'], dir)
      await must([...identity, 'commit', '-m', message], dir)
    },
  }
}

/** Specs adapter: writes the project's own ticket store (the board reads it). */
export function createSampleSpecs(now: () => Date = () => new Date()): SampleSpecsPort {
  return {
    install(dir, sample: SampleDefinition, locale: SampleLocale) {
      const ids: number[] = []
      const stamp = now().toISOString()
      mutateStore(resolveTicketStoragePath(dir), (store) => {
        for (const spec of sample.specs) {
          const text = spec.text[locale] ?? spec.text.en
          const id = store.next_id++
          const ticket: Ticket = {
            id,
            title: text.title,
            description: text.description,
            status: 'todo',
            priority: spec.priority,
            labels: [...spec.labels],
            assignee: null,
            prerequisites: [],
            metadata: { effort_level: spec.effort, area: sample.id },
            comments: [],
            origin_conversation_id: null,
            is_epic: false,
            parent_epic_id: null,
            execution_order: null,
            short_summary: text.summary,
            created_at: stamp,
            updated_at: stamp,
            created_by: 'specrails',
            source: 'manual',
          }
          store.tickets[String(id)] = ticket
          ids.push(id)
        }
      })
      return ids
    },
  }
}

interface SettingsDb {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/** App-wide record in desktop_settings (one sample at a time). */
export function createSampleState(settings: SettingsDb): SampleStatePort {
  return {
    read() {
      const raw = settings.get(SAMPLE_SETTING_KEY)
      if (!raw) return null
      try {
        const value = JSON.parse(raw) as Partial<SampleRecord>
        if (typeof value.projectId !== 'string' || typeof value.path !== 'string' || typeof value.sampleId !== 'string') return null
        return {
          sampleId: value.sampleId,
          projectId: value.projectId,
          path: value.path,
          specIds: Array.isArray(value.specIds) ? value.specIds.filter((id): id is number => typeof id === 'number') : [],
          createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
        }
      } catch { return null }
    },
    write: (record) => settings.set(SAMPLE_SETTING_KEY, JSON.stringify(record)),
    clear: () => settings.set(SAMPLE_SETTING_KEY, ''),
  }
}
