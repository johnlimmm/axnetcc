param(
  [string]$SourceFile = (Join-Path $PSScriptRoot "..\corpus\sources.json"),
  [string]$OutputRoot = (Join-Path $PSScriptRoot "..\corpus\raw")
)

$ErrorActionPreference = "Stop"
$sources = Get-Content -LiteralPath $SourceFile -Raw -Encoding UTF8 | ConvertFrom-Json
$report = [System.Collections.Generic.List[object]]::new()

foreach ($source in $sources) {
  $destination = Join-Path $OutputRoot $source.filename
  $directory = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $status = "downloaded"
  $errorMessage = $null
  try {
    if (Test-Path -LiteralPath $destination) {
      $status = "existing"
    } else {
      Invoke-WebRequest -Uri $source.url -OutFile $destination -MaximumRedirection 10 -TimeoutSec 120
    }
    $size = (Get-Item -LiteralPath $destination).Length
    if ($size -lt 100) { throw "Downloaded file is unexpectedly small: $size bytes" }
    if ($source.format -eq "pdf") {
      $stream = [System.IO.File]::OpenRead($destination)
      try {
        $magicBytes = New-Object byte[] 4
        [void]$stream.Read($magicBytes, 0, 4)
        $magic = [System.Text.Encoding]::ASCII.GetString($magicBytes)
        if ($magic -ne "%PDF") { throw "Server response is not a valid PDF" }
      } finally {
        $stream.Dispose()
      }
    }
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  } catch {
    $status = "failed"
    $errorMessage = $_.Exception.Message
    $size = 0
    $hash = $null
  }
  $report.Add([pscustomobject]@{
    id = $source.id
    agent = $source.agent
    title = $source.title
    publisher = $source.publisher
    source_url = $source.url
    local_path = $source.filename
    format = $source.format
    status = $status
    bytes = $size
    sha256 = $hash
    collected_at = (Get-Date).ToUniversalTime().ToString("o")
    license_review = $source.license_review
    error = $errorMessage
  })
}

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$reportPath = Join-Path $OutputRoot "collection-report.json"
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8

$downloaded = ($report | Where-Object status -in @("downloaded", "existing")).Count
$failed = ($report | Where-Object status -eq "failed").Count
Write-Output "Downloaded: $downloaded"
Write-Output "Failed: $failed"
$report | Select-Object id,status,bytes,error | Format-Table -AutoSize
