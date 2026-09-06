param([Parameter(Mandatory=$true)][string]$BundlePath)
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path $BundlePath).Path
$script = Join-Path $PSScriptRoot 'smoke-installed-windows.mjs'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('Specrails Installer Smoke ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  foreach ($kind in @('nsis', 'msi')) {
    $extension = if ($kind -eq 'nsis') { '*.exe' } else { '*.msi' }
    $installers = @(Get-ChildItem (Join-Path $bundle $kind) -Filter $extension)
    if ($installers.Count -ne 1) { throw "Expected exactly one $kind installer, got $($installers.Count)" }
    $installer = $installers[0].FullName
    $installDir = Join-Path $testRoot "$kind install with spaces"
    $installed = $false
    try {
      if ($kind -eq 'nsis') {
        # NSIS /D must be last and intentionally unquoted (it consumes the remainder).
        $p = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDir" -Wait -PassThru
      } else {
        $p = Start-Process msiexec.exe -ArgumentList "/i `"$installer`" /qn /norestart INSTALLDIR=`"$installDir`" /l*v `"$testRoot\msi-install.log`"" -Wait -PassThru
      }
      if ($p.ExitCode -notin @(0, 3010)) { throw "$kind installation failed with $($p.ExitCode)" }
      $installed = $true
      if (-not (Test-Path (Join-Path $installDir 'specrails-desktop.exe'))) { throw "$kind app executable is missing" }
      $node = Join-Path $installDir 'runtimes\node\node.exe'
      # Use the installed Node, not the runner's Node. JS imports only smoke-driver ws from checkout.
      & $node $script $installDir
      if ($LASTEXITCODE -ne 0) { throw "$kind installed runtime smoke failed" }
    } finally {
      if ($installed) {
        if ($kind -eq 'nsis') {
          $uninstaller = Join-Path $installDir 'uninstall.exe'
          if (-not (Test-Path $uninstaller)) { throw 'Installed NSIS uninstaller is missing' }
          $uninstallResult = Start-Process $uninstaller -ArgumentList '/S' -Wait -PassThru
        } else {
          $uninstallResult = Start-Process msiexec.exe -ArgumentList "/x `"$installer`" /qn /norestart" -Wait -PassThru
        }
        if ($uninstallResult.ExitCode -notin @(0, 3010)) { throw "$kind uninstall failed with $($uninstallResult.ExitCode)" }
      }
    }
  }
} finally {
  if (Test-Path $testRoot) { Remove-Item -Recurse -Force $testRoot -ErrorAction SilentlyContinue }
}
