param(
  [int]$Iterations = 30,
  [int]$TimeoutMs = 15000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/_load-env.ps1" -EnvFile ".env"

function Invoke-TimedJsonGet {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][hashtable]$Headers
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-RestMethod -Method Get -Uri $Url -Headers $Headers -TimeoutSec ([Math]::Ceiling($TimeoutMs / 1000))
    $sw.Stop()
    return [pscustomobject]@{ ok = $true; ms = $sw.ElapsedMilliseconds; resp = $resp }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ ok = $false; ms = $sw.ElapsedMilliseconds; err = $_.Exception.Message }
  }
}

$base = $env:PREDICT_API_BASE_URL
if (-not $base) { throw "Missing PREDICT_API_BASE_URL" }
$apiKey = $env:PREDICT_API_KEY
if (-not $apiKey) { throw "Missing PREDICT_API_KEY" }

$headers = @{ "x-api-key" = $apiKey; "accept" = "application/json" }

Write-Host "Predict base: $base"
Write-Host "Iterations: $Iterations"

$marketsUrl = "$base/v1/markets?first=50"
$times = @()
$marketId = $null

for ($i = 1; $i -le $Iterations; $i++) {
  $r = Invoke-TimedJsonGet -Url $marketsUrl -Headers $headers
  $times += $r
  if ($r.ok -and -not $marketId) {
    try { $marketId = $r.resp.data[0].id } catch {}
  }
}

function Summarize {
  param([string]$Name, [object[]]$Results)
  $oks = $Results | Where-Object { $_.ok }
  $fails = $Results | Where-Object { -not $_.ok }
  $lat = $oks | Select-Object -ExpandProperty ms
  $p95 = if ($lat.Count -gt 0) { ($lat | Sort-Object)[[Math]::Floor(0.95 * ($lat.Count - 1))] } else { $null }
  [pscustomobject]@{
    name = $Name
    ok = $oks.Count
    fail = $fails.Count
    avg_ms = if ($lat.Count -gt 0) { [Math]::Round(($lat | Measure-Object -Average).Average, 1) } else { $null }
    p95_ms = $p95
  }
}

$summary = @()
$summary += Summarize -Name "GET /v1/markets?first=50" -Results $times

if ($marketId) {
  $targets = @(
    @{ name = "GET /v1/markets/{id}"; url = "$base/v1/markets/$marketId" },
    @{ name = "GET /v1/markets/{id}/orderbook"; url = "$base/v1/markets/$marketId/orderbook" },
    @{ name = "GET /v1/markets/{id}/last-sale"; url = "$base/v1/markets/$marketId/last-sale" }
  )

  foreach ($t in $targets) {
    $rs = @()
    for ($i = 1; $i -le $Iterations; $i++) {
      $rs += Invoke-TimedJsonGet -Url $t.url -Headers $headers
    }
    $summary += Summarize -Name $t.name -Results $rs
  }
} else {
  Write-Warning "Could not infer marketId from /v1/markets response; skipping per-market endpoints."
}

$summary | Format-Table -AutoSize

