param([Parameter(Mandatory=$true)][int]$ParentProcessId)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-audio-interruptions.cs')
    [RhythmDock.AudioInterruptions]::Run($ParentProcessId)
} catch {
    [Console]::Out.WriteLine('unavailable')
    exit 1
}
