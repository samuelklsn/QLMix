<#
  QLMix Web – Installation als Autostart-Dienst unter Windows 10/11

  * installiert Node.js (falls nötig, über winget)
  * baut die Web-Oberfläche
  * speichert die IP-Adresse des Pults
  * richtet eine geplante Aufgabe "QLMix" ein, die beim Systemstart läuft –
    auch ohne Anmeldung, unsichtbar, mit automatischem Neustart nach Fehlern
  * öffnet Port 8080 in der Windows-Firewall (nur für das lokale Netzwerk)

  Start: Rechtsklick auf install.cmd -> "Als Administrator ausführen"
  oder:  powershell -ExecutionPolicy Bypass -File install.ps1 [-ConsoleIp 192.168.1.245] [-Port 8080] [-Pin 1234]
#>
param(
  [string]$ConsoleIp = "",
  [int]$Port = 8080,
  [int]$HttpsPort = 8443,
  [string]$Pin = ""
)

$ErrorActionPreference = "Stop"
$TaskName = "QLMix"
$RuleName = "QLMix Web"

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }

# ---------------------------------------------------------------- Administrator?
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Starte mit Administratorrechten neu ..."
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Port", "$Port")
  if ($ConsoleIp) { $argList += @("-ConsoleIp", $ConsoleIp) }
  if ($Pin) { $argList += @("-Pin", $Pin) }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
  exit
}

$Web = Split-Path -Parent $PSScriptRoot
Set-Location $Web
Write-Host "QLMix-Ordner: $Web"

# ---------------------------------------------------------------- Node.js
Write-Step "Prüfe Node.js"
function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Host "Node.js fehlt - installiere es über winget ..."
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $node = Find-Node
}
if (-not $node) { throw "Node.js wurde nicht gefunden. Bitte von https://nodejs.org (LTS) installieren und das Skript erneut starten." }

$version = (& $node --version).Trim().TrimStart("v")
$parts = $version.Split(".")
if ([int]$parts[0] -lt 23 -or ([int]$parts[0] -eq 23 -and [int]$parts[1] -lt 6)) {
  throw "Node.js $version ist zu alt (mindestens 23.6, empfohlen aktuelle LTS). Bitte aktualisieren: winget upgrade OpenJS.NodeJS.LTS"
}
Write-Host "Node.js ${version}: $node"
$npm = Join-Path (Split-Path $node) "npm.cmd"
if (-not (Test-Path $npm)) { $npm = "npm.cmd" }

# ---------------------------------------------------------------- Bauen
Write-Step "Installiere Abhängigkeiten und baue die Web-Oberfläche"
& $npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install fehlgeschlagen" }
& $npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build fehlgeschlagen" }

# ---------------------------------------------------------------- Konfiguration
Write-Step "Konfiguration"
$configFile = Join-Path $Web "config.json"
$config = [ordered]@{ consoleHost = "192.168.0.128"; consolePort = 49280; httpPort = $Port; httpsPort = $HttpsPort; pin = ""; autoConnect = $true }
if (Test-Path $configFile) {
  $existing = Get-Content $configFile -Raw | ConvertFrom-Json
  foreach ($p in $existing.PSObject.Properties) { $config[$p.Name] = $p.Value }
}
if (-not $ConsoleIp) {
  $answer = Read-Host "IP-Adresse des Pults (am QL unter SETUP -> NETWORK) [$($config.consoleHost)]"
  if ($answer) { $ConsoleIp = $answer.Trim() } else { $ConsoleIp = $config.consoleHost }
}
$config.consoleHost = $ConsoleIp
$config.httpPort = $Port
$config.httpsPort = $HttpsPort
if ($Pin) { $config.pin = $Pin }
$json = $config | ConvertTo-Json
[IO.File]::WriteAllText($configFile, $json + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Host "Pult: $($config.consoleHost):$($config.consolePort) - Web-Port: $Port"

# ---------------------------------------------------------------- Startskript
$runner = Join-Path $PSScriptRoot "run-server.cmd"
$runnerText = "@echo off`r`ncd /d `"$Web`"`r`n`"$node`" server\main.ts > `"$Web\qlmix.log`" 2>&1`r`n"
$oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)  # cmd.exe liest .cmd in der OEM-Codepage
[IO.File]::WriteAllText($runner, $runnerText, $oem)

# ---------------------------------------------------------------- Geplante Aufgabe
Write-Step "Richte Autostart ein (geplante Aufgabe '$TaskName')"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*server\main.ts*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$runner`"" -WorkingDirectory $Web
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT30S"   # dem Netzwerk nach dem Booten etwas Zeit geben
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings `
  -Description "QLMix Web - Fernsteuerung für Yamaha QL/CL (startet beim Systemstart)" | Out-Null

# ---------------------------------------------------------------- Firewall
Write-Step "Öffne Port $Port und $HttpsPort (HTTPS) in der Windows-Firewall (nur lokales Netzwerk)"
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort @("$Port", "$HttpsPort") -Action Allow `
  -RemoteAddress @("LocalSubnet", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16") -Profile Any | Out-Null
# Von Windows angelegte Sperr-Regeln für node.exe (z. B. nach "Abbrechen" im Firewall-Dialog) würden die Freigabe aushebeln.
$nodeBlocks = @()
foreach ($f in @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like "*node.exe" })) {
  $r = $f | Get-NetFirewallRule
  if ($r.Direction -eq "Inbound" -and $r.Action -eq "Block" -and $r.Enabled -eq "True") { $nodeBlocks += $r }
}
if ($nodeBlocks.Count -gt 0) {
  Write-Host ("Achtung: " + $nodeBlocks.Count + " Firewall-Sperrregel(n) für node.exe gefunden - diese blockieren QLMix.") -ForegroundColor Yellow
  $a = Read-Host "Sperrregeln für node.exe entfernen? (j/n)"
  if ($a -match "^[jJyY]") { $nodeBlocks | Remove-NetFirewallRule; Write-Host "Entfernt." }
}

# ---------------------------------------------------------------- Starten
Write-Step "Starte QLMix"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
$ok = $false
try { $status = Invoke-RestMethod -Uri "http://localhost:$Port/api/status" -TimeoutSec 5; $ok = $true } catch { }

Write-Host ""
if ($ok) {
  Write-Host "QLMix läuft." -ForegroundColor Green
  Write-Host "Pult-Status: $($status.status) $($status.product)"
} else {
  Write-Host "QLMix antwortet noch nicht. Details stehen in: $Web\qlmix.log" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Auf dem Handy/Tablet im selben Netzwerk öffnen:"
foreach ($c in @(Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" })) {
  Write-Host ("   http://{0}:{1}    ({2})" -f $c.IPv4Address[0].IPAddress, $Port, $c.InterfaceAlias) -ForegroundColor White
}
Write-Host ""
Write-Host "Raum-Automatik (Mikrofon am Handy) braucht die sichere Adresse:" -ForegroundColor White
foreach ($c in @(Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" })) {
  $ip = $c.IPv4Address[0].IPAddress
  Write-Host ("   https://{0}:{1}    (vorher einmalig Zertifikat laden: http://{0}:{2}/qlmix-ca.crt)" -f $ip, $HttpsPort, $Port)
}
Write-Host "Klappt es nicht: windows\diagnose.cmd ausführen."
Write-Host ""
Write-Host "QLMix startet ab jetzt automatisch mit Windows."
Write-Host "Wichtig: Energieoptionen so einstellen, dass der PC nicht in den Energiesparmodus geht."
Write-Host ""
Read-Host "Fertig - Enter zum Schließen"
