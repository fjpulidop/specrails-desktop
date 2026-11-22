import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { RepositoryValidationError } from './project-repositories'

const execFileAsync = promisify(execFile)

/** Only GitHub repository identities, never arbitrary Git transports or credentials. */
export function githubCloneUrl(value: unknown): string {
  if (typeof value !== 'string') throw new RepositoryValidationError('Enter a GitHub repository URL')
  const input = value.trim()
  const match = /^(?:(https:\/\/github\.com\/)|(git@github\.com:)|(ssh:\/\/git@github\.com\/))?([\w-]+)\/([\w.-]+?)\/?$/.exec(input)
  if (!match) throw new RepositoryValidationError('Use https://github.com/owner/repo or git@github.com:owner/repo')
  const repo = match[5].replace(/\.git$/, '')
  if (!repo || repo === '.' || repo === '..') throw new RepositoryValidationError('Invalid GitHub repository name')
  return match[2] || match[3] ? `git@github.com:${match[4]}/${repo}.git` : `https://github.com/${match[4]}/${repo}.git`
}

export interface CloneProgress {
  phase: 'counting' | 'compressing' | 'receiving' | 'resolving' | 'checkout'
  percent: number
}

const PROGRESS_PHASES: Record<string, CloneProgress['phase']> = {
  'enumerating objects': 'counting', 'counting objects': 'counting', 'compressing objects': 'compressing',
  'receiving objects': 'receiving', 'resolving deltas': 'resolving', 'updating files': 'checkout',
}

/**
 * One line of `git clone --progress` stderr → its phase and percent, or null.
 * Only these two values ever leave the process: the rest of Git's output may
 * carry credential-helper text.
 */
export function parseCloneProgress(line: string): CloneProgress | null {
  const match = /^(?:remote:\s*)?([A-Za-z ]+?):\s+(\d{1,3})%/.exec(line.trim())
  if (!match) return null
  const phase = PROGRESS_PHASES[match[1].toLowerCase()]
  const percent = Number(match[2])
  return phase && percent <= 100 ? { phase, percent } : null
}

type CloneRunner = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; signal?: AbortSignal }) => Promise<unknown>

/** `git clone --progress`, reporting parsed progress lines; output is otherwise discarded. */
function progressRunner(onProgress: (progress: CloneProgress) => void): CloneRunner {
  return (file, args, options) => new Promise<void>((resolve, reject) => {
    const child = spawn(file, [...args.slice(0, -3), '--progress', ...args.slice(-3)], { env: options.env, signal: options.signal, stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout)
    let pending = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/[\r\n]/)
      pending = (lines.pop() ?? '').slice(-4096)
      for (const line of lines) {
        const progress = parseCloneProgress(line)
        if (progress) { try { onProgress(progress) } catch { /* a listener never breaks the clone */ } }
      }
    })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`git clone exited with ${code}`)) })
  })
}

export async function cloneGithubRepository(
  input: { url?: unknown; destination?: unknown },
  isPathSafe: (value: string) => boolean,
  signal?: AbortSignal,
  run: CloneRunner = execFileAsync,
  onProgress?: (progress: CloneProgress) => void,
): Promise<string> {
  if (onProgress && run === execFileAsync) run = progressRunner(onProgress)
  const url = githubCloneUrl(input.url)
  if (typeof input.destination !== 'string' || !path.isAbsolute(input.destination.trim())) {
    throw new RepositoryValidationError('Choose an absolute destination path for the new repository folder')
  }
  const requested = path.resolve(input.destination.trim())
  let parent: string
  try { parent = await fs.realpath(path.dirname(requested)) } catch {
    throw new RepositoryValidationError('The destination parent folder must already exist')
  }
  const destination = path.join(parent, path.basename(requested))
  if (!isPathSafe(destination)) throw new RepositoryValidationError('Cloning into system directories is not allowed')
  // Atomic reservation: never reuse or overwrite even an empty existing folder.
  try { await fs.mkdir(destination) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new RepositoryValidationError('The destination already exists. Choose a new folder.', 'clone_destination_exists', 409)
    throw new RepositoryValidationError('Cannot create the destination folder')
  }
  try {
    await run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--', url, destination], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' },
      timeout: 300_000, maxBuffer: 1024 * 1024, signal,
    })
    return destination
  } catch {
    await fs.rm(destination, { recursive: true, force: true })
    // Git output may contain credential-helper output. Never expose it in HTTP/logs.
    throw new RepositoryValidationError('Clone failed or timed out. Check the repository, network and Git credentials on this computer, then retry.', 'clone_failed', 502)
  }
}
