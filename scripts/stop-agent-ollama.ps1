$ErrorActionPreference = "Stop"

$runtimeDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.local-edge"))
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $runtimeDir.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Runtime directory must stay inside the project workspace."
}
$stateFile = Join-Path $runtimeDir "processes.json"
if (-not (Test-Path -LiteralPath $stateFile)) {
  Write-Host "No managed Agent Ollama processes are recorded."
  exit 0
}

$records = @(Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json)
foreach ($record in $records) {
  $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq "ollama") {
    Stop-Process -Id $record.pid
    Write-Host "STOPPED $($record.agent) pid=$($record.pid)"
  }
}
Remove-Item -LiteralPath $stateFile
