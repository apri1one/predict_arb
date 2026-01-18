param(
  [Parameter(Mandatory = $true)][string]$ConditionId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot/_load-env.ps1" -EnvFile ".env"

$gammaBase = $env:POLYMARKET_GAMMA_API_BASE_URL
if (-not $gammaBase) { $gammaBase = "https://gamma-api.polymarket.com" }
$gammaBase = $gammaBase.TrimEnd("/")

function Try-GetJson {
  param([string]$Url)
  try {
    return Invoke-RestMethod -Method Get -Uri $Url -Headers @{ "accept" = "application/json" } -TimeoutSec 20
  } catch {
    return $null
  }
}

$candidates = @(
  "$gammaBase/markets?condition_ids=$([Uri]::EscapeDataString($ConditionId))",
  "$gammaBase/markets?condition_ids[]=$([Uri]::EscapeDataString($ConditionId))"
)

$resp = $null
foreach ($u in $candidates) {
  $resp = Try-GetJson -Url $u
  if ($resp) { break }
}

if (-not $resp) {
  throw "Failed to query Gamma /markets for conditionId=$ConditionId (tried both condition_ids and condition_ids[])."
}

if (($resp | Measure-Object).Count -eq 0) {
  Write-Warning "Gamma returned 0 markets for conditionId=$ConditionId"
  exit 0
}

$resp | ForEach-Object {
  [pscustomobject]@{
    id = $_.id
    slug = $_.slug
    question = $_.question
    conditionId = $_.conditionId
    outcomes = ($_.outcomes -join " | ")
    clob_token_ids = ($_.clob_token_ids -join ",")
  }
} | Format-Table -AutoSize

