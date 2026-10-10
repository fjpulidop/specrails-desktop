param([Parameter(Mandatory=$true)][string]$BundlePath)
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path $BundlePath).Path
$script = Join-Path $PSScriptRoot 'smoke-installed-windows.mjs'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('Specrails Installer Smoke ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
# Tauri records the install directory under Software\<manufacturer>\<product>,
# and the silent NSIS uninstaller keeps that key (it only removes it when the
# user opts to delete app data). Start from a clean registry, as on a fresh
# machine, so the requested /D directory is the one under test.
$conf = Get-Content (Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$manufacturer = if ($conf.bundle.publisher) { $conf.bundle.publisher } else { ($conf.identifier -split '\.')[1] }
$productKey = "Software\$manufacturer\$($conf.productName)"
function Clear-InstallerRegistry {
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $key = Join-Path $hive $productKey
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
function Write-InstallerDiagnostics([string]$installDir) {
  Write-Host '--- NSIS diagnostics ---'
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $key = Join-Path $hive $productKey
    if (Test-Path $key) { Write-Host "$key => $((Get-ItemProperty $key | Out-String).Trim())" } else { Write-Host "$key absent" }
  }
  foreach ($root in @($testRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if ($root -and (Test-Path $root)) { Get-ChildItem -Path $root -Recurse -Filter 'specrails-desktop.exe' -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  found: $($_.FullName)" } }
  }
}
try {
  # Windows ships only the NSIS installer; an MSI would mean a stale bundle target.
  if (Test-Path (Join-Path $bundle 'msi')) { throw 'Unexpected MSI bundle: Windows releases ship only the NSIS installer' }
  $installers = @(Get-ChildItem (Join-Path $bundle 'nsis') -Filter '*.exe')
  if ($installers.Count -ne 1) { throw "Expected exactly one NSIS installer, got $($installers.Count)" }
  $installer = $installers[0].FullName
  $installDir = Join-Path $testRoot 'nsis install with spaces'
  $installed = $false
  Clear-InstallerRegistry
  try {
    # NSIS /D must be last and intentionally unquoted (it consumes the remainder).
    $p = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDir" -Wait -PassThru
    if ($p.ExitCode -notin @(0, 3010)) { Write-InstallerDiagnostics $installDir; throw "NSIS installation failed with $($p.ExitCode)" }
    $installed = $true
    if (-not (Test-Path (Join-Path $installDir 'specrails-desktop.exe'))) { Write-InstallerDiagnostics $installDir; throw 'NSIS app executable is missing' }
    $node = Join-Path $installDir 'runtimes\node\node.exe'
    # Use the installed Node, not the runner's Node. JS imports only smoke-driver ws from checkout.
    & $node $script $installDir
    if ($LASTEXITCODE -ne 0) { throw 'NSIS installed runtime smoke failed' }
  } finally {
    if ($installed) {
      $uninstaller = Join-Path $installDir 'uninstall.exe'
      if (-not (Test-Path $uninstaller)) { throw 'Installed NSIS uninstaller is missing' }
      # `_?=` makes the silent uninstaller run in place instead of re-launching
      # a copy from TEMP and returning early, so -Wait really waits.
      $uninstallResult = Start-Process $uninstaller -ArgumentList "/S _?=$installDir" -Wait -PassThru
      if ($uninstallResult.ExitCode -notin @(0, 3010)) { throw "NSIS uninstall failed with $($uninstallResult.ExitCode)" }
      Clear-InstallerRegistry
    }
  }
} finally {
  if (Test-Path $testRoot) { Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue }
}
