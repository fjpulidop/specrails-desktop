param([Parameter(Mandatory=$true)][string]$BundlePath)
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path $BundlePath).Path
$script = Join-Path $PSScriptRoot 'smoke-installed-windows.mjs'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('Specrails Installer Smoke ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
# Both Tauri installers record the install directory under
# Software\<manufacturer>\<product>. The MSI resolves INSTALLDIR from that
# key with a RegistrySearch, and an AppSearch result overrides the value
# given on the msiexec command line; the silent NSIS uninstaller keeps the key
# (it only removes it when the user opts to delete app data). Each installer
# must therefore start from a clean registry, as on a fresh machine.
$conf = Get-Content (Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$manufacturer = if ($conf.bundle.publisher) { $conf.bundle.publisher } else { ($conf.identifier -split '\.')[1] }
$productKey = "Software\$manufacturer\$($conf.productName)"
function Clear-InstallerRegistry {
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $key = Join-Path $hive $productKey
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
function Write-InstallerDiagnostics([string]$kind, [string]$installDir) {
  Write-Host "--- $kind diagnostics ---"
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $key = Join-Path $hive $productKey
    if (Test-Path $key) { Write-Host "$key => $((Get-ItemProperty $key | Out-String).Trim())" } else { Write-Host "$key absent" }
  }
  $msiLog = Join-Path $testRoot 'msi-install.log'
  if (Test-Path $msiLog) { Get-Content $msiLog | Select-String -Pattern 'INSTALLDIR|ARPINSTALLLOCATION|Return value 3|error' | Select-Object -First 20 | ForEach-Object { Write-Host "  msi: $($_.Line)" } }
  foreach ($root in @($testRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if ($root -and (Test-Path $root)) { Get-ChildItem -Path $root -Recurse -Filter 'specrails-desktop.exe' -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  found: $($_.FullName)" } }
  }
}
try {
  foreach ($kind in @('nsis', 'msi')) {
    $extension = if ($kind -eq 'nsis') { '*.exe' } else { '*.msi' }
    $installers = @(Get-ChildItem (Join-Path $bundle $kind) -Filter $extension)
    if ($installers.Count -ne 1) { throw "Expected exactly one $kind installer, got $($installers.Count)" }
    $installer = $installers[0].FullName
    $installDir = Join-Path $testRoot "$kind install with spaces"
    $installed = $false
    Clear-InstallerRegistry
    try {
      if ($kind -eq 'nsis') {
        # NSIS /D must be last and intentionally unquoted (it consumes the remainder).
        $p = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDir" -Wait -PassThru
      } else {
        $p = Start-Process msiexec.exe -ArgumentList "/i `"$installer`" /qn /norestart INSTALLDIR=`"$installDir`" /l*v `"$testRoot\msi-install.log`"" -Wait -PassThru
      }
      if ($p.ExitCode -notin @(0, 3010)) { throw "$kind installation failed with $($p.ExitCode)" }
      $installed = $true
      if (-not (Test-Path (Join-Path $installDir 'specrails-desktop.exe'))) { Write-InstallerDiagnostics $kind $installDir; throw "$kind app executable is missing" }
      $node = Join-Path $installDir 'runtimes\node\node.exe'
      # Use the installed Node, not the runner's Node. JS imports only smoke-driver ws from checkout.
      & $node $script $installDir
      if ($LASTEXITCODE -ne 0) { throw "$kind installed runtime smoke failed" }
    } finally {
      if ($installed) {
        if ($kind -eq 'nsis') {
          $uninstaller = Join-Path $installDir 'uninstall.exe'
          if (-not (Test-Path $uninstaller)) { throw 'Installed NSIS uninstaller is missing' }
          # `_?=` makes the silent uninstaller run in place instead of re-launching
          # a copy from TEMP and returning early, so -Wait really waits.
          $uninstallResult = Start-Process $uninstaller -ArgumentList "/S _?=$installDir" -Wait -PassThru
        } else {
          $uninstallResult = Start-Process msiexec.exe -ArgumentList "/x `"$installer`" /qn /norestart" -Wait -PassThru
        }
        if ($uninstallResult.ExitCode -notin @(0, 3010)) { throw "$kind uninstall failed with $($uninstallResult.ExitCode)" }
        Clear-InstallerRegistry
      }
    }
  }
} finally {
  if (Test-Path $testRoot) { Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue }
}
