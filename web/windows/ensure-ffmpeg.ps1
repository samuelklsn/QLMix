<#
  QLMix – lädt ffmpeg nach web\tools\ffmpeg, falls es fehlt.
  ffmpeg liest für die Raum-Automatik den Ton der Dante Virtual Soundcard (Pfeif-Erkennung, EQ-Kerben).
  Wird von install.ps1 und update.ps1 aufgerufen. Schlägt der Download fehl, läuft QLMix trotzdem.
#>
param([Parameter(Mandatory = $true)][string]$Web)
$dir = Join-Path $Web "tools\ffmpeg"
$exe = Join-Path $dir "bin\ffmpeg.exe"
if (Test-Path $exe) { Write-Host "ffmpeg ist vorhanden."; return }
Write-Host "Lade ffmpeg für den Dante-Ton (einmalig, etwa 100 MB) ..."
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$zip = Join-Path $env:TEMP "qlmix-ffmpeg.zip"
$tmp = Join-Path $env:TEMP "qlmix-ffmpeg"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $bin = Get-ChildItem -Path $tmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
  if (-not $bin) { throw "ffmpeg.exe nicht im Archiv gefunden" }
  New-Item -ItemType Directory -Force -Path (Join-Path $dir "bin") | Out-Null
  Copy-Item $bin.FullName $exe -Force
  Write-Host "ffmpeg installiert." -ForegroundColor Green
} catch {
  $msg = $_.Exception.Message
  Write-Host "ffmpeg konnte nicht geladen werden (${msg}). QLMix läuft trotzdem, nur ohne Dante-Ton." -ForegroundColor Yellow
} finally {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
