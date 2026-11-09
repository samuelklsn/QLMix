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

# Firewall: Web-Port und HTTPS-Port (ab Version 1.1 für die Raum-Automatik)
$port = 8080; $httpsPort = 8443
try {
  $cfg = Get-Content (Join-Path $Web "config.json") -Raw | ConvertFrom-Json
  if ($cfg.httpPort) { $port = [int]$cfg.httpPort }
  if ($cfg.httpsPort) { $httpsPort = [int]$cfg.httpsPort }
} catch { }
Get-NetFirewallRule -DisplayName "QLMix Web" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "QLMix Web" -Direction Inbound -Protocol TCP -LocalPort @("$port", "$httpsPort") -Action Allow `
  -RemoteAddress @("LocalSubnet", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16") -Profile Any | Out-Null
Write-Host "Firewall-Freigabe für Port $port und $httpsPort aktualisiert."
Start-ScheduledTask -TaskName "QLMix"
Write-Host "QLMix wurde aktualisiert und neu gestartet." -ForegroundColor Green
Read-Host "Enter zum Schließen"
