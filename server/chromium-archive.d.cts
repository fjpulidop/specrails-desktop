export interface ArchiveCommandOptions {
  timeout?: number
  maxBytes?: number
  env?: NodeJS.ProcessEnv
}
export interface ChromiumArchiveOptions {
  platform?: NodeJS.Platform
  run?: (binary: string, args: string[], options?: ArchiveCommandOptions) => Promise<string>
}
export function validateArchiveNames(listing: string, options?: { platform?: NodeJS.Platform }): void
export function validateWindowsArchiveTypes(listing: string): void
export function validateChromiumArchive(archivePath: string, options?: ChromiumArchiveOptions): Promise<void>
export function validateChromiumTree(root: string): void
