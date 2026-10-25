import type { SampleDefinition, SampleLocale, SampleRecord } from './domain'

/** Filesystem effects the sample needs. */
export interface SampleFilesPort {
  homeDir(): string
  join(...parts: string[]): string
  readonly sep: string
  /** Absolute, symlink-resolved when it exists. */
  resolve(target: string): string
  exists(target: string): boolean
  /** Create the directory (recursively) and write every file under it. */
  writeTree(root: string, files: Record<string, string>): void
  remove(target: string): void
  isGitRepo(target: string): boolean
}

/** `git init` + an initial commit, whatever the machine's git identity. */
export interface SampleGitPort {
  initWithCommit(dir: string, message: string): Promise<void>
}

/** Installs the sample's specs in the project's own ticket store. */
export interface SampleSpecsPort {
  install(dir: string, sample: SampleDefinition, locale: SampleLocale): number[]
}

export interface SampleProjectRef {
  id: string
  name: string
  path: string
}

/** The project registry, narrowed to what the sample flow needs. */
export interface SampleProjectsPort {
  register(input: { path: string; name: string }): SampleProjectRef
  unregister(projectId: string): void
  isRegistered(projectId: string): boolean
  get(projectId: string): SampleProjectRef | null
}

/** Durable, app-wide record of the created sample (one at a time). */
export interface SampleStatePort {
  read(): SampleRecord | null
  write(record: SampleRecord): void
  clear(): void
}
