param(
  [string]$TokenId,
  [int]$Iterations = 50,
  [int]$TimeoutMs = 15000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/_load-env.ps1" -EnvFile ".env"

function Invoke-TimedJsonGet {
  param(
    [Parameter(Mandatory = $true)][string]$Url
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-RestMethod -Method Get -Uri $Url -Headers @{ "accept" = "application/json" } -TimeoutSec ([Math]::Ceiling($TimeoutMs / 1000))
    $sw.Stop()
    return [pscustomobject]@{ ok = $true; ms = $sw.ElapsedMilliseconds; resp = $resp }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ ok = $false; ms = $sw.ElapsedMilliseconds; err = $_.Exception.Message }
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

$clobBase = $env:POLYMARKET_CLOB_BASE_URL
if (-not $clobBase) { throw "Missing POLYMARKET_CLOB_BASE_URL" }
$clobBase = $clobBase.TrimEnd("/")

Write-Host "Polymarket CLOB base: $clobBase"
Write-Host "Iterations: $Iterations"

if (-not $TokenId) {
  Write-Warning "No -TokenId provided; skipping /book tests. Provide a YES/NO token_id from your mapped market."
} else {
  $url = "$clobBase/book?token_id=$TokenId"
  $rs = @()
  for ($i = 1; $i -le $Iterations; $i++) { $rs += Invoke-TimedJsonGet -Url $url }
  Summarize -Name "GET /book?token_id=..." -Results $rs | Format-Table -AutoSize
}

