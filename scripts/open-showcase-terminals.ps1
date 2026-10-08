param([switch]$RunRequest)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$terminal = (Get-Command wt.exe -ErrorAction Stop).Source
$python = (Get-Command python.exe -ErrorAction Stop).Source
$viewer = Join-Path $PSScriptRoot 'showcase-terminal.py'
$panels = @(
    @{ HostName='hpc'; Title='HPC | CENTRAL ORCHESTRATOR'; Color='#efbd39'; Position='0,0' },
    @{ HostName='mnckoren'; Title='MNCKOREN | PRIMARY AGENTS'; Color='#28c788'; Position='960,0' },
    @{ HostName='ai-cloud'; Title='AI-CLOUD | BACKUP AGENTS'; Color='#36a8ef'; Position='0,540' }
)
if ($RunRequest) { $panels += @{ HostName='request'; Title='PUBLIC REQUEST | LIVE EXECUTION'; Color='#ed6689'; Position='960,540' } }
foreach ($panel in $panels) {
    $arguments = @('-w','new','--pos',$panel.Position,'--size','100,27','new-tab','--title',$panel.Title,'--tabColor',$panel.Color,'--suppressApplicationTitle','-d',$project,$python,'-u',$viewer,'--host',$panel.HostName)
    & $terminal @arguments
    if ($LASTEXITCODE -ne 0) { throw "Terminal launch failed: $($panel.HostName)" }
    Start-Sleep -Milliseconds 700
}
