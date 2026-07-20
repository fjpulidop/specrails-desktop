# Windows CI smoke for the bundled-core relocate-artifacts framework path.
#
# Validates — against the SHIPPED bundled core (src-tauri/core) — the Windows
# specifics that the macOS smoke can't catch:
#   1. install-framework --no-swap materializes a providerDir WITHOUT moving
#      `current` (materialize-all-then-swap-once).
#   2. swap-current finalises: `current` resolves to the version (junction OR
#      Windows copy-fallback — readCurrentFrameworkVersion handles both).
#   3. assemble links the provider subtrees into a workspace: commands/skills/
#      rules land as dir JUNCTIONS, agents land via the COPY-FALLBACK (file
#      symlinks need admin on Windows; core falls back to copying). Each must
#      have content.
#   4. REAL provider discovery: all four providers (claude + codex + gemini +
#      kimi) materialize +
#      assemble independently into the same framework/workspace.
#
# Run with the BUNDLED node (no system node/git on PATH) to prove the tree is
# self-contained. Usage (from repo root):
#   pwsh scripts/smoke-bundled-core-windows.ps1 [-CorePath src-tauri\core] [-Node src-tauri\runtimes\node\node.exe]

param(
  [string]$CorePath = "src-tauri\core",
  [string]$Node = "src-tauri\runtimes\node\node.exe"
)

$ErrorActionPreference = "Stop"

$cli = Join-Path $CorePath "dist\installer\cli.js"
if (-not (Test-Path $cli)) { Write-Error "bundled core CLI not found at $cli"; exit 1 }
if (-not (Test-Path $Node)) {
  # Fall back to system node when the bundled runtime isn't staged (e.g. a
  # runtimes-less build). The bundled-core path still works with any node.
  $Node = "node"
}

$version = (Get-Content (Join-Path $CorePath "package.json") -Raw | ConvertFrom-Json).version
Write-Host "Bundled core version: $version"

$work = Join-Path $env:TEMP ("smoke-core-" + [guid]::NewGuid())
$fwDir = Join-Path $work "framework"
$repo  = Join-Path $work "repo"
$ws    = Join-Path $work "workspace"
New-Item -ItemType Directory -Path $fwDir, $repo, $ws | Out-Null

# Point core's scriptDir at the bundled package so template/command sources resolve.
$env:SPECRAILS_CORE_SCRIPT_DIR = (Resolve-Path $CorePath).Path

function Invoke-Core {
  param([string[]]$CoreArgs)
  & $Node $cli @CoreArgs
  if ($LASTEXITCODE -ne 0) { Write-Error "core $($CoreArgs -join ' ') failed ($LASTEXITCODE)"; exit 1 }
}

$providers = @("claude", "codex", "gemini", "kimi")

# 1. Materialize every provider WITHOUT swapping current.
foreach ($p in $providers) {
  Invoke-Core @("install-framework", "--framework-dir", $fwDir, "--provider", $p, "--version", $version, "--no-swap")
}

# --no-swap means current must NOT exist yet.
if (Test-Path (Join-Path $fwDir "current")) {
  Write-Error "current was created despite --no-swap"; exit 1
}

# 2. Swap current ONCE.
Invoke-Core @("swap-current", "--framework-dir", $fwDir, "--version", $version)
$current = Join-Path $fwDir "current"
if (-not (Test-Path $current)) { Write-Error "current not created after swap-current"; exit 1 }
Write-Host "current → $version OK"

# 3 + 4. Assemble a workspace per provider + validate the linked subtrees.
$providerDirs = @{
  "claude" = ".claude"
  "codex" = ".codex"
  "gemini" = ".gemini"
  "kimi" = ".kimi-code"
}
$linkedByProvider = @{
  "claude" = @("agents", "commands", "skills", "rules")
  "codex" = @("skills")
  "gemini" = @("agents", "commands")
  # Kimi keeps the skills root real so OpenSpec and custom roles can coexist;
  # Core links framework-owned children within it. Rules remains a whole-dir
  # framework link and therefore exercises the junction/copy path here.
  "kimi" = @("rules")
}

foreach ($p in $providers) {
  Invoke-Core @("assemble", "--workspace", $ws, "--framework-dir", $fwDir, "--provider", $p, "--version", $version, "--code-root", $repo)
  $pd = Join-Path $ws $providerDirs[$p]
  foreach ($sub in $linkedByProvider[$p]) {
    $subPath = Join-Path $pd $sub
    if (-not (Test-Path $subPath)) { Write-Error "$p assemble: missing $sub at $subPath"; exit 1 }
    $count = (Get-ChildItem -Path $subPath -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($count -lt 1) { Write-Error "$p assemble: $sub has no content"; exit 1 }
    $item = Get-Item $subPath
    $isJunction = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    Write-Host ("  {0}/{1}: {2} file(s){3}" -f $providerDirs[$p], $sub, $count, $(if ($isJunction) { " (junction)" } else { " (copy)" }))
  }
  if ($p -eq "kimi") {
    $skills = Join-Path $pd "skills"
    if (-not (Test-Path $skills)) { Write-Error "kimi assemble: missing real skills root at $skills"; exit 1 }
    # Framework-owned direct children are directory junctions on Windows.
    # PowerShell does not recurse through reparse points unless explicitly told
    # to follow them, which would report a false zero despite valid skills.
    $skillCount = (Get-ChildItem -Path $skills -Recurse -FollowSymlink -Filter "SKILL.md" -File -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($skillCount -lt 1) { Write-Error "kimi assemble: skills has no SKILL.md content"; exit 1 }
    $directRole = Join-Path $skills "sr-architect\SKILL.md"
    if (-not (Test-Path $directRole)) {
      Write-Error "kimi assemble: missing directly discoverable role at $directRole"; exit 1
    }
    $legacyNestedRole = Join-Path $skills "rails\sr-architect\SKILL.md"
    if (Test-Path $legacyNestedRole) {
      Write-Error "kimi assemble: role remained in undiscoverable legacy nested layout at $legacyNestedRole"; exit 1
    }
    $skillsItem = Get-Item $skills
    if (($skillsItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Write-Error "kimi assemble: skills root must remain a real dir, not a junction"; exit 1
    }
    Write-Host ("  {0}/skills: {1} SKILL.md file(s) (real merged root)" -f $providerDirs[$p], $skillCount)
  }
  # agent-memory is a REAL writable dir, never a reparse point.
  $mem = Join-Path $pd "agent-memory"
  if (Test-Path $mem) {
    $memItem = Get-Item $mem
    if (($memItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Write-Error "$p assemble: agent-memory must be a real dir, not a junction"; exit 1
    }
  }
  # The workspace version marker (the relocation gate) must be a real file.
  $marker = Join-Path $ws ".specrails\specrails-version"
  if (-not (Test-Path $marker)) { Write-Error "$p assemble: missing .specrails\specrails-version marker"; exit 1 }
}

Remove-Item -Recurse -Force $work
Write-Host "Windows bundled-core relocate smoke PASSED."
