<#
  QLMix Web – Diagnose für Windows.
  Prüft Dienst, Port, Firewall, Netzwerk und Pult-Verbindung, bietet Reparaturen an
  und speichert einen Bericht auf dem Desktop (qlmix-diagnose.txt).
  Start: diagnose.cmd doppelklicken.
#>
$ErrorActionPreference = "Continue"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  exit
}

$Web = Split-Path -Parent $PSScriptRoot
$report = New-Object System.Collections.Generic.List[string]
function Say([string]$text, [string]$color = "Gray") { Write-Host $text -ForegroundColor $color; $report.Add($text) }
function Ok([string]$text) { Say ("[OK]      " + $text) "Green" }
function Bad([string]$text) { Say ("[PROBLEM] " + $text) "Red" }
function Hint([string]$text) { Say ("          " + $text) "Yellow" }
function Info([string]$text) { Say ("          " + $text) "Gray" }
function Head([string]$text) { Say ""; Say ("== " + $text) "Cyan" }
function Ask([string]$question) { $a = Read-Host ($question + " (j/n)"); return ($a -match "^[jJyY]") }

Say ("QLMix-Diagnose " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " - Rechner " + $env:COMPUTERNAME) "White"
Say ("Windows: " + [Environment]::OSVersion.VersionString)

# ---------------------------------------------------------------- Konfiguration
Head "Konfiguration"
$port = 8080
$httpsPort = 8443
$consoleHost = ""
$configFile = Join-Path $Web "config.json"
if (Test-Path $configFile) {
  try {
    $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
    $port = [int]$cfg.httpPort
    if ($cfg.httpsPort) { $httpsPort = [int]$cfg.httpsPort }
    $consoleHost = [string]$cfg.consoleHost
    Ok ("config.json: Pult " + $consoleHost + ", Web-Port " + $port)
  } catch { Bad ("config.json ist nicht lesbar: " + $_.Exception.Message) }
} else { Bad "config.json fehlt - install.cmd erneut ausführen" }

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) { Ok ("Node.js " + (& $node.Source --version) + " (" + $node.Source + ")") } else { Bad "Node.js nicht im PATH gefunden" }
if (Test-Path (Join-Path $Web "dist\index.html")) { Ok "Web-Oberfläche ist gebaut" } else { Bad "Web-Oberfläche fehlt (dist) - install.cmd erneut ausführen" }

# ---------------------------------------------------------------- Dienst
Head "Autostart-Aufgabe und Prozess"
$task = Get-ScheduledTask -TaskName "QLMix" -ErrorAction SilentlyContinue
if ($task) {
  $ti = $task | Get-ScheduledTaskInfo
  $result = "0x{0:X}" -f $ti.LastTaskResult
  Info ("Aufgabe 'QLMix': Zustand " + $task.State + ", letzter Start " + $ti.LastRunTime + ", Ergebnis " + $result)
  if ($task.State -eq "Running") { Ok "Aufgabe läuft" } else { Bad "Aufgabe läuft nicht (Ergebnis $result)" }
} else { Bad "Geplante Aufgabe 'QLMix' fehlt - install.cmd erneut ausführen" }

$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*main.ts*" })
if ($procs.Count -gt 0) { Ok ("QLMix-Prozess läuft (PID " + (($procs | ForEach-Object { $_.ProcessId }) -join ", ") + ")") } else { Bad "Kein QLMix-Prozess (node.exe server\main.ts) aktiv" }

$listen = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listen.Count -gt 0) {
  $owner = Get-Process -Id $listen[0].OwningProcess -ErrorAction SilentlyContinue
  $ownerName = "?"
  if ($owner) { $ownerName = $owner.ProcessName }
  Info ("Port " + $port + " wird belegt von: " + $ownerName + " (" + $listen[0].LocalAddress + ")")
  if ($ownerName -eq "node") { Ok "Port $port gehört QLMix" } else { Bad "Port $port ist von einem anderen Programm belegt ($ownerName)"; Hint "Anderen Port wählen: install.cmd erneut starten oder in config.json httpPort ändern" }
} else { Bad "Niemand lauscht auf Port $port" }

$listenTls = @(Get-NetTCPConnection -LocalPort $httpsPort -State Listen -ErrorAction SilentlyContinue)
if ($listenTls.Count -gt 0) { Ok "HTTPS-Port $httpsPort ist aktiv (für die Raum-Automatik)" } else { Hint "HTTPS-Port $httpsPort ist nicht aktiv - Raum-Automatik am Handy nicht möglich (Log prüfen)" }

$localOk = $false
try {
  $r = Invoke-WebRequest -Uri ("http://localhost:" + $port + "/api/status") -UseBasicParsing -TimeoutSec 5
  $localOk = $true
  Ok ("http://localhost:" + $port + " antwortet: " + $r.Content)
} catch { Bad ("http://localhost:" + $port + " antwortet nicht: " + $_.Exception.Message) }

# ---------------------------------------------------------------- Netzwerk
Head "Netzwerk (diese Adressen auf dem Handy verwenden)"
$configs = @(Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq "Up" })
foreach ($c in $configs) {
  $ip = $c.IPv4Address[0].IPAddress
  $gw = "-"
  if ($c.IPv4DefaultGateway) { $gw = $c.IPv4DefaultGateway[0].NextHop }
  $line = ("{0,-36} {1,-16} Gateway {2}" -f $c.InterfaceAlias, $ip, $gw)
  if ($c.IPv4DefaultGateway -and $ip -notlike "169.254.*") { Ok ($line + "   ->  http://" + $ip + ":" + $port) } else { Info ($line + "   (virtueller/sekundärer Adapter - nicht verwenden)") }
}
foreach ($p in @(Get-NetConnectionProfile)) { Info ("Netzwerkprofil '" + $p.Name + "' (" + $p.InterfaceAlias + "): " + $p.NetworkCategory) }

# ---------------------------------------------------------------- Firewall
Head "Firewall"
$shieldsUp = @()
foreach ($fp in @(Get-NetFirewallProfile)) {
  Info ("Windows-Firewall " + $fp.Name + ": aktiv=" + $fp.Enabled + ", eingehend standardmäßig " + $fp.DefaultInboundAction + ", Freigaben erlaubt=" + $fp.AllowInboundRules)
  if ($fp.Enabled -eq "True" -and $fp.AllowInboundRules -eq "False") { $shieldsUp += $fp.Name }
}
if ($shieldsUp.Count -gt 0) {
  Bad ("Im Profil " + ($shieldsUp -join ", ") + " ist 'Alle eingehenden Verbindungen blockieren' aktiv - dann wirken keine Freigaben.")
}
$publicNets = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq "Public" })
if ($publicNets.Count -gt 0) { Hint ("Netzwerk ist als 'Öffentlich' eingestuft: " + (($publicNets | ForEach-Object { $_.Name }) -join ", ") + " - für ein Kirchen-/Heimnetz besser 'Privat'.") }
$rule = Get-NetFirewallRule -DisplayName "QLMix Web" -ErrorAction SilentlyContinue
$narrowRule = $false
if ($rule) {
  $pf = $rule | Get-NetFirewallPortFilter
  $af = $rule | Get-NetFirewallAddressFilter
  Ok ("Regel 'QLMix Web': aktiv=" + $rule.Enabled + ", Port " + $pf.LocalPort + ", erlaubt von " + (($af.RemoteAddress) -join ", "))
  $narrowRule = -not (@($af.RemoteAddress) -contains "192.168.0.0/16" -or @($af.RemoteAddress) -contains "192.168.0.0/255.255.0.0" -or @($af.RemoteAddress) -contains "Any")
  if ($narrowRule) { Hint "Freigabe gilt nur für das eigene Subnetz - Handys in einem anderen WLAN-Bereich werden geblockt." }
} else { Bad "Firewall-Regel 'QLMix Web' fehlt" }

$blockRules = @()
foreach ($f in @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like "*node.exe" })) {
  $r2 = $f | Get-NetFirewallRule
  if ($r2.Direction -eq "Inbound" -and $r2.Action -eq "Block" -and $r2.Enabled -eq "True") { $blockRules += $r2 }
}
if ($blockRules.Count -gt 0) {
  Bad ("Es gibt " + $blockRules.Count + " Sperr-Regel(n) für node.exe - die blockieren QLMix trotz Freigabe:")
  foreach ($b in $blockRules) { Info ("  '" + $b.DisplayName + "' Profil " + $b.Profile) }
} else { Ok "Keine Sperr-Regeln für node.exe" }

try {
  $fw = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction Stop)
  $av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop)
  foreach ($x in $fw) { Info ("Weitere Firewall installiert: " + $x.displayName) }
  foreach ($x in $av) { Info ("Virenschutz: " + $x.displayName) }
  if ($fw.Count -gt 0) { Hint "Eine zusätzliche Firewall (z. B. von Norton, Kaspersky, Avast, ESET, Bitdefender) kann Port $port blockieren - dort node.exe bzw. Port $port freigeben." }
} catch { Info "Sicherheitscenter nicht abfragbar" }

# ---------------------------------------------------------------- Pult
Head "Verbindung zum Pult"
if ($consoleHost) {
  foreach ($p in @(49280, 50000)) {
    $t = Test-NetConnection -ComputerName $consoleHost -Port $p -WarningAction SilentlyContinue
    if ($t.TcpTestSucceeded) { Ok ("Pult " + $consoleHost + " Port " + $p + " erreichbar") } else { Bad ("Pult " + $consoleHost + " Port " + $p + " NICHT erreichbar (Ping: " + $t.PingSucceeded + ")") }
  }
}

# ---------------------------------------------------------------- Log
Head "Letzte Zeilen aus qlmix.log"
$log = Join-Path $Web "qlmix.log"
if (Test-Path $log) {
  foreach ($l in @(Get-Content $log -Tail 30 -ErrorAction SilentlyContinue)) { if ($l -notmatch "[▀-▟]") { Info $l } }
} else { Bad "qlmix.log fehlt - QLMix wurde noch nie über die Aufgabe gestartet" }

# ---------------------------------------------------------------- Reparaturen
Head "Reparaturen"
$changed = $false
if ($blockRules.Count -gt 0 -and (Ask "Sperr-Regeln für node.exe entfernen")) {
  $blockRules | Remove-NetFirewallRule
  Ok "Sperr-Regeln entfernt"
  $changed = $true
}
if ($shieldsUp.Count -gt 0 -and (Ask "'Alle eingehenden Verbindungen blockieren' ausschalten (nur diese Option, Firewall bleibt an)")) {
  Set-NetFirewallProfile -Name $shieldsUp -AllowInboundRules True
  Ok "Freigaben sind wieder wirksam"
  $changed = $true
}
if ($publicNets.Count -gt 0 -and (Ask "Netzwerk als 'Privat' einstufen")) {
  $publicNets | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private }
  Ok "Netzwerk ist jetzt 'Privat'"
  $changed = $true
}
if ($rule -and $narrowRule -and (Ask "Freigabe auf alle privaten Netzbereiche (192.168.x.x, 10.x.x.x, 172.16-31.x.x) erweitern")) {
  $rule | Set-NetFirewallRule -RemoteAddress @("LocalSubnet", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
  Ok "Freigabe erweitert"
  $changed = $true
}
if (-not $rule -or ($rule -and $rule.Enabled -ne "True")) {
  if (Ask "Firewall-Freigabe für Port $port (neu) anlegen") {
    Get-NetFirewallRule -DisplayName "QLMix Web" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "QLMix Web" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow `
      -RemoteAddress @("LocalSubnet", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16") -Profile Any | Out-Null
    Ok "Freigabe angelegt"
    $changed = $true
  }
}
if ($task -and (-not $localOk) -and (Ask "QLMix neu starten")) {
  Stop-ScheduledTask -TaskName "QLMix" -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*main.ts*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName "QLMix"
  Start-Sleep -Seconds 6
  try { Invoke-WebRequest -Uri ("http://localhost:" + $port + "/api/status") -UseBasicParsing -TimeoutSec 5 | Out-Null; Ok "QLMix antwortet jetzt" } catch { Bad "QLMix antwortet weiterhin nicht - Log oben prüfen" }
}
if (-not $changed) { Info "Keine Änderungen vorgenommen." }

$file = Join-Path ([Environment]::GetFolderPath("Desktop")) "qlmix-diagnose.txt"
[IO.File]::WriteAllLines($file, $report, (New-Object Text.UTF8Encoding($true)))
Say ""
Say ("Bericht gespeichert: " + $file) "White"
Read-Host "Enter zum Schließen"
