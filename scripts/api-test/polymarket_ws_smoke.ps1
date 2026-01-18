param(
  [int]$TimeoutMs = 10000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/_load-env.ps1" -EnvFile ".env"

$wsUrl = $env:POLYMARKET_CLOB_WS_URL
if (-not $wsUrl) { throw "Missing POLYMARKET_CLOB_WS_URL" }

Add-Type -AssemblyName System.Net.WebSockets

$client = New-Object System.Net.WebSockets.ClientWebSocket
$client.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(10)

$ct = New-Object System.Threading.CancellationTokenSource
$ct.CancelAfter($TimeoutMs)

Write-Host "Connecting to $wsUrl ..."
$sw = [System.Diagnostics.Stopwatch]::StartNew()

try {
  $task = $client.ConnectAsync([Uri]$wsUrl, $ct.Token)
  $task.Wait()
  $sw.Stop()
  Write-Host ("Connected in {0} ms; state={1}" -f $sw.ElapsedMilliseconds, $client.State)
} catch {
  $sw.Stop()
  Write-Error ("WS connect failed after {0} ms: {1}" -f $sw.ElapsedMilliseconds, $_.Exception.Message)
  exit 1
} finally {
  if ($client.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    try {
      $client.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "smoke", [System.Threading.CancellationToken]::None).Wait()
    } catch {}
  }
  $client.Dispose()
}

