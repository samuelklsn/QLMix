<#
  QLMix Web – Update: neuen Stand holen (git), neu bauen, Dienst neu starten.
  Start: Rechtsklick auf update.cmd -> "Als Administrator ausführen"
#>
$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  exit
}
$Web = Split-Path -Parent $PSScriptRoot
Set-Location $Web

Stop-ScheduledTask -TaskName "QLMix" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*server\main.ts*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git -and (Test-Path (Join-Path (Split-Path -Parent $Web) ".git"))) {
  Write-Host "Hole neuesten Stand ..."
  git -C (Split-Path -Parent $Web) pull --ff-only
} else {
  Write-Host "Kein git-Repository - bitte die neuen Dateien manuell in den Ordner kopieren."
}

npm.cmd install --no-audit --no-fund
npm.cmd run build
Start-ScheduledTask -TaskName "QLMix"
Write-Host "QLMix wurde aktualisiert und neu gestartet." -ForegroundColor Green
Read-Host "Enter zum Schließen"
