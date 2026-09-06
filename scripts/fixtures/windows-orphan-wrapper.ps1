param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$ServerPath,
  [Parameter(Mandatory=$true)][string]$ReceiptPath
)
$ErrorActionPreference = 'Stop'

# Use .NET rather than Node's spawn({detached:false}): libuv puts that
# immediate child in an additional KILL_ON_JOB_CLOSE job, so exiting a Node
# wrapper kills the test server before Specrails can exercise orphan ownership.
# Process.Start adds no job and requests no breakaway from Specrails' outer job.
# https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L65-L91
$shellPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $NodePath
$start.Arguments = '"' + $ServerPath + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($start)
if ($null -eq $child) { throw 'Fixture server could not be created.' }
try {
  $receipt = @{ pid = $PID; shellPid = $shellPid; serverPid = $child.Id } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($ReceiptPath, $receipt, (New-Object System.Text.UTF8Encoding($false)))
} finally {
  $child.Dispose()
}
exit 0
