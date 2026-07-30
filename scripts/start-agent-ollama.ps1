$ErrorActionPreference = "Stop"

$ollama = "C:\Users\lim15\AppData\Local\Programs\Ollama\ollama.exe"
$runtimeDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.local-edge"))
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $runtimeDir.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Runtime directory must stay inside the project workspace."
}
if (-not (Test-Path -LiteralPath $ollama)) {
  throw "Ollama executable was not found: $ollama"
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$agents = [ordered]@{
  tech = 11441
  data = 11442
  security = 11443
  legal = 11444
  policy = 11445
  finance = 11446
  procurement = 11447
  operations = 11448
}

$oldHost = $env:OLLAMA_HOST
$oldKeepAlive = $env:OLLAMA_KEEP_ALIVE
$oldMaxLoaded = $env:OLLAMA_MAX_LOADED_MODELS
$processes = @()
try {
  foreach ($entry in $agents.GetEnumerator()) {
    $endpoint = "http://127.0.0.1:$($entry.Value)"
    try {
      Invoke-RestMethod -Uri "$endpoint/api/version" -TimeoutSec 1 | Out-Null
      Write-Host "READY $($entry.Key) $endpoint (existing)"
      continue
    } catch {}

    $env:OLLAMA_HOST = "127.0.0.1:$($entry.Value)"
    $env:OLLAMA_KEEP_ALIVE = "15m"
    $env:OLLAMA_MAX_LOADED_MODELS = "1"
    $stdout = Join-Path $runtimeDir "$($entry.Key).out.log"
    $stderr = Join-Path $runtimeDir "$($entry.Key).err.log"
    $process = Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $processes += [pscustomobject]@{
      agent = $entry.Key
      port = $entry.Value
      pid = $process.Id
    }
  }
} finally {
  $env:OLLAMA_HOST = $oldHost
  $env:OLLAMA_KEEP_ALIVE = $oldKeepAlive
  $env:OLLAMA_MAX_LOADED_MODELS = $oldMaxLoaded
}

$processes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir "processes.json") -Encoding UTF8
Start-Sleep -Seconds 2

foreach ($entry in $agents.GetEnumerator()) {
  $endpoint = "http://127.0.0.1:$($entry.Value)"
  try {
    Invoke-RestMethod -Uri "$endpoint/api/version" -TimeoutSec 3 | Out-Null
    Write-Host "READY $($entry.Key) $endpoint"
  } catch {
    Write-Host "FAILED $($entry.Key) $endpoint"
  }
}
