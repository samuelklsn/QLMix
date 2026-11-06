<#
  QLMix Web – Autostart und Firewall-Regel entfernen (der Ordner bleibt erhalten).
#>
$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  exit
}
Stop-ScheduledTask -TaskName "QLMix" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "QLMix" -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*server\main.ts*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetFirewallRule -DisplayName "QLMix Web" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "QLMix-Autostart und Firewall-Regel wurden entfernt." -ForegroundColor Green
Read-Host "Enter zum Schließen"
