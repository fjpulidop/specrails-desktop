# Runs one native WebView2 smoke fixture with its real exit code and captured
# output. Invoking the .exe directly from a pwsh step lost both: the four
# fixtures ended with a bare "exit code 1" and no stdout/stderr in the CI log,
# so nothing explained what died. Start-Process reports the process's own
# exit status (no shell remapping) and the redirected streams are echoed
# verbatim, together with the environment facts a native failure depends on.
param([Parameter(Mandatory = $true)][string]$Exe)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path $Exe).Path
$name = [System.IO.Path]::GetFileNameWithoutExtension($exe)
Write-Host "pwsh $($PSVersionTable.PSVersion); PSNativeCommandUseErrorActionPreference=$PSNativeCommandUseErrorActionPreference"

# PE subsystem: 2 = Windows GUI (no console streams at all), 3 = console.
$bytes = [System.IO.File]::ReadAllBytes($exe)
$peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
$subsystem = [System.BitConverter]::ToInt16($bytes, $peOffset + 24 + 68)
Write-Host "exe=$exe size=$($bytes.Length) subsystem=$subsystem"

$runtimeKeys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$runtimeFound = $false
foreach ($key in $runtimeKeys) {
  $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if ($item -and $item.pv) { Write-Host "WebView2 runtime ${key}: $($item.pv)"; $runtimeFound = $true }
}
foreach ($dir in @("${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application", "$env:ProgramFiles\Microsoft\EdgeWebView\Application")) {
  if ($dir -and (Test-Path $dir)) { Write-Host "EdgeWebView ${dir}: $((Get-ChildItem $dir -Directory | ForEach-Object Name) -join ', ')"; $runtimeFound = $true }
}
if (-not $runtimeFound) { Write-Host 'WebView2 runtime: not detected (Edge Stable is never used as a WebView2 runtime)' }

try {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -property installationPath
    $dumpbin = if ($vs) { Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Host*\*\dumpbin.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($dumpbin) {
      Write-Host 'DLL dependents:'
      & $dumpbin.FullName /nologo /dependents $exe | Where-Object { $_ -match '\.dll$' } | ForEach-Object { Write-Host "  $($_.Trim())" }
    }
  }
} catch { Write-Host "dumpbin unavailable: $($_.Exception.Message)" }

$logDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$stdoutLog = Join-Path $logDir "$name.stdout.log"
$stderrLog = Join-Path $logDir "$name.stderr.log"
$env:RUST_BACKTRACE = '1'
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$process = Start-Process -FilePath $exe -WorkingDirectory (Get-Location).Path -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
$watch.Stop()
$code = $process.ExitCode
Write-Host ("{0}: exit={1} (0x{2:X8}) elapsed={3}ms" -f $name, $code, $code, $watch.ElapsedMilliseconds)
foreach ($log in @($stdoutLog, $stderrLog)) {
  if (Test-Path $log) {
    $text = Get-Content -Raw $log
    if ($text) { Write-Host "--- $([System.IO.Path]::GetFileName($log)) ---"; Write-Host $text.TrimEnd() }
  }
}
exit $code
