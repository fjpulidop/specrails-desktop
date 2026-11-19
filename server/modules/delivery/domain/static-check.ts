/**
 * Whether a host-run verification command only reads file contents instead of
 * running the code: `grep` / `test -f` / `cat`, or an inline `python3 -c` /
 * `node -e` one-liner that opens a file and asserts on its text. Such a check
 * passing proves the text is there, not that the change works, so the review
 * packet labels it as a file-content check instead of a passed host command.
 * Pure; `commandLine` is the command and its arguments joined by spaces.
 */
const TEXT_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'test', '[', 'cat', 'head', 'tail', 'wc', 'ls', 'stat', 'diff', 'cmp', 'file', 'find'])
const INLINE: Record<string, readonly string[]> = {
  python: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], ruby: ['-e'], perl: ['-e', '-ne', '-ne'],
}
const FILE_READ = /\bopen\s*\(|read_text\s*\(|read_bytes\s*\(|readFileSync\s*\(|readFile\s*\(|File\.read\b|IO\.read\b|<\s*\$|slurp/
const RUNS_CODE = /\bsubprocess\b|\bspawn(Sync)?\s*\(|\bexec(Sync|File|FileSync)?\s*\(|\bsystem\s*\(|\bimport\s+(?!os\b|sys\b|re\b|json\b|pathlib\b|io\b)\w|\bfrom\s+(?!os\b|sys\b|re\b|json\b|pathlib\b|io\b)[\w.]+\s+import\b|\brequire\s*\(\s*['"]\.|\bawait\s+import\s*\(|\bimport\s*\(\s*['"]\./

export function isStaticFileCheck(commandLine: string | null | undefined): boolean {
  const text = (commandLine ?? '').trim()
  if (!text) return false
  const words = text.split(/\s+/)
  const tool = (words[0] ?? '').split('/').pop() ?? ''
  if (TEXT_TOOLS.has(tool)) return true
  const flags = INLINE[tool]
  if (!flags || !words.slice(1).some(word => flags.includes(word))) return false
  return FILE_READ.test(text) && !RUNS_CODE.test(text)
}
