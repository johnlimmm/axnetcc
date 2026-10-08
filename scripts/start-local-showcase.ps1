$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $projectPath '.local-monitor'
New-Item -ItemType Directory -Force -Path $statePath | Out-Null
$env:EXECUTION_LOG_ENABLED = 'true'
$env:EDGE_AGENT_MODE = 'local'
$env:LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434'
$env:LOCAL_LLM_MODEL = 'qwen2.5:3b'
foreach ($agent in @('TECH','DATA','SECURITY','LEGAL','POLICY','FINANCE','PROCUREMENT','OPERATIONS','SYNTHESIS')) {
    [Environment]::SetEnvironmentVariable("LOCAL_LLM_${agent}_BASE_URL", 'http://127.0.0.1:11434', 'Process')
    [Environment]::SetEnvironmentVariable("LOCAL_LLM_${agent}_MODEL", 'qwen2.5:3b', 'Process')
}
$nodePath = (Get-Command node).Source
foreach ($service in @(@{Name='showcase-web';Port=3100;Args=@('--env-file=.env.local','node_modules/vinext/dist/cli.js','start','--port','3100','--hostname','127.0.0.1')},
                       @{Name='showcase-monitor';Port=3200;Args=@('--experimental-strip-types','monitor/server.mjs')})) {
    if (Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue) {
        Write-Output "$($service.Name): port $($service.Port) already listening; retained"
        continue
    }
    $process = Start-Process -FilePath $nodePath -ArgumentList $service.Args -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $statePath "$($service.Name).out.log") -RedirectStandardError (Join-Path $statePath "$($service.Name).err.log") -PassThru
    @{Pid=$process.Id;Project=$projectPath;Port=$service.Port;StartedAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $statePath "$($service.Name)-process.json") -Encoding UTF8
    Write-Output "$($service.Name): PID=$($process.Id) port=$($service.Port)"
}
